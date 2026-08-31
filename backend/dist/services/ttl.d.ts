import * as StellarSdk from "@stellar/stellar-sdk";
interface SubmitCallResult {
    success: boolean;
    feeXlm?: number;
    txHash?: string;
    error?: string;
}
declare function submitCall(contractId: string, method: string, args?: StellarSdk.xdr.ScVal[]): Promise<SubmitCallResult>;
type TTLSubmitter = typeof submitCall;
/**
 * Replace only the transaction-submission boundary in test mode.
 */
export declare function setTTLSubmitterForTests(submitter: TTLSubmitter | null): void;
declare function renewAllTTLs(): Promise<void>;
export declare function startTTLRenewal(intervalMs?: number): void;
export declare function stopTTLRenewal(): void;
export { renewAllTTLs };
//# sourceMappingURL=ttl.d.ts.map