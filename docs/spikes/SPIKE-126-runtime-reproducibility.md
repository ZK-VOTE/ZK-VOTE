# SPIKE-126: Runtime and WASM Reproducibility

## Decision

Pin Node.js, package-manager version, Rust toolchain, wasm target, and native build prerequisites in repository configuration and CI. Local and CI builds must use the same lockfiles and fail when the selected runtime differs from the declared versions.

## Required gates

- `.nvmrc` or `engines` is the single Node major source of truth.
- Corepack pins the package-manager version used by CI.
- `rust-toolchain.toml` pins Rust and required targets.
- CI records Node, npm/pnpm, Rust, wasm target, and lockfile hashes.
- A clean-container build and a native-module smoke test run on every release candidate.

Dependency upgrades must be deliberate, regenerate lockfiles, and publish the resulting toolchain tuple in build metadata.

