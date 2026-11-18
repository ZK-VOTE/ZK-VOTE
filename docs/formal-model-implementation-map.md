# TLA+ model to contract implementation map

implementation-map.json is the reviewable bridge between ZKVote.tla and the
public Soroban entrypoints. The conformance check fails if a modeled safety
invariant is unmapped, a source file is missing, or a referenced Rust entrypoint
no longer exists.

| TLA+ invariant | Contract entrypoints checked |
|---|---|
| RootGroundedVoting | Voting proposal/vote/root methods; membership-tree root lookups |
| AdminContinuity | DAO registry admin read/transfer |
| ProposalFSM | Voting create/activate/close/archive |
| NullifierGlobalUniqueness | Voting nullifier checks and vote |
| FIFOSafety | Membership-tree root lookup/index and voting eligibility |
| MinRootCorrectness | Membership-tree minimum root/index and voting eligibility |
| AuthDelegationSoundness | Registry admin, registry-only SBT mint/tree init/registration/VK setup |

This is a structural conformance guard, not a proof that Rust is semantically
equivalent to TLA+. TLC remains the state-space checker; Rust unit/integration
tests and code review validate the actual guards and authorization behavior.
Any new TLA+ safety invariant must be added to the mapping in the same change.
The formal workflow retains the pinned TLC 1.7.4 checksum.
