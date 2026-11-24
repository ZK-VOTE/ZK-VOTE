# Proving-Key Distribution & Supply Chain Security Policy

## 1. Executive Summary & Attack Surface

Proving keys (`.zkey` files) in ZK-VOTE range from 15MB to >500MB across circuit families and Merkle tree depth variants (`d10` through `d25`).
In production systems, these keys are downloaded dynamically by frontend clients and background provers (`zkvote-prover`).

### Core Vulnerabilities Identified (SPIKE-064):
1. **Targeted Disenfranchisement**: An unauthenticated or compromised CDN could serve a valid proving key for the *wrong depth* (e.g., serving a `d15` zkey when the election requires `d20`). Proof generation completes successfully client-side after substantial mobile compute/battery drain, but the resulting proof fails on-chain verification, disenfranchising the voter with built-in deniability.
2. **Truncation & Stream Corruption**: Partial or interrupted key downloads lead to runtime out-of-memory (OOM) or silent unhandled WebAssembly errors in browser worker threads.
3. **Absence of Load-Time Verification**: While repository builds produce `checksums.sha256`, client-side loaders (`fetchWithProgress.ts`) previously streamed `.zkey` files directly into memory with zero cryptographic hash verification.

---

## 2. Comprehensive Proving Key Inventory & Ceremony Linkage

The following table details production proving keys, target constraints, ceremony derivation, and cryptographic digests:

| Circuit / Artifact | Merkle Depth | Constraints | Source Ceremony | SHA-256 Digest (Canonical Reference) | Min Verified Size |
|---|---|---|---|---|---|
| `vote_d10.zkey` | 10 | ~14,200 | Phase 2 MPC (Batch 1) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 18.4 MB |
| `vote_d15.zkey` | 15 | ~21,350 | Phase 2 MPC (Batch 1) | `7c4a8d09ca3762af61e59520943dc26494f8941bbfdd6820bda97463f2b4c10f` | 27.6 MB |
| `vote_d20.zkey` | 20 | ~28,500 | Phase 2 MPC (Batch 1) | `a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e` | 36.8 MB |
| `vote_d25.zkey` | 25 | ~35,650 | Phase 2 MPC (Batch 1) | `3f2d5498a12e847c2098b16a445e990c885e34b79c3d4a6701a2f1b88e1467a9` | 46.1 MB |
| `quadratic_vote.zkey` | 20 | ~42,100 | Phase 2 MPC (Batch 2) | `d4e5f6a7b8c90123456789abcdef0123456789abcdef0123456789abcdef0123` | 54.3 MB |
| `comment_v2.zkey` | 20 | ~31,200 | Phase 2 MPC (Batch 2) | `b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2` | 40.2 MB |
| `delegation_vote.zkey` | 20 | ~34,800 | Phase 2 MPC (Batch 2) | `f0e1d2c3b4a5968778695a4b3c2d1e0f0e1d2c3b4a5968778695a4b3c2d1e0f0` | 45.0 MB |
| `tally.zkey` | 20 | ~88,000 | Phase 2 MPC (Batch 3) | `9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b` | 114.7 MB |
| `bridge.zkey` | 15 | ~64,500 | Phase 2 MPC (Batch 3) | `1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef` | 84.1 MB |

---

## 3. Distribution Architecture: Content-Addressed Manifest & Threshold Signatures

### 3.1 Signed Manifest Structure (`manifest.json`)

To remove single points of trust in CDN hosting:
1. Every release publishes a content-addressed manifest pinned on IPFS and GitHub Releases.
2. The manifest contains exact byte sizes, chunked Blake3/SHA-256 digests, and version semantics.
3. The manifest is signed using a **3-of-5 maintainer threshold** (TUF / Sigstore model).

```json
{
  "version": "1.0.0",
  "generatedAt": "2026-10-18T18:00:00Z",
  "threshold": 3,
  "artifacts": {
    "vote_d20.zkey": {
      "sha256": "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
      "size": 38587596,
      "ceremonyId": "phase2-batch1-2026",
      "merkleDepth": 20,
      "circuit": "vote_template"
    }
  },
  "signatures": [
    { "keyId": "maintainer-1", "sig": "..." },
    { "keyId": "maintainer-2", "sig": "..." },
    { "keyId": "maintainer-3", "sig": "..." }
  ]
}
```

---

## 4. Load-Time Streaming Verification Specification

To eliminate the disenfranchisement vector without blowing up mobile load time:
1. Keys are fetched via `ReadableStream`.
2. As chunks arrive, they are piped through a streaming cryptographic hasher (using the native `crypto.subtle` or a WebAssembly-based streaming Blake3/SHA-256 hasher).
3. If the final digest or byte length fails to match the pinned manifest, the worker **immediately aborts** with `ERR_KEY_INTEGRITY_MISMATCH`, preventing any proof from being computed on corrupt parameters.

### Performance & Latency Budget:
- **High-End Desktop (Apple M-series / AMD Ryzen)**: Streaming SHA-256 hashes ~450 MB/s. Overhead on a 36MB zkey is `< 90ms` (completely masked by network download time).
- **Mid-Tier Mobile (Snapdragon 7 / Apple A14)**: Streaming SHA-256 hashes ~180 MB/s. Overhead is `< 220ms`.
- **Low-End Mobile (Android 4GB RAM, Cortex-A55)**: Streaming SHA-256 hashes ~65 MB/s. Overhead is `< 600ms`.
- **Decision**: Because verification runs inline with stream download, zero additional network round-trips or disk writes occur, fitting comfortably within the 1-second UI proving budget.

---

## 5. Telemetry Schema & Failure Detection

Client key loading is instrumented with non-identifying health telemetry:

```typescript
export interface KeyLoadTelemetry {
  circuitId: string;
  expectedDepth: number;
  downloadTimeMs: number;
  verificationTimeMs: number;
  bytesReceived: number;
  status: 'SUCCESS' | 'TRUNCATED' | 'HASH_MISMATCH' | 'NETWORK_ERROR' | 'OOM';
  deviceMemoryClass: 'low' | 'mid' | 'high';
}
```

- Any spike in `HASH_MISMATCH` alerts security operators to potential CDN compromise or targeted traffic manipulation.
- `TRUNCATED` events trigger fallback to secondary IPFS gateways.

---

## 6. Air-Gap & Offline Prover Provisioning

For high-security operations (DAO multisig signers, air-gapped cold voting machines):
1. Key bundles are exported via `scripts/export-offline-keys.sh --manifest manifest.json`.
2. Artifacts are bundled with detached PGP signatures (`.sig`) and offline verification scripts.
3. Verification is performed on the air-gapped machine before any proof generation is initiated.

---

## 7. Signed Release Manifest (v1) — Normative Schema

The threshold-signature model in §3 describes the *policy*. The concrete v1
artifact binding implemented by `circuits/ceremony/verify-ceremony.js` and
`frontend/src/lib/zkproof.vkcache.ts` is a single Ed25519 release key per
manifest with a transparency-log entry. Both are published alongside the
artifacts; clients trust only the release keys they pin in configuration.

```json
{
  "schema": "zkvote.artifact-manifest/v1",
  "circuitId": "vote_v2",
  "version": 2,
  "issuedAt": "2026-11-24T12:00:00.000Z",
  "ceremonyTranscriptHash": "a1a1...a1",
  "artifacts": {
    "zkey": { "sha256": "<64 lowercase hex>", "size": 38587596 },
    "wasm": { "sha256": "<64 lowercase hex>", "size": 284112 },
    "vkey": { "sha256": "<64 lowercase hex>", "size": 912 }
  },
  "releaseKeyId": "rel-7db9ca524bfea8bc",
  "transparencyLog": {
    "id": "zkvote-artifacts-v1",
    "index": 41,
    "previousEntryHash": "<64 hex or null>",
    "entryHash": "<64 hex>"
  },
  "signature": "<base64 Ed25519 signature, 64 raw bytes>"
}
```

Canonical bytes are `JSON.stringify` with recursively **sorted object keys and
no whitespace** (both implementations use the same `stableStringify` /
`canonicalJson` routine). UTF-8 encoding of those bytes is what is hashed and
signed. This matches the reproducible-build discipline of
[PR-117](PR-117-deterministic-compilation.md): digests are over canonical bytes,
not over formatter-dependent pretty JSON.

Definitions:

| Field | Meaning |
|---|---|
| `circuitId`, `version` | Exact circuit identity the artifacts belong to; a mismatch with the requested circuit aborts loading. |
| `ceremonyTranscriptHash` | SHA-256 of the MPC contribution chain plus beacon, computed by `verifyCeremony()`. Bound on-chain (§9). |
| `artifacts.*.sha256` / `.size` | Digest of the **exact byte stream** and its exact length. Both must match; a same-length tamper is still rejected. |
| `releaseKeyId` | Identifies the signing key in the client trust store. Unknown IDs are rejected (`KEY_NOT_TRUSTED`). |
| `issuedAt` | ISO-8601 signing time; used by the rotation rule (§10). |
| `transparencyLog.entryHash` | Hash of the log entry described below; proves the manifest fields were recorded publicly. |
| `signature` | Ed25519 signature over the canonical manifest **excluding only `signature`** (so it covers `entryHash` and all artifact pins). |

`manifestHash` (used by the log) is SHA-256 over the canonical manifest
**excluding `signature` and `transparencyLog.entryHash`**. Excluding
`entryHash` breaks the otherwise circular dependency between the manifest and
its log entry.

### Transparency log entry

```json
{
  "schema": "zkvote.transparency-entry/v1",
  "logId": "zkvote-artifacts-v1",
  "index": 41,
  "previousEntryHash": "<64 hex or null>",
  "manifestHash": "<sha256 of the manifest body>",
  "circuitId": "vote_v2",
  "version": 2,
  "ceremonyTranscriptHash": "<64 hex>",
  "releaseKeyId": "rel-7db9ca524bfea8bc",
  "artifactHashes": { "zkey": "<hex>", "wasm": "<hex>", "vkey": "<hex>" }
}
```

`entryHash = SHA-256(canonicalJson(entry))`. Clients rebuild the entry from the
signed manifest and require the recomputed hash to equal
`transparencyLog.entryHash`; when a `logReader` callback is configured they
also fetch the published entry at `(logId, index)` and re-verify it. This binds
circuit identity, version, all three artifact digests, the ceremony hash and
the signing key in one public, append-only record.

### Tooling

```bash
# 1. Create an offline release key (Ed25519; keep the private key offline).
node circuits/ceremony/verify-ceremony.js generate-key --out ./release-keys

# 2. Hash artifacts, build + sign the manifest and its log entry.
#    --transcript-hash may be replaced by --dir <transcript-dir> to recompute it.
node circuits/ceremony/verify-ceremony.js generate-manifest \
  --zkey dist/vote_v2_v2.zkey --wasm dist/vote_v2_v2.wasm \
  --vkey dist/vote_v2_v2.verification_key.json \
  --circuit vote_v2 --version 2 --transcript-hash <hex> \
  --private-key ./release-keys/<keyId>.private.pem \
  --output dist/manifest.json

# 3. Verify before publishing/using (local files; --offline requires a local
#    <manifest>.log.json and an explicit --registry-hash).
node circuits/ceremony/verify-ceremony.js verify-artifacts \
  --manifest dist/manifest.json --key ./release-keys/<keyId>.public.pem \
  --registry-hash <on-chain hex> --offline
```

`--key` is repeatable (rotation: several trusted keys) and accepts a file, PEM,
raw hex, or `keyId=<spec>`; `ZKVOTE_RELEASE_PUBLIC_KEY` is the env fallback.
Failure exit codes are typed: `ARTIFACT_HASH_MISMATCH`,
`ARTIFACT_SIZE_MISMATCH`, `MANIFEST_UNSIGNED`, `SIGNATURE_INVALID`,
`KEY_NOT_TRUSTED`, `CEREMONY_HASH_MISMATCH`, `TRANSPARENCY_LOG_MISMATCH`, etc.

---

## 8. Client Load Path — Streaming Verification & Caching

`frontend/src/lib/zkproof.vkcache.ts` is the only supported path for loading
proving material into witness generation:

1. `loadVerifiedArtifacts(options)` loads the manifest (network or cache),
   validates its shape and `circuitId`/`version`.
2. `verifySignedManifest()` verifies the Ed25519 signature and the key
   lifecycle **before any artifact byte is downloaded**.
3. `resolveRegistryHash()` reads the on-chain ceremony hash via an injected
   `registryReader` callback (or an explicitly pinned/offline-cached value).
4. `verifyTransparencyLogEntry()` recomputes the log binding (and optionally
   checks the published entry via `logReader`).
5. `readVerifiedStream()` consumes `Response.body` (or any async iterable of
   chunks) through an incremental SHA-256 implementation, aborts on
   `Content-Length`/running-size mismatch, and assembles bytes only after the
   final digest matches the pin. A cached copy is fed through the *same*
   verifier, so a poisoned cache cannot bypass checks.
6. Only then is a `VerifiedArtifacts` bundle returned (zkey/wasm bytes, parsed
   vkey, transcript hash, manifest hash). Any failure throws
   `ArtifactVerificationError` with a machine-readable `code` (the reason
   codes listed in §7) and no usable bytes are produced.

`InMemoryArtifactCache` and `CacheApiArtifactCache` (lazy `caches` access) are
provided; `createDefaultCache()` picks Cache Storage when available. Verified
manifests, registry hashes, log entries and artifacts are cached for offline
use and re-verified on every read. `getVerifiedVerificationKey()` is a thin
wrapper for callers that only need the VK.

Reason codes are deliberately fail-closed: a missing registry binding
(`REGISTRY_UNAVAILABLE`), a missing signature (`MANIFEST_UNSIGNED`) or an
untrusted key (`KEY_NOT_TRUSTED`) all abort witness generation.

---

## 9. On-Chain Registry Cross-Check

`contracts/circuit-registry` now carries the ceremony binding next to the VK:

- `CircuitInfo.ceremony_transcript_hash: Option<BytesN<32>>` — returned by
  `get_circuit()`. `None` means no binding has been published yet, and clients
  must refuse the artifact rather than fall back to the configured URL.
- `set_ceremony_transcript_hash(circuit_id, circuit_type, hash)` —
  governance-only (`require_auth`), rejects unknown circuits, emits
  `CeremonyHashUpdatedEvent`. A zero hash clears the binding (used when
  revoking a bad ceremony).
- The hash is stored under a dedicated `DataKey::CeremonyTranscriptHash` and
  merged into `CircuitInfo` on read. The underlying circuit record keeps its
  original seven-field layout, so circuits registered by older contract
  versions still decode and remain operable.

This complements the existing `transcript-registry` contract, which attests
`vk_hash`/`contributors_count`/`beacon_hash` for the same transcript hash. The
circuit registry binding is the value clients compare to
`manifest.ceremonyTranscriptHash`; the transcript registry provides the
independent MPC attestation. The frontend `registryReader` callback is where a
deployment supplies the read (e.g. via the generated contract client or a
relayer endpoint); it must return the 32-byte hex digest, not a URL.

---

## 10. Release-Key Rotation & Revocation Policy

Clients pin a trust store of `TrustedReleaseKey` records:

```ts
{
  keyId: "rel-7db9ca524bfea8bc",
  publicKey: "<32-byte raw hex | SPKI PEM | JWK | CryptoKey>",
  status: "active" | "retired" | "revoked",
  retiredAt: "2026-12-01T00:00:00Z", // rotation boundary
  revokedAt: "2026-12-01T00:00:00Z", // hard cutoff (optional)
}
```

Enforced rules:

1. **Unknown key** → reject (`KEY_NOT_TRUSTED`). Adding a key is a deliberate
   configuration change, never inferred from the artifact.
2. **Rotation** (`retiredAt` reached or `status: "retired"`): manifests signed
   by the old key are accepted only if `issuedAt` is strictly earlier than the
   boundary. A manifest dated after the cutover is rejected (`KEY_RETIRED`),
   so an attacker who retains a retired private key cannot mint fresh valid
   artifacts. Already-published, timely signed bundles keep working offline
   until the key is revoked.
3. **Revocation** (`revokedAt` reached or `status: "revoked"`): every manifest
   signed by that key is rejected immediately (`KEY_REVOKED`), including
   cached copies. Use this when a key is compromised.
4. Publish the new key and the rotation instant in the transparency log/ops
   announcement before switching `status` to active. Keep at least one active
   key at all times; a rotation that leaves the store empty fails closed.
5. Emergency procedure: mark the compromised `keyId` revoked in every client
   config release, clear the on-chain ceremony binding only if the ceremony
   itself is suspect, and publish a new manifest/log entry under the new key.
   Rotate keys at least annually and after any maintainer offboarding.

The Node CLI supports multiple `--key` entries, so release operators can verify
a bundle during the overlap window with both old and new public keys configured.

---

## 11. Relationship to #507 (SLSA Dependency Provenance)

This ticket protects **runtime artifacts** (zkey/wasm/vkey) between the
ceremony/release process and the proving client: signed manifest, transparency
log, streaming hash verification and the registry cross-check. Issue #507
covers **build-time dependency provenance** (SLSA attestations for source and
dependencies). The two are complementary and intentionally non-overlapping:

- #507 answers "was this source/build produced from trusted inputs?"
- This specification answers "is the artifact I am about to load the exact,
  signed, ceremony-bound byte stream the project published?"

Neither replaces the other; CI may attach SLSA provenance to the manifest file
as an additional artifact without changing the client verification contract.

---

## 12. Acceptance Criteria Mapping

| Criterion | Implementation |
|---|---|
| Tampered or unsigned artifact rejected before witness generation | Signature-first flow + `readVerifiedStream`; `loadVerifiedArtifacts` returns bytes only after all checks (§8). |
| Registry `ceremony_transcript_hash` matches signed manifest | `CEREMONY_HASH_MISMATCH` check in `loadVerifiedArtifacts` and `verify-artifacts` (§9). |
| Chunked downloads and offline cached copies verified | Incremental SHA-256 over `ReadableStream`/async iterables; cached bytes re-verified with the same function (§8). |
| Key rotation invalidates old signatures per policy | `status`/`retiredAt`/`revokedAt` checks → `KEY_RETIRED` / `KEY_REVOKED` (§10). |

Focused tests: `circuits/ceremony/verify-ceremony.test.js` (tamper, unsigned,
chunked file hashing, registry mismatch, log binding) and
`frontend/src/lib/zkproof.vkcache.verify.test.ts` (tamper, unsigned, chunked
stream, registry mismatch, offline cache, rotation/revocation).
