// @ts-nocheck
/**
 * Tiered emergency halt status (ZV-114 / Issue #954).
 *
 * `require_not_paused`/`pause`/`unpause` on the voting contract are a
 * single contract-wide guardian kill switch with no backend visibility at
 * all - they are called directly against the contract, never through this
 * backend. The new tiered halt (`contracts/voting/src/lib.rs`:
 * `activate_halt`/`ratify_halt`/`resume_halt`/`is_tier_halted`) is the
 * same: this service only *reads* status for display (admin.ts,
 * DAOSettings.tsx), it does not submit any halt transaction.
 *
 * Dependency-injected the same way as circuit-registry.ts (#358): no
 * stellar.js module globals, so it is unit-testable with a mock RPC
 * server (see test/di/haltStatus.test.ts).
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { LoggerPort, RpcServerPort } from "./interfaces.js";

export interface HaltStatusDeps {
  server: RpcServerPort;
  relayerKeypair: { publicKey(): string };
  callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
  votingContractId: string | undefined;
  networkPassphrase: string;
  logger: LoggerPort;
}

let deps: HaltStatusDeps | null = null;

/** Wire dependencies. Must be called once at startup before any other export here is used. */
export function initHaltStatus(d: HaltStatusDeps): void {
  deps = d;
}

function getDeps(): HaltStatusDeps {
  if (!deps) {
    throw new Error("haltStatus: initHaltStatus() must be called before use");
  }
  return deps;
}

/** Mirrors contracts/voting/src/lib.rs's HALT_TIER_* constants - must stay in sync. */
export const HALT_TIER_VOTE_SUBMISSION = 0x1;
export const HALT_TIER_TALLY_FINALIZATION = 0x2;
export const HALT_TIER_TREASURY_EXECUTION = 0x4;

export const HALT_TIERS = [
  { tier: HALT_TIER_VOTE_SUBMISSION, name: "vote_submission" },
  { tier: HALT_TIER_TALLY_FINALIZATION, name: "tally_finalization" },
  { tier: HALT_TIER_TREASURY_EXECUTION, name: "treasury_execution" },
] as const;

/**
 * Query the voting contract's `is_tier_halted(tier)`. Returns `null`
 * (rather than throwing) if the contract id isn't configured or the
 * simulation fails - same "degrade to unknown, don't crash the caller"
 * convention as circuit-registry.ts's `getVK()`.
 */
export async function isTierHalted(tier: number): Promise<boolean | null> {
  const {
    server,
    relayerKeypair,
    callWithTimeout,
    votingContractId,
    networkPassphrase,
    logger,
  } = getDeps();

  if (!votingContractId) {
    logger.error("halt_status_voting_contract_not_configured", { tier });
    return null;
  }

  const rpcServer = server as unknown as StellarSdk.rpc.Server;
  try {
    const sourceAccount = await rpcServer.getAccount(relayerKeypair.publicKey());
    const contract = new StellarSdk.Contract(votingContractId);

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100000",
      networkPassphrase,
    })
      .addOperation(
        contract.call("is_tier_halted", StellarSdk.nativeToScVal(tier, { type: "u32" })),
      )
      .setTimeout(30)
      .build();

    const result = await callWithTimeout(
      () => rpcServer.simulateTransaction(tx),
      "halt_status_is_tier_halted",
    );

    if (StellarSdk.rpc.Api.isSimulationError(result)) {
      logger.error("halt_status_sim_error", { tier, error: result.error });
      return null;
    }

    const success = result as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) return null;
    return StellarSdk.scValToNative(retval) as boolean;
  } catch (error) {
    logger.error("halt_status_failed", { tier, error: (error as Error).message });
    return null;
  }
}

/**
 * Status for every known tier. `halted: null` means "could not be
 * determined" (misconfiguration or RPC failure), distinct from `false`.
 *
 * Still needed (not done here): a parsed `get_halt_status()` exposing
 * `reason`/`activatedBy`/`ratified`/`expiresAt` - that return type is a
 * custom contract struct, and this was written and reviewed without a
 * live/simulated contract to validate the XDR parsing against, so only
 * the boolean gate each tier already checks is exposed for now. See
 * docs/ops/runbooks/panic-plus-surge.md.
 */
export async function getAllTierStatus(): Promise<
  Array<{ tier: number; name: string; halted: boolean | null }>
> {
  return Promise.all(
    HALT_TIERS.map(async ({ tier, name }) => ({
      tier,
      name,
      halted: await isTierHalted(tier),
    })),
  );
}
