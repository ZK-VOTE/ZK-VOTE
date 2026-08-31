/**
 * Auto-generated TypeScript types for Soroban contract events.
 * Generated from docs/EVENTS.md and contract source (contracts)
 *
 * Update by reviewing event definitions in:
 * - contracts/dao-registry/src/lib.rs
 * - contracts/membership-sbt/src/lib.rs
 * - contracts/membership-tree/src/lib.rs
 * - contracts/voting/src/lib.rs
 * - contracts/comments/src/lib.rs
 * - contracts/circuit-registry/src/lib.rs
 */
export interface ContractEvent {
    topic: string[];
    data: unknown;
    contractId: string;
    ledger: number;
    txHash: string;
}
export interface DaoCreateEvent {
    type: "DaoCreateEvent";
    daoId: number;
    admin: string;
    name: string;
}
export interface AdminXferEvent {
    type: "AdminXferEvent";
    daoId: number;
    from: string;
    to: string;
}
export interface CircuitUpgradeProposedEvent {
    type: "CircuitUpgradeProposedEvent";
    daoId: number;
    fromCircuitId: string;
    toCircuitId: string;
    deadline: number;
}
export interface CircuitUpgradeApprovedEvent {
    type: "CircuitUpgradeApprovedEvent";
    daoId: number;
    proposalId: number;
}
export interface SbtMintEvent {
    type: "SbtMintEvent";
    daoId: number;
    to: string;
}
export interface SbtRevokeEvent {
    type: "SbtRevokeEvent";
    daoId: number;
    member: string;
}
export interface SbtLeaveEvent {
    type: "SbtLeaveEvent";
    daoId: number;
    member: string;
}
export interface ContractUpgradedEvent {
    type: "ContractUpgraded";
    from: number;
    to: number;
}
export interface TreeInitEvent {
    type: "TreeInitEvent";
    daoId: number;
    depth: number;
    emptyRoot: string;
    rootIndex: number;
}
export interface CommitEvent {
    type: "CommitEvent";
    daoId: number;
    commitment: string;
    index: number;
    newRoot: string;
    rootIndex: number;
}
export interface RemovalEvent {
    type: "RemovalEvent";
    daoId: number;
    member: string;
    index: number;
    newRoot: string;
    rootIndex: number;
}
export interface RootRolledOverEvent {
    type: "RootRolledOverEvent";
    daoId: number;
    newRoot: string;
    rootIndex: number;
    height: number;
}
export interface ProposalEvent {
    type: "ProposalEvent";
    daoId: number;
    proposalId: number;
    creator: string;
    startTime: number;
    endTime: number;
    vkVersion: number;
}
export interface VoteEvent {
    type: "VoteEvent";
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier: string;
}
export interface ProposalClosedEvent {
    type: "ProposalClosedEvent";
    daoId: number;
    proposalId: number;
    votesFor: number;
    votesAgainst: number;
}
export interface ProposalArchivedEvent {
    type: "ProposalArchivedEvent";
    daoId: number;
    proposalId: number;
}
export interface VKSetEvent {
    type: "VKSetEvent";
    vkVersion: number;
    circuitType: string;
}
export interface CommentCreatedEvent {
    type: "CommentCreatedEvent";
    daoId: number;
    proposalId: number;
    commentId: number;
    isAnonymous: boolean;
}
export interface CommentEditedEvent {
    type: "CommentEditedEvent";
    daoId: number;
    proposalId: number;
    commentId: number;
}
export interface CommentDeletedEvent {
    type: "CommentDeletedEvent";
    daoId: number;
    proposalId: number;
    commentId: number;
    deletedBy: number;
}
export interface CircuitRegisteredEvent {
    type: "CircuitRegisteredEvent";
    circuitId: string;
    circuitType: string;
    registeredAt: number;
}
export interface DaoMigrationEvent {
    type: "DaoMigrationEvent";
    daoId: number;
    fromCircuitId: string;
    toCircuitId: string;
    deadline: number;
}
export interface CircuitUpgradedEvent {
    type: "CircuitUpgradedEvent";
    daoId: number;
    circuitType: string;
    toCircuitId: string;
}
export type SmartContractEvent = DaoCreateEvent | AdminXferEvent | CircuitUpgradeProposedEvent | CircuitUpgradeApprovedEvent | SbtMintEvent | SbtRevokeEvent | SbtLeaveEvent | ContractUpgradedEvent | TreeInitEvent | CommitEvent | RemovalEvent | RootRolledOverEvent | ProposalEvent | VoteEvent | ProposalClosedEvent | ProposalArchivedEvent | VKSetEvent | CommentCreatedEvent | CommentEditedEvent | CommentDeletedEvent | CircuitRegisteredEvent | DaoMigrationEvent | CircuitUpgradedEvent;
/**
 * Type guard to check if an event matches a specific type
 */
export declare function isEventType<T extends SmartContractEvent>(event: SmartContractEvent, type: T["type"]): event is Extract<SmartContractEvent, {
    type: T["type"];
}>;
/**
 * Extract all events of a specific DAO from a list
 */
export declare function filterEventsByDao(events: SmartContractEvent[], daoId: number): SmartContractEvent[];
/**
 * Extract vote events for a proposal
 */
export declare function getProposalVotes(events: SmartContractEvent[], daoId: number, proposalId: number): VoteEvent[];
//# sourceMappingURL=contract-events.d.ts.map