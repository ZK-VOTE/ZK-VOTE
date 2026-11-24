# EPIC-004: Proving SDK Extraction Implementation Plan

## Overview

Extract proving logic into a versioned, standalone SDK for third-party consumption.

## SDK Design

### Public API Surface

```typescript
// Core proving functions
export async function generateVoteProof(
  params: VoteProofParams,
): Promise<Proof>;
export async function generateClaimProof(
  params: ClaimProofParams,
): Promise<Proof>;
export async function verifyTally(params: TallyVerifyParams): Promise<boolean>;

// Identity derivation
export function deriveIdentityCommitment(secret: Uint8Array): string;
export function deriveNullifier(secret: Uint8Array, pollId: string): string;

// Key management
export async function loadKeys(manifest: KeyManifest): Promise<void>;
export async function verifyKeyIntegrity(): Promise<boolean>;

// Cache policy
export function configureCache(policy: CachePolicy): void;
```

### Stability Guarantees

- **Major version**: Breaking API changes
- **Minor version**: New features, backward compatible
- **Patch version**: Bug fixes

**Circuit Compatibility Windows**: SDK version N supports circuits version N and N-1

## Key Distribution Architecture

### Manifest Format

```json
{
  "version": "1.0.0",
  "keys": {
    "vote": {
      "wasm": "https://cdn.zkvote.io/keys/v1/vote.wasm",
      "zkey": "https://cdn.zkvote.io/keys/v1/vote.zkey",
      "vkey": "https://cdn.zkvote.io/keys/v1/vote.vkey",
      "hash": "sha256:...",
      "size": 45000000
    }
  }
}
```

### Verified Loading

1. Fetch keys from CDN
2. Verify SHA-256 hash
3. Check signature (signed manifest)
4. Cache locally
5. Validate circuit compatibility

### Offline Key Packs

For air-gap scenarios, bundle keys with SDK:

```bash
npm pack @zkvote/sdk-with-keys
```

## Compatibility Matrix

| SDK Version | Circuit Version | Status      |
| ----------- | --------------- | ----------- |
| 1.0.x       | 1.0, 0.9        | Supported   |
| 0.9.x       | 0.9, 0.8        | Deprecated  |
| 0.8.x       | 0.8             | End of life |

**Testing**: Matrix tested in CI for all combinations

## Build & Publish Pipeline

### Package Structure

```
@zkvote/sdk/
├── src/
│   ├── prove.ts      # Proof generation
│   ├── verify.ts     # Verification
│   ├── derive.ts     # Identity derivation
│   ├── keys.ts       # Key management
│   └── cache.ts      # Cache policy
├── workers/          # Web worker bundles
├── wasm/             # WASM modules
└── manifests/        # Key manifests
```

### Publishing Steps

1. Run full test suite including compatibility matrix
2. Generate bundle with size checks (< 500KB base, < 50MB with keys)
3. Sign package with release key
4. Generate provenance attestation
5. Publish to npm with `@zkvote/sdk` namespace
6. Update CDN with new key manifests

### Supply Chain Security

- Package signing with GPG key
- Provenance via npm provenance
- SLSA Level 3 compliance
- Dependency pinning
- Regular security audits

## Implementation Plan

### Phase 1: Core Extraction

- Extract proving logic from `frontend/src/lib/zkproof.ts`
- Extract workers from `frontend/src/workers/`
- Create SDK package structure

### Phase 2: Key Management

- Implement manifest loading
- Add verification logic
- Create offline pack builder

### Phase 3: Compatibility Layer

- Version negotiation logic
- Circuit compatibility checks
- Error taxonomy

### Phase 4: App Migration

- Migrate app to consume SDK
- Regression testing (full e2e parity)
- Performance benchmarks

### Phase 5: Publishing

- CI/CD pipeline setup
- Signing infrastructure
- Documentation

## File Changes

### New SDK Package

- `packages/sdk/` - New package root
- `packages/sdk/src/` - SDK source code
- `packages/sdk/test/` - SDK test suite
- `packages/sdk/examples/` - Usage examples

### Extraction Sources

- `frontend/src/lib/zkproof.ts` → `packages/sdk/src/prove.ts`
- `frontend/src/lib/client.ts` → `packages/sdk/src/derive.ts`
- `frontend/src/workers/` → `packages/sdk/workers/`
- `frontend/src/config/keys.json` → `packages/sdk/manifests/`

### App Migration

- `frontend/package.json` - Add `@zkvote/sdk` dependency
- `frontend/src/lib/zkproof.ts` - Thin wrapper around SDK
- `frontend/src/lib/client.ts` - Use SDK derivation

### Testing

- `packages/sdk/test/compatibility.test.ts` - Matrix tests
- `frontend/e2e/` - Regression suite with SDK

### CI/CD

- `.github/workflows/sdk-publish.yml` - Publish pipeline
- `.github/workflows/sdk-test.yml` - SDK test suite

### Documentation

- `packages/sdk/README.md` - SDK documentation
- `packages/sdk/API.md` - API reference
- `packages/sdk/COMPATIBILITY.md` - Version policy
- `docs/SDK_INTEGRATION.md` - Integration guide

## Consumer Example

```typescript
import { generateVoteProof, loadKeys } from "@zkvote/sdk";

// Initialize SDK
await loadKeys({
  manifestUrl: "https://cdn.zkvote.io/keys/v1/manifest.json",
});

// Generate proof
const proof = await generateVoteProof({
  identitySecret: mySecret,
  pollId: "poll-123",
  choice: "option-a",
  merkleProof: myMembershipProof,
});

// Submit proof
await submitVote(proof);
```

## Acceptance Criteria

- ✅ SDK published to npm with signed provenance
- ✅ Independent demo app proves successfully via SDK
- ✅ Compatibility matrix green for supported versions
- ✅ Main app runs on SDK with zero regression
- ✅ Key logistics meet device budgets (< 100MB total)
- ✅ Documentation complete with examples

## Current Status

Planning complete. Extraction and package setup pending.
