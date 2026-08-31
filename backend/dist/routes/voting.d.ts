/**
 * Voting Routes
 *
 * Handles anonymous vote submission with ZK proofs and proposal results retrieval.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
declare const router: import("express-serve-static-core").Router;
interface VoteExecutionInput {
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier: string;
    root: string;
    proof: unknown;
    scNullifier: StellarSdk.xdr.ScVal;
    scRoot: StellarSdk.xdr.ScVal;
    scProof: StellarSdk.xdr.ScVal;
}
interface VoteExecutionResult {
    sendResult: {
        status: string;
        hash?: string;
    };
    result: {
        status: string;
    };
}
type VoteExecutor = (input: VoteExecutionInput) => Promise<VoteExecutionResult>;
/**
 * Replace only the external Stellar submission boundary in test mode.
 */
export declare function setVoteExecutorForTests(executor: VoteExecutor | null): void;
export default router;
//# sourceMappingURL=voting.d.ts.map