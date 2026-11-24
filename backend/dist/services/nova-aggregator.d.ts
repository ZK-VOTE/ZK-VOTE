/**
 * Nova IVC Off-Chain Aggregation Service for ZK-VOTE
 *
 * Coordinates collection of vote witnesses, execution of Nova IVC folding,
 * generation of compressed recursive proofs, and relaying to Soroban.
 */
import { exec } from "child_process";
declare const execAsync: typeof exec.__promisify__;
export interface VoteWitnessPayload {
    secret: string;
    salt: string;
    path_elements: string[];
    path_indices: number[];
    vote_choice: number;
    nullifier: string;
    dao_id: number;
    proposal_id: number;
}
export interface IvcState {
    step_count: number;
    root: string;
    yes_votes: number;
    no_votes: number;
    acc_nullifier_hash: string;
}
export interface RecursiveProofPayload {
    initial_state: IvcState;
    final_state: IvcState;
    num_votes: number;
    proof_bytes: string;
    timestamp: number;
}
export interface TallyProofPayload {
    nullifier_root: string;
    yes_votes: number;
    no_votes: number;
    proof_a: string;
    proof_b: string;
    proof_c: string;
}
export declare class NovaAggregatorService {
    private tempDir;
    private _exec;
    constructor(tempDir?: string);
    /** Test seam: replace the CLI runner so tests don't spawn cargo (#566). */
    _setExecForTest(fn: typeof execAsync): void;
    /**
     * Verify a recursive proof by delegating to the nova-aggregator CLI's
     * `--verify` mode, which runs `NovaAggregator::verify_proof` and prints
     * `{"verified": bool}` (exit 0 when valid, 1 when invalid) (#566).
     *
     * `POST /api/v1/nova/verify` called this method, but it did not exist, so
     * every verification request failed with a 500.
     */
    verifyProof(payload: RecursiveProofPayload): Promise<{
        verified: boolean;
    }>;
    aggregateVotes(daoId: number, proposalId: number, root: string, witnesses: VoteWitnessPayload[]): Promise<RecursiveProofPayload>;
    backupProofToS3(proofKey: string, payload: any): Promise<void>;
    generateTallyProof(doId: number, proposalId: number, root: string, witnesses: VoteWitnessPayload[]): Promise<TallyProofPayload>;
}
/** Parse the last `{"verified": bool}` JSON line printed by the CLI. */
export declare function parseVerifyOutput(stdout: string): boolean;
export declare const novaAggregatorService: NovaAggregatorService;
export {};
//# sourceMappingURL=nova-aggregator.d.ts.map