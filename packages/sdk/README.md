# @zkvote/sdk

Zero-knowledge proof generation and verification SDK for anonymous voting on Stellar Soroban.

## Features

- **Proof Generation**: Generate Groth16 zero-knowledge proofs for votes and membership claims
- **Identity Derivation**: Derive identity commitments and nullifiers from secrets
- **Key Management**: Load and verify proving keys with integrity checks
- **Cache Policy**: Configurable caching for improved performance
- **Worker Support**: Browser web worker support for non-blocking proof generation
- **Circuit Compatibility**: Versioned circuit compatibility matrix

## Installation

```bash
npm install @zkvote/sdk
```

## Quick Start

```typescript
import {
  loadKeys,
  generateVoteProof,
  deriveIdentityCommitment,
  deriveNullifier,
} from "@zkvote/sdk";

// Initialize SDK
await loadKeys({
  manifestUrl: "https://cdn.zkvote.io/keys/v1/manifest.json",
});

// Derive identity
const secret = new Uint8Array(32); // Your secret
const commitment = deriveIdentityCommitment(secret);
const nullifier = deriveNullifier(secret, "poll-123");

// Generate vote proof
const proof = await generateVoteProof({
  identitySecret: secret,
  pollId: "poll-123",
  choice: "option-a",
  merkleProof: {
    root: "0x...",
    siblings: ["0x...", "0x..."],
    pathIndices: [0, 1],
  },
});

// Submit proof to voting contract
await submitVote(proof);
```

## Key Management

### Online Keys (CDN)

```typescript
await loadKeys({
  manifestUrl: "https://cdn.zkvote.io/keys/v1/manifest.json",
});

// Verify integrity
const isValid = await verifyKeyIntegrity();
if (!isValid) {
  throw new Error("Key integrity check failed");
}
```

### Offline Keys (Bundled)

For air-gapped environments:

```typescript
await loadKeys({
  offlinePack: true,
});
```

## Caching

Configure cache policy for improved performance:

```typescript
import { configureCache } from "@zkvote/sdk";

configureCache({
  enabled: true,
  ttl: 3600, // 1 hour
  maxSize: 100 * 1024 * 1024, // 100MB
  strategy: "lru", // or 'fifo', 'lfu'
});
```

## Worker Support

For browser environments, use worker-based proving:

```typescript
import { generateVoteProofInWorker } from "@zkvote/sdk";

const proof = await generateVoteProofInWorker(params);
```

## API Reference

### Proof Generation

#### `generateVoteProof(params: VoteProofParams): Promise<Proof>`

Generate a zero-knowledge proof for anonymous voting.

#### `generateClaimProof(params: ClaimProofParams): Promise<Proof>`

Generate a zero-knowledge proof for membership claim.

### Verification

#### `verifyTally(params: TallyVerifyParams): Promise<boolean>`

Verify a tally proof.

### Identity Derivation

#### `deriveIdentityCommitment(secret: Uint8Array): string`

Derive identity commitment from secret.

#### `deriveNullifier(secret: Uint8Array, pollId: string): string`

Derive nullifier from secret and poll ID.

#### `generateSecret(): Uint8Array`

Generate a random 32-byte secret.

### Key Management

#### `loadKeys(options: KeyLoadOptions): Promise<void>`

Load proving keys from manifest or offline pack.

#### `verifyKeyIntegrity(): Promise<boolean>`

Verify integrity of loaded keys.

#### `areKeysLoaded(): boolean`

Check if keys are loaded.

### Cache Management

#### `configureCache(policy: CachePolicy): void`

Configure cache policy.

#### `clearCache(): void`

Clear entire cache.

#### `getCacheStats(): CacheStats`

Get cache statistics.

## Circuit Compatibility

SDK version 1.0.0 supports circuits:

- v1.0
- v0.9

See [COMPATIBILITY.md](./COMPATIBILITY.md) for full compatibility matrix.

## Error Handling

```typescript
import { ErrorCodes } from "@zkvote/sdk";

try {
  const proof = await generateVoteProof(params);
} catch (error) {
  if (error.code === ErrorCodes.KEYS_NOT_LOADED) {
    console.error("Keys not loaded. Call loadKeys() first.");
  }
}
```

## Security

- All key downloads are verified with SHA-256 hashes
- Keys are loaded from signed manifests
- Circuit compatibility is enforced
- Secrets must be 32 bytes and properly generated

## License

MIT
