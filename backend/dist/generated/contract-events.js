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
/**
 * Type guard to check if an event matches a specific type
 */
export function isEventType(event, type) {
    return event.type === type;
}
/**
 * Extract all events of a specific DAO from a list
 */
export function filterEventsByDao(events, daoId) {
    return events.filter((e) => {
        const typed = e;
        return "daoId" in typed && typed.daoId === daoId;
    });
}
/**
 * Extract vote events for a proposal
 */
export function getProposalVotes(events, daoId, proposalId) {
    return events.filter((e) => e.type === "VoteEvent" &&
        e.daoId === daoId &&
        e.proposalId === proposalId);
}
//# sourceMappingURL=contract-events.js.map