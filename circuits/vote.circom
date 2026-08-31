pragma circom 2.0.0;

include "vote_template.circom";

// Default tree depth of 18 (supports ~262K members).
//
// Depth is a compile-time parameter of the `Vote` template (#93): other depths
// are instantiated by the generated `vote_d<N>.circom` wrappers, which include
// the same template from `vote_template.circom`. Keeping the template in its
// own file is what lets one definition serve every depth — a proof for a
// depth-N election is a proof for `Vote(N)`, verified against the verification
// key registered for depth N.
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates] - 6 signals
// Commitment is computed internally from secret+salt (private)
component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates]} = Vote(18);
