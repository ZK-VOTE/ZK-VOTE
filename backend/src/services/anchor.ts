/**
 * Anchor Service — multi-anchor SEP-6/24/31 adapter for USDC/EURC inflow/outflow.
 *
 * One `AnchorClient` interface normalizes both Circle anchors: getTransaction,
 * deposit, withdraw and send. HTTP transport, URLs, logging and the callback
 * handler are injected (`initAnchor` / `createAnchorAdapter`) so tests never
 * touch the network. The legacy exports (`sep6Deposit`, `sep6Withdraw`,
 * `sep31Send`, `anchorFor`) remain as aliases over the default adapter.
 *
 * Callbacks are idempotent end-to-end: the adapter deduplicates on event id
 * before delegating to settlement reconciliation, which in turn deduplicates
 * on (anchor, externalTxId) and applies the state machine's conflict rule.
 */
import { log } from "./logger.js";
import { config } from "../config.js";
import { canonicalizeStellarAmount } from "../utils/stellarAmount.js";
import {
  minimizeKYCResponse,
  enforceMinimizationBoundary
} from "./kycBoundary.js";
import {
  createEndpointPool,
  HttpStatusError,
  parseRetryAfterMs,
  poolOptionsFromConfig,
  type EndpointPool,
  type OperationClass,
} from "./endpoint-pool.js";

type AnchorAsset = "USDC" | "EURC";

// ── Anchor endpoint pools (#745) ─────────────────────────────────────────
//
// ANCHOR_<ASSET>_URLS lists mirrors of the SAME anchor operator (one SEP-1
// organisation). Failing over to a different operator would hand the user's
// funds to another counterparty, so that is deliberately not a fallback.
// SEP-6 GETs are retried across mirrors; SEP-31 POSTs create a transfer and
// are never retried once the anchor may have received them.

async function probeAnchor(url: string): Promise<{}> {
  const res = await fetch(new URL("/.well-known/stellar.toml", url));
  if (!res.ok) {
    throw new HttpStatusError(res.status, `Anchor SEP-1 returned HTTP ${res.status}`);
  }
  return {};
}

function createAnchorPool(asset: AnchorAsset, urls: string[]): EndpointPool<null> {
  return createEndpointPool<null>({
    dependency: `anchor_${asset.toLowerCase()}`,
    serviceName: asset === "USDC" ? "anchor_usdc" : "anchor_eurc",
    urls,
    clientFactory: () => null,
    probe: (_client, url) => probeAnchor(url),
    ledgerAware: false,
    ...poolOptionsFromConfig(config),
  });
}

export const anchorPools: Record<AnchorAsset, EndpointPool<null>> = {
  USDC: createAnchorPool("USDC", config.anchorUsdcUrls),
  EURC: createAnchorPool("EURC", config.anchorEurcUrls),
};

/** Primary anchor URL for an asset (first configured mirror). */
export function anchorFor(asset: AnchorAsset): string {
  return anchorPools[asset].urls[0];
}

export function validateInteractiveUrl(
  value: unknown,
  asset: AnchorAsset,
): string {
  if (typeof value !== "string")
    throw new Error("Anchor interactive URL is missing");
  const candidate = new URL(value);
  // Any configured mirror of the asset's anchor may host the interactive flow.
  const trustedOrigins = new Set(
    anchorPools[asset].urls.map((url) => new URL(url).origin),
  );
  if (
    candidate.protocol !== "https:" ||
    !trustedOrigins.has(candidate.origin) ||
    candidate.username ||
    candidate.password
  ) {
    throw new Error("Anchor returned an untrusted interactive URL");
  }
  return candidate.toString();
}

export function sanitizeAnchorResponse(
  payload: unknown,
  asset: AnchorAsset,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Anchor returned an invalid response");
  }
  const response = { ...(payload as Record<string, unknown>) };

  // Enforce KYC boundary: detect excess fields before processing
  enforceMinimizationBoundary(response);

  const rawInteractiveUrl =
    response.interactive_url ??
    (response.type === "interactive_customer_info_needed"
      ? response.url
      : undefined);
  if (rawInteractiveUrl !== undefined) {
    const interactiveUrl = validateInteractiveUrl(rawInteractiveUrl, asset);
    response.interactiveUrl = interactiveUrl;
    response.interactiveOrigin = new URL(interactiveUrl).origin;
    delete response.interactive_url;
    if (response.type === "interactive_customer_info_needed")
      delete response.url;
  }

  // Apply data minimization to KYC fields
  const minimized = minimizeKYCResponse(response);

  return minimized as unknown as Record<string, unknown>;
}

async function fetchAnchorJson(
  asset: AnchorAsset,
  opClass: OperationClass,
  path: string,
  init: { search?: URLSearchParams; method?: string; body?: unknown } = {},
): Promise<unknown> {
  return anchorPools[asset].execute(opClass, async (_client, { url: base }) => {
    const url = new URL(path, base);
    if (init.search) url.search = init.search.toString();
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      throw new HttpStatusError(
        res.status,
        `Anchor returned HTTP ${res.status}`,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json();
  });
}

export async function sep6Deposit(
  asset: AnchorAsset,
  account: string,
  amount: string,
) {
  const canonicalAmount = canonicalizeStellarAmount(amount);
  const payload = await fetchAnchorJson(asset, "read", "/sep6/deposit", {
    search: new URLSearchParams({ asset, account, amount: canonicalAmount }),
  });
  const response = sanitizeAnchorResponse(payload, asset);
  log("info", "anchor_deposit", {
    asset,
    account: account.slice(0, 8) + "...",
    amount: canonicalAmount,
  });
  return response;
}

export async function sep6Withdraw(
  asset: AnchorAsset,
  account: string,
  amount: string,
  dest: string,
) {
  const canonicalAmount = canonicalizeStellarAmount(amount);
  const payload = await fetchAnchorJson(asset, "read", "/sep6/withdraw", {
    search: new URLSearchParams({
      asset,
      account,
      amount: canonicalAmount,
      dest,
    }),
  });
  const response = sanitizeAnchorResponse(payload, asset);
  log("info", "anchor_withdraw", {
    asset,
    account: account.slice(0, 8) + "...",
    amount: canonicalAmount,
  });
  return response;
}

export async function sep31Send(asset: AnchorAsset, payload: any) {
  return fetchAnchorJson(asset, "submit_non_idempotent", "/sep31/transactions", {
    method: "POST",
    body: payload,
  });
}
