import originPolicy from "../config/message-origin-policy.json";\n\nexport interface TrustedAnchorSession {
  url: string;
  origin: string;
  nonce: string;
}

const DEFAULT_ANCHOR_ORIGINS = [
  "https://anchor.circle.com",
  "https://anchor.eurc.circle.com",
];

export function configuredAnchorOrigins(): ReadonlySet<string> {
  const configured = String(import.meta.env.VITE_ANCHOR_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ANCHOR_ORIGINS);
}

export function parseTrustedAnchorSession(
  payload: unknown,
  allowedOrigins: ReadonlySet<string> = configuredAnchorOrigins(),
): TrustedAnchorSession | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const sessionData = record.session;
  const nonce =
    sessionData && typeof sessionData === "object"
      ? (sessionData as Record<string, unknown>).popupNonce
      : undefined;
  if (
    typeof record.interactiveUrl !== "string" ||
    typeof record.interactiveOrigin !== "string" ||
    typeof nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(nonce)
  ) {
    return null;
  }
  try {
    const url = new URL(record.interactiveUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== record.interactiveOrigin ||
      !allowedOrigins.has(url.origin)
    ) {
      return null;
    }
    return { url: url.toString(), origin: url.origin, nonce };
  } catch {
    return null;
  }
}

const ALLOWED_MESSAGE_TYPES = new Set([
  "sep24:complete",
  "sep24:error",
  "sep24:close",
]);

export function isTrustedAnchorMessage(
  event: MessageEvent,
  frameWindow: Window | null,
  session: TrustedAnchorSession,
): boolean {
  if (event.source !== frameWindow || event.origin !== session.origin)
    return false;
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data))
    return false;

  const data = event.data as Record<string, unknown>;
  if (
    data.nonce !== session.nonce ||
    typeof data.type !== "string" ||
    !ALLOWED_MESSAGE_TYPES.has(data.type)
  ) {
    return false;
  }

  const allowedKeys =
    data.type === "sep24:complete"
      ? new Set(["type", "nonce", "transactionId"])
      : data.type === "sep24:error"
        ? new Set(["type", "nonce", "code"])
        : new Set(["type", "nonce"]);
  if (Object.keys(data).some((key) => !allowedKeys.has(key))) return false;
  if (
    data.transactionId !== undefined &&
    (typeof data.transactionId !== "string" || data.transactionId.length > 128)
  ) return false;
  if (
    data.code !== undefined &&
    (typeof data.code !== "string" || data.code.length > 64)
  ) return false;
  return true;
}
