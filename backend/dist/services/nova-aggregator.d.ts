/**
 * Nova IVC Off-Chain Aggregation Service for ZK-VOTE
 *
 * Coordinates collection of vote witnesses, execution of Nova IVC folding,
 * generation of compressed recursive proofs, and relaying to Soroban.
 */
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
    aggregateVotes(daoId: number, proposalId: number, root: string, witnesses: VoteWitnessPayload[]): Promise<RecursiveProofPayload>;
    generateTallyProof(doId: number, proposalId: number, root: string, witnesses: VoteWitnessPayload[]): Promise<TallyProofPayload>;
}
export declare const novaAggregatorService: NovaAggregatorService;
//# sourceMappingURL=nova-aggregator.d.ts.map