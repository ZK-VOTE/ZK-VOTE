# Merkle depth selection and batched voting

Operator and integrator guide for two features that shipped in #472 but were
not documented: per-election Merkle depth (#93) and batched vote submission
(#90).

## Merkle depth

### Why depth is per-election

Circom fixes the tree depth at compile time through `component main`, so one
circuit means one depth. Before this, every election proved against a depth-18
tree: an election with 40 voters paid for the same 18 Poseidon hashes on the
Merkle path as one with 200,000. Proving cost is dominated by that path, so a
small electorate was paying for capacity it never used.

The fix is several circuits, not a dynamic one. `Vote` lives in
`circuits/vote_template.circom`, and each supported depth is a thin wrapper
that instantiates it. Every depth is therefore the same circuit logic; only
the path length differs.

### Supported depths

| Depth | Capacity (2^depth) | Circuit |
|---|---|---|
| 10 | 1,024 | `vote_d10.circom` |
| 15 | 32,768 | `vote_d15.circom` |
| 18 | 262,144 | `vote.circom` — **the default** |
| 20 | 1,048,576 | `vote_d20.circom` |
| 25 | 33,554,432 | `vote_d25.circom` |

`MAX_MERKLE_DEPTH` in the voting contract is 32; depths above that are
rejected. A depth inside that bound but without a compiled circuit is also
rejected — deliberately, rather than falling back to the default, because a
proof built against the wrong circuit fails on-chain with nothing explaining
why.

### The `0` sentinel

`ElectionConfig.merkle_depth` stores `0` to mean *use the default circuit*, not
*depth zero*. Elections created before this feature existed have `0` and keep
verifying against the key they were created with, rather than being
reinterpreted. Anything resolving a depth to artifacts must translate `0` to 18
first; `resolveDepth()` in both the backend and frontend does this.

### Choosing a depth

Pick the shallowest depth that holds the electorate, with headroom for growth
during registration — the depth is fixed once the election declares it.
`smallestDepthFor(memberCount)` in `frontend/src/lib/circuitDepth.ts` implements
this. Reducing depth 18 → 10 removes 8 Poseidon hashes from the path;
`circuits/utils/benchmark_depths.js` measures the actual saving for your
hardware rather than estimating it.

### Setting up a non-default election

1. Compile the depth circuits: `./scripts/compile-circuits.sh` (all supported
   depths by default; `--depths=10,15` to narrow, `--no-depths` for the default
   circuit only).
2. Run a trusted setup per depth and register each key on-chain with
   `set_vk_for_depth(dao_id, merkle_depth, vk)`. A depth with no registered key
   cannot be declared.
3. Create the election with `set_election_config_with_depth(...)`, which pins
   the hash of the depth key at that moment.
4. Verify with `get_merkle_depth(dao_id, proposal_id)` — remember `0` means
   default.

Step 3's pinning is what stops a later `set_vk_for_depth` from silently
changing which proofs an in-flight election accepts: verification re-checks the
key still hashes to what was pinned, and rejects it otherwise.

### Keeping the depth set consistent

The supported depths appear in four places:

- `circuits/utils/gen_depth_circuits.js` — the generator
- `contracts/voting/src/lib.rs` — `MAX_MERKLE_DEPTH`
- `backend/src/services/circuit-artifacts.ts`
- `frontend/src/lib/circuitDepth.ts`

Drift between them is silent: proofs get built against a circuit the chain has
no key for. Rather than restate the constants, the backend and frontend tests
read the other files and assert they agree, so a mismatch fails CI. To add a
depth, edit the generator, run `npm run depths:gen`, and let the tests tell you
what else needs updating. `npm run depths:check` fails if a committed wrapper is
stale.

## Batched voting

### What `cast_votes` does

`cast_votes(dao_id, proposal_id, votes)` verifies a batch of Groth16 proofs
under a single aggregated pairing check instead of one check per vote, taking
the pairing count from `4n` to `n + 3`.

It is **all-or-nothing**. The first invalid vote panics the whole call and no
nullifier is burned, so a rejected batch leaves no partial state and can be
retried after removing the bad entry.

`MAX_VOTE_BATCH` is 64, mirroring `MAX_BATCH_SIZE` in the verifier.

### Duplicate nullifiers within a batch

A batch is rejected if it contains the same nullifier twice. This is a distinct
check from the usual spent-nullifier lookup, which only sees committed state —
without it, two copies in one batch would both be written in the same
transaction and a voter could vote twice.

### Cost

Measured against the Soroban host's CPU meter, not inferred from pairing
counts:

| Batch size | Pairing ratio | Measured CPU |
|---|---|---|
| 4 | 2.29x | ~1.9x |
| 64 | 3.82x | ~2.9x |

`4n / (n + 3)` tends to **4.00x** and never reaches it, so this construction
cannot deliver more than a 4x reduction however large the batch. Going beyond
that needs SnarkPack or inner-product aggregation, tracked in #476.

### Submitting a batch

`POST /vote/batch` with `{ daoId, proposalId, votes: [...] }`. Unlike the
single-vote endpoint there is no encrypted-payload variant: the relayer must
see every nullifier to reject a duplicate before spending a simulation on it.

A failed simulation returns `VOTE_REJECTED` without saying which vote or which
check failed. That is deliberate — naming either would identify a voter within
the batch.

### When batching is worth it

Batching helps when proofs arrive faster than blocks. For sparse voting the
per-vote path is simpler and the saving is small — at n=4 it is under 2x.
Note also that holding votes to fill a batch delays them, which is an availability
and timing consideration, not only a cost one.
