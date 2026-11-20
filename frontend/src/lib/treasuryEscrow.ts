/**
 * Thin client for the EVM `TreasuryEscrow` contract (ZV-107).
 *
 * `lock()` and `refund()` move real funds, so they are sent directly from
 * the user's wallet via `window.ethereum` (same pattern as the rest of
 * BridgePanel) rather than through the backend. `release()`/`cancel()`
 * require relayer authority bound to a Soroban finality proof, so those
 * are backend-only (see `backend/src/services/treasuryEscrow.ts`); this
 * module only reads their resulting status.
 *
 * No ABI-encoding library is used elsewhere in this frontend, so calldata
 * for the two fixed-size-argument functions below is hand-encoded. The
 * selectors are the first 4 bytes of keccak256("<signature>"):
 *   lock(uint256,uint256,address)  -> 0xd35cf790
 *   refund(uint256)                -> 0x278ecde1
 */

export const LOCK_SELECTOR = "0xd35cf790";
export const REFUND_SELECTOR = "0x278ecde1";

export type EscrowLockStatus = "locked" | "released" | "cancelled" | "refunded";

export interface EscrowLockRecord {
  lockId: string;
  daoId: number;
  proposalId: number;
  depositor: string;
  recipient: string;
  amount: string;
  lockTxHash: string;
  createdAt: number;
  timeoutSeconds: number;
  status: EscrowLockStatus;
  sorobanNonce?: string;
  resolutionTxHash?: string;
}

function toUint256Word(value: bigint | number | string): string {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) throw new Error("Value must be non-negative");
  return big.toString(16).padStart(64, "0");
}

function toAddressWord(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error("Invalid EVM address");
  }
  return hex.padStart(64, "0");
}

/** Encode calldata for `lock(uint256 daoId, uint256 proposalId, address recipient)`. */
export function encodeLockCalldata(
  daoId: number,
  proposalId: number,
  recipient: string,
): string {
  return (
    LOCK_SELECTOR +
    toUint256Word(daoId) +
    toUint256Word(proposalId) +
    toAddressWord(recipient)
  );
}

/** Encode calldata for `refund(uint256 lockId)`. */
export function encodeRefundCalldata(lockId: string): string {
  return REFUND_SELECTOR + toUint256Word(lockId);
}

function etherToWei(amountEth: string): bigint {
  const [whole, frac = ""] = amountEth.trim().split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
}

/** Convert a decimal ETH amount (e.g. "0.5") into a 0x-prefixed wei hex value for eth_sendTransaction. */
export function etherToWeiHex(amountEth: string): string {
  return "0x" + etherToWei(amountEth).toString(16);
}

/** Convert a decimal ETH amount (e.g. "0.5") into a decimal wei string for the status cache. */
export function etherToWeiDecimal(amountEth: string): string {
  return etherToWei(amountEth).toString();
}

export interface EthereumRequestProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** Send a `lock()` transaction from the connected wallet. Returns the tx hash. */
export async function sendLockTransaction(
  provider: EthereumRequestProvider,
  params: {
    from: string;
    escrowAddress: string;
    daoId: number;
    proposalId: number;
    recipient: string;
    amountEth: string;
  },
): Promise<string> {
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: params.from,
        to: params.escrowAddress,
        value: etherToWeiHex(params.amountEth),
        data: encodeLockCalldata(
          params.daoId,
          params.proposalId,
          params.recipient,
        ),
      },
    ],
  });
  return txHash as string;
}

/** Send a `refund()` transaction from the connected wallet. Returns the tx hash. */
export async function sendRefundTransaction(
  provider: EthereumRequestProvider,
  params: { from: string; escrowAddress: string; lockId: string },
): Promise<string> {
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: params.from,
        to: params.escrowAddress,
        data: encodeRefundCalldata(params.lockId),
      },
    ],
  });
  return txHash as string;
}

/** Tell the backend status cache about a lock this wallet just confirmed on-chain. */
export async function reportLock(record: {
  lockId: string;
  daoId: number;
  proposalId: number;
  depositor: string;
  recipient: string;
  amount: string;
  lockTxHash: string;
}): Promise<EscrowLockRecord> {
  const response = await fetch("/bridge/escrow/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error("Failed to record lock");
  }
  return response.json();
}

/** Tell the backend status cache about a refund this wallet just confirmed on-chain. */
export async function reportRefund(
  lockId: string,
  resolutionTxHash: string,
): Promise<EscrowLockRecord> {
  const response = await fetch(`/bridge/escrow/${lockId}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolutionTxHash }),
  });
  if (!response.ok) {
    throw new Error("Failed to record refund");
  }
  return response.json();
}

export async function fetchLockStatus(
  lockId: string,
): Promise<EscrowLockRecord | null> {
  const response = await fetch(`/bridge/escrow/${lockId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Failed to fetch lock status");
  return response.json();
}

export async function fetchLocksForProposal(
  daoId: number,
  proposalId: number,
): Promise<EscrowLockRecord[]> {
  const response = await fetch(
    `/bridge/escrow/proposal/${daoId}/${proposalId}`,
  );
  if (!response.ok) throw new Error("Failed to fetch escrow locks");
  const data = await response.json();
  return (data.locks ?? []) as EscrowLockRecord[];
}

/** keccak256("Locked(uint256,uint256,uint256,address,address,uint256,uint64)") */
export const LOCKED_EVENT_TOPIC =
  "0x2d50ef40a38f8735b967e855b5d60fbd0c23b3cf20938d9d8fdc9c422fb512ef";

/**
 * Poll for the transaction receipt of a `lock()` call and extract the
 * on-chain lockId from its `Locked` event (its first indexed topic).
 */
export async function waitForLockId(
  provider: EthereumRequestProvider,
  txHash: string,
  escrowAddress: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { pollIntervalMs = 1000, timeoutMs = 60000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as { logs?: Array<{ address: string; topics: string[] }> } | null;

    const log = receipt?.logs?.find(
      (l) =>
        l.address.toLowerCase() === escrowAddress.toLowerCase() &&
        l.topics[0] === LOCKED_EVENT_TOPIC,
    );
    if (log) {
      return BigInt(log.topics[1]).toString();
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out waiting for lock confirmation");
}
