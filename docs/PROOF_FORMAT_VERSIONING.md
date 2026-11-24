# ZKV1 proof format — versioning & negotiation

Status: normative. Supersedes the ad-hoc descriptions in
`docs/zk-voting-protocol.md` for anything concerning wire-format ownership.

## 1. One format, one schema

`shared/protocol-manifest.json` is the **only** place the ZKV1 wire format,
curve ids, public-signal order, VK shape and stable error codes are declared.
`scripts/generate-bindings.mjs` renders that schema into:

| Generated file | Consumer |
|---|---|
| `frontend/src/generated/zkv1.ts` | frontend wallet/prover |
| `backend/src/generated/zkv1.ts` | relayer / indexer |
| `packages/sdk/src/generated/zkv1.ts` | public proving SDK |
| `contracts/zkvote-groth16/src/generated/protocol.rs` | Soroban verifier |

Generated files are checked in. CI regenerates them and fails on any diff, so
a hand-edited copy cannot silently diverge from the contract. `scripts/drift-guard.mjs`
compares the manifest against the circom source, the Rust contract, the
frontend constants, the signal registry doc and any checked-in VK.

## 2. Wire layout (version 1)

```
[ version (1B) | curve_id (1B) | A (64B) | B (128B) | C (64B) ]  = 258 bytes
```

- Big-endian field elements, 32 bytes each.
- `A`/`C` = `X || Y`; `B` = `X_c1 || X_c0 || Y_c1 || Y_c0` (Soroban/Ethereum
  convention; snarkjs emits `c0, c1`, so the swap happens in the adapter).
- `curve_id`: `0` = BN254, `1` = BLS12-381. Version 1 only defines the
  64/128/64-byte point layout; a real BLS12-381 proof (96/192/96) requires a
  **new format version**, not a reused `curve_id`.

## 3. Version negotiation

- A client serializes with `PROOF_FORMAT_VERSION` from its generated binding.
- A verifier reads the first byte before touching the rest of the payload and
  rejects anything it does not implement (`ProofFormatError` in TS,
  `Groth16Error::InvalidProofFormat` (33) in Rust).
- Only version 1 is supported today. There is no implicit downgrade: a client
  that cannot produce the version required by the election manifest must fail
  before submitting a vote, not after.
- VK freshness (`frontend/src/lib/zkproof.ts` `StaleVKError` / `VKMismatchError`)
  and circuit-version compatibility (`packages/sdk/src/version.ts`) are
  separate gates. They are checked in addition to — never instead of — the
  proof-format version.

## 4. Bumping the format

An incompatible layout change requires, in one commit:

1. bump `proofFormat.version` in `shared/protocol-manifest.json` (and update
   every affected length/offset);
2. run `npm run protocol:generate` and commit every generated file;
3. update the decoder in `contracts/zkvote-groth16/src/serialization.rs` to
   accept both the old and new version during the migration window, then remove
   the old arm only after the upgrade drill passes;
4. update `docs/zk-voting-protocol.md` and this document;
5. add a KAT vector to the cross-implementation test suite.

A version bump without step 2 is rejected by CI. A decoder that accepts an
unlisted version is rejected by the drift guard.

## 5. Legacy snarkjs objects

`pi_a`/`pi_b`/`pi_c` objects are **not** an interchange format. The only code
allowed to construct or consume one is `snarkjsToZkv1` / `zkv1ToSnarkjs` in
the generated binding. SDK and frontend provers convert immediately after
generation; the relayer converts only when a legacy snarkjs API must be fed.
This keeps G2 coordinate order and field-element padding identical everywhere.
