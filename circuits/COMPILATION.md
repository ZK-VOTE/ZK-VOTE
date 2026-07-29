# Circuit Compilation Guide

This document describes the deterministic compilation process for ZK-VOTE circuit artifacts.

## Overview

The ZK-VOTE project uses Circom to compile zero-knowledge circuits. To ensure reproducible builds and security, the compilation process is deterministic and version-pinned.

## Prerequisites

### Local Compilation

- **Node.js**: v20 or later
- **Circom**: Exactly version 2.1.8 (pinned in `.circomversion`)
- **npm**: For dependency management
- **snarkjs**: For trusted setup and verification key export (installed via npm)

### Docker-Based Compilation (Recommended)

- **Docker**: Latest stable version
- No local Circom installation required

## Pinned Versions

- **Circom Compiler**: 2.1.8
- **circomlib**: ^2.0.5
- **circomlibjs**: ^0.1.7
- **snarkjs**: ^0.7.4

## Compilation Methods

### Method 1: Docker-Based Compilation (Recommended)

Docker provides a reproducible build environment that eliminates system-specific variations.

```bash
# Compile circuits using Docker
./scripts/compile-circuits.sh --docker
```

This will:
1. Build a Docker image with the exact Circom version
2. Compile the circuit in an isolated environment
3. Generate deterministic artifacts
4. Produce SHA-256 checksums

### Method 2: Local Compilation

If you have the exact Circom version installed locally:

```bash
# Compile circuits locally
./scripts/compile-circuits.sh
```

**Important**: The local Circom version must match the pinned version (2.1.8) for reproducible builds.

## Artifacts Generated

The compilation process generates the following artifacts in `circuits/build/`:

- **vote.r1cs**: Rank-1 Constraint System (deterministic)
- **vote_js/vote.wasm**: WebAssembly circuit (deterministic)
- **verification_key.json**: Verification key (deterministic from zkey)
- **verification_key_soroban.json**: Soroban-formatted verification key (deterministic)

## Checksums

SHA-256 checksums are automatically generated for all compiled artifacts and stored in:
- `circuits/checksums.sha256`

## Verification

### Verify Artifacts

To verify that compiled artifacts match the committed checksums:

```bash
./scripts/verify-circuits.sh
```

This script performs:
1. SHA-256 checksum verification
2. PGP signature verification (if signature exists)
3. Verification key hash validation
4. zkey integrity verification
5. Verification key derivation check

### CI/CD Verification

The CI pipeline automatically verifies circuit artifact checksums on every pull request and push to main branches. See `.github/workflows/ci.yml`.

## Signing Artifacts

To sign the checksums with a PGP key:

```bash
# Set your PGP key ID (optional, uses default if not set)
export PGP_KEY_ID="your-key-id"

# Compile and sign
./scripts/compile-circuits.sh --sign

# Or sign existing checksums
./scripts/sign-circuits.sh
```

This generates:
- `circuits/checksums.sha256.sig`: PGP signature

## Trusted Setup

The `vote_final.zkey` file is generated through a trusted setup ceremony and is inherently non-deterministic. Only the R1CS and WASM artifacts are checked for deterministic compilation.

The verification key is derived deterministically from the zkey using snarkjs.

## Security Considerations

1. **Version Pinning**: Always use the pinned Circom version (2.1.8)
2. **Reproducible Builds**: Use Docker for compilation when possible
3. **Checksum Verification**: Always verify checksums before deployment
4. **Trusted Setup**: The zkey file must be generated through a secure trusted setup ceremony
5. **PGP Signing**: Sign checksums to provide cryptographic proof of authenticity

## Troubleshooting

### Version Mismatch

If you see a version mismatch warning:
```bash
# Install the correct version via Docker (recommended)
./scripts/compile-circuits.sh --docker

# Or install Circom 2.1.8 locally
curl -L https://github.com/iden3/circom/releases/download/v2.1.8/circom-linux-amd64 -o circom
chmod +x circom
sudo mv circom /usr/local/bin/
```

### Checksum Verification Failure

If checksums don't match:
1. Ensure you're using the correct Circom version
2. Try Docker-based compilation for reproducibility
3. Check that no source files were modified
4. Verify the checksums file is up to date

## CI/CD Integration

The circuit verification is integrated into the CI pipeline:
- Runs on every push to main/master branches
- Runs on every pull request
- Fails if checksums don't match committed values
- Provides early detection of non-deterministic builds

## Additional Resources

- [Circom Documentation](https://docs.circom.io/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)
- [ZK-VOTE Circuit README](./README.md)
