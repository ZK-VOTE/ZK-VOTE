# SPIKE-126: Runtime compatibility policy

## Decision

Node 22 is the service runtime. Node 20 remains permitted only for the circuits toolchain until its proving matrix is revalidated. CI, Docker, local tooling, and package engines must declare the same runtime for the component they build.

The repository must add `.nvmrc` or Volta metadata for each supported workspace, set `engines.node`, and run a preflight that fails before dependency installation when the runtime is unsupported. Native modules are built and tested with the same Node ABI used at runtime; `npm rebuild` is not a deployment fix.

## Upgrade gate

An upgrade is a versioned change that runs the backend ABI smoke test, frontend build, circuit known-answer corpus, WASM size check, and proving benchmarks. Benchmarks record Node, V8, OS, circuit size, heap limit, and commit. A Node-next candidate may merge only when the matrix has no correctness regression and no memory cliff.

Docker images and GitHub Actions must use the declared component runtime. The release checklist rejects a mismatch between package engines, CI, and image tags.

