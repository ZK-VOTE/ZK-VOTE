/**
 * Payments Service — XLM / USDC / EURC (real assets, no mocks)
 * High-volume: MuxedAccount + 100 ops/tx + fee-bump + idempotency
 */
import * as StellarSdk from "@stellar/stellar-sdk";
export type PaymentAsset = "XLM" | "USDC" | "EURC";
/**
 * Resolves a Stellar Asset instance for the given asset code.
 * @param code Asset code (XLM, USDC, EURC)
 * @returns Configured StellarSdk.Asset instance
 */
export declare function getAsset(code: PaymentAsset): StellarSdk.Asset;
/**
 * Creates a MuxedAccount ID (M...) for user routing from a base public key and ID.
 * @param base Base public key (G...)
 * @param id Unique multiplexing sub-account ID
 * @returns Muxed account address (M...) or base key on fallback
 */
export declare function muxedForUser(base: string, id: string): string;
export interface PaymentOp {
    destination: string;
    asset: PaymentAsset;
    amount: string;
    memo?: string;
}
export interface BatchResult {
    hash: string;
    ops: number;
}
/**
 * Submits a single payment transaction via Horizon using the relayer account.
 * @param op Payment operation specifications (destination, asset, amount, memo)
 * @returns Transaction submission hash
 */
export declare function sendPayment(op: PaymentOp): Promise<{
    hash: string;
}>;
/**
 * Parses a decimal string amount into integer stroops (1 unit = 10^7 stroops)
 * using string parsing and BigInt arithmetic to avoid floating-point precision drift.
 * @param amount String representation of decimal amount (e.g. "10.5000000")
 * @returns BigInt representation in stroops
 */
export declare function parseAmountToStroops(amount: string): bigint;
/**
 * Submits a batch of payments (up to 100 ops/tx) via Horizon with tenant-scoped idempotency.
 * @param ops Array of payment operations
 * @param tenantId Tenant identifier for scoping idempotency and outbox records
 * @returns Result containing deterministic transaction hash and operation count
 */
export declare function sendBatch(ops: PaymentOp[], tenantId?: string): Promise<BatchResult>;
/**
 * Executes a path payment to swap assets via Stellar DEX using strictSend.
 * @param sendAsset Asset to send
 * @param destAsset Destination asset to receive
 * @param sendAmount Exact amount of sendAsset to spend
 * @param destMin Minimum acceptable amount of destAsset to receive (slippage limit)
 * @param destination Recipient public address
 * @returns Transaction hash of the swap
 */
export declare function swapStrictSend(sendAsset: PaymentAsset, destAsset: PaymentAsset, sendAmount: string, destMin: string, destination: string): Promise<{
    hash: string;
}>;
/**
 * Queries simulated strictSend payment paths from Horizon to obtain a price quote.
 * @param sendAsset Asset to send
 * @param sendAmount Amount to send
 * @param destAsset Asset to receive
 * @returns Estimated destination amount and payment routing path
 */
export declare function quoteStrictSend(sendAsset: PaymentAsset, sendAmount: string, destAsset: PaymentAsset): Promise<{
    destAmount: string;
    path: any[];
}>;
//# sourceMappingURL=payments.d.ts.map