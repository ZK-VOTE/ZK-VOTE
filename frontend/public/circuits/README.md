# Circuit artifacts are generated, not committed

The vote circuit's proving key and verification key are **not** in this
directory, and must not be committed here.

## Why they were removed

The artifacts that used to be checked in were generated from a **5-public-signal**
version of `circuits/vote.circom`. The circuit, the contract, and the frontend
all now use **6** public signals:

```
[root, nullifier, daoId, proposalId, voteChoice, numCandidates]
```

which means a Groth16 verification key has **7** IC points. The committed key had
6. That combination is not a degraded-but-working state, it is a dead one:

- `Voting::validate_vk` rejects any key whose `ic.len() != NUM_PUBLIC_SIGNALS + 1`,
  so `set_vk` refused the committed key — a DAO deployed with it had **no usable
  voting key at all**.
- Even if it had been accepted, `zkvote_groth16::verify_groth16` returns `false`
  whenever `pub_signals.len() + 1 != vk.ic.len()`, so no proof could ever verify.

A key that cannot verify anything is worse than no key: it looks like a
configured system, and `scripts/deploy/deploy-hosted-futurenet.sh` used to warn
and carry on when it was missing.

Nothing in the Rust test suite caught this. Every voting test builds a synthetic
key from the contract's own `NUM_PUBLIC_SIGNALS` constant, so the tests and the
contract agree with each other and neither is compared to the real artifact.
`scripts/drift-guard.mjs` did compare them, but the check sat after a
`process.exit(0)` and never ran.

## Regenerating

This requires the trusted setup, which needs the powers-of-tau file and the MPC
contributions. It is not a build step.

```bash
# 1. Compile the circuit (also asserts any zkey on disk matches the r1cs)
npm run compile --prefix circuits

# 2. Trusted setup. See circuits/ceremony/README.md for the real ceremony.
#    A local/devnet setup is fine for development, never for production:
npm run setup      --prefix circuits   # groth16 setup  (needs pot14_final.ptau)
npm run contribute --prefix circuits

# 3. Export the key. compile-circuits.sh does this automatically and now
#    cross-checks nPublic against the r1cs.
bash scripts/compile-circuits.sh

# 4. Convert to the Soroban byte format the contract's `set_vk` takes.
node circuits/convert_vkey_to_soroban_be.js \
  circuits/build/verification_key.json \
  > frontend/src/lib/verification_key_soroban.json

# 5. Register on-chain.
#    `set_vk` pins the key and requires an MPC transcript attestation
#    (DataKey::VerifyOverride has no production setter; see
#    contracts/transcript-registry).
```

Steps 1 and 3 must agree on the public-signal count. `scripts/drift-guard.mjs`
enforces this, and now actually runs.

## For the comment circuit

`comment/` follows the same rules; see `circuits/comment.circom` for its public
signal list and the same regeneration steps.
