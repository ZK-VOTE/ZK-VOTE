/**
 * Threshold Decryption Coordinator
 *
 * Manages the off-chain coordination protocol for threshold decryption:
 * - DKG ceremony lifecycle
 * - Encrypted vote submission
 * - Decryption share collection
 * - Tally decryption and verification
 *
 * This service interacts with the ThresholdCrypto Soroban contract
 * for on-chain state management and the off-chain crypto primitives
 * for actual cryptographic operations.
 */
import * as tc from "./threshold-crypto.js";
export interface AuthorityInfo {
    index: number;
    address: string;
    name: string;
    verifierId: string;
    publicKeyShare: string;
    dkgCommitment: string;
    vssCommitments: string[];
}
export interface DkgRound {
    electionId: string;
    thresholdN: number;
    thresholdT: number;
    authorities: AuthorityInfo[];
    jointPublicKey: string;
    phase: "registration" | "commitment" | "completed";
}
export interface EncryptedVote {
    voterNullifier: string;
    ciphertext: tc.Ciphertext;
    voteProof?: string;
}
export interface RelayNode {
    id: string;
    address: string;
    publicKey: string;
    weight: number;
    healthy: boolean;
}
export interface RelaySubmission {
    electionId: string;
    encryptedVote: EncryptedVote;
    receivedAt: number;
    viaRelay: string[];
}
export interface CoverTrafficConfig {
    enabled: boolean;
    minIntervalMs: number;
    maxIntervalMs: number;
    paddingVotesPerInterval: number;
}
export interface MissingVoteAlert {
    electionId: string;
    nullifier: string;
    detectedAt: number;
    reason: string;
}
export type ProtocolEvent = {
    type: "authority_registered";
    authority: string;
} | {
    type: "dkg_commitment";
    authority: string;
    commitment: string;
} | {
    type: "joint_key_set";
    key: string;
} | {
    type: "vote_encrypted";
    count: number;
} | {
    type: "decryption_share";
    authority: string;
} | {
    type: "tally_decrypted";
    tally: string;
} | {
    type: "relay_registered";
    relay: string;
} | {
    type: "relay_quorum_reached";
    relayPath: string[];
} | {
    type: "cover_traffic_sent";
    count: number;
} | {
    type: "missing_vote_detected";
    nullifier: string;
};
type EventHandler = (event: ProtocolEvent) => void;
export declare function onEvent(handler: EventHandler): void;
export declare function registerRelayNode(daoId: number, proposalId: number, node: Omit<RelayNode, "healthy">): Promise<void>;
export declare function submitVoteViaRelayQuorum(daoId: number, proposalId: number, encryptedVote: EncryptedVote, relayPath: string[]): Promise<void>;
export declare function startCoverTrafficScheduler(daoId: number, proposalId: number, config: CoverTrafficConfig): void;
export declare function stopCoverTrafficScheduler(): void;
export declare function monitorMissingVotes(daoId: number, proposalId: number, expectedNullifiers: string[]): Promise<MissingVoteAlert[]>;
/**
 * Initialize a DKG ceremony for a new election.
 */
export declare function initializeDKG(daoId: number, proposalId: number, thresholdN: number, thresholdT: number, creatorAddress: string): Promise<DkgRound>;
/**
 * Register an authority and generate their DKG contribution.
 * Returns the shares to distribute to other authorities.
 */
export declare function registerAuthority(daoId: number, proposalId: number, authorityAddress: string, authorityName: string, verifierId: string): Promise<{
    shares: Array<{
        toIndex: number;
        value: bigint;
    }>;
    commitments: string[];
}>;
/**
 * Finalize DKG: compute the joint public key from all authorities' commitments.
 */
export declare function finalizeDKG(daoId: number, proposalId: number): Promise<{
    jointPublicKey: string;
    authorities: AuthorityInfo[];
}>;
/**
 * Encrypt a vote using the joint public key.
 */
export declare function encryptAndSubmitVote(daoId: number, proposalId: number, voteChoice: number, voterNullifier: string, relayPath?: string[]): Promise<tc.Ciphertext>;
/**
 * Compute the encrypted tally from all encrypted votes.
 */
export declare function computeEncryptedTally(daoId: number, proposalId: number): Promise<tc.Ciphertext>;
/**
 * Generate a decryption share for an authority.
 */
export declare function generateAuthorityDecryptionShare(daoId: number, proposalId: number, authorityAddress: string, privateKeyShare: bigint, encryptedTally: tc.Ciphertext): Promise<string>;
/**
 * Combine decryption shares and compute the final tally.
 */
export declare function computeFinalTally(daoId: number, proposalId: number, encryptedTally: tc.Ciphertext): Promise<{
    tally: bigint;
    proof: string;
    combinedShare: string;
}>;
export declare function getProtocolState(daoId: number, proposalId: number): {
    dkgRound: DkgRound | undefined;
    encryptedVoteCount: number;
    decryptionShareCount: number;
    isTallyDecrypted: boolean;
    decryptedTally: string | null;
};
export {};
//# sourceMappingURL=threshold-coordinator.d.ts.map