/**
 * Bridge Relay Service
 *
 * Watches EVM bridge contract for VoteForwarded events and
 * relays votes to the Soroban bridge contract.
 */
export interface EVMVoteEvent {
    daoId: number;
    proposalId: number;
    nullifier: string;
    voteChoice: number;
    voteRoot: string;
    txHash: string;
    blockNumber: number;
}
export interface RelayResult {
    success: boolean;
    stellarTxHash?: string;
    error?: string;
}
/**
 * Poll EVM bridge contract for VoteForwarded events
 * In production, use WebSocket or event subscription
 * For now, poll via RPC
 */
export declare function pollEVMEvents(): Promise<EVMVoteEvent[]>;
/**
 * Relay a single vote from EVM to Soroban
 */
export declare function relayVote(event: EVMVoteEvent): Promise<RelayResult>;
/**
 * Start the relay service
 */
export declare function startRelay(intervalMs?: number): void;
/**
 * Stop the relay service
 */
export declare function stopRelay(): void;
//# sourceMappingURL=bridge.d.ts.map