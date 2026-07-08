# Contributing to ZKVote

Thank you for your interest in contributing to ZKVote!

## Getting Started

1. **Fork and clone** the repository
2. **Install dependencies**:
   ```bash
   # Rust contracts
   rustup target add wasm32v1-none

   # Frontend
   cd frontend && npm install

   # Backend
   cd backend && npm install

   # Circuits
   cd circuits && npm install
   ```

3. **Run tests** to verify your setup:
   ```bash
   cargo test --workspace
   cd backend && npm test
   cd frontend && npm test
   cd circuits && npm test
   ```

## Development Workflow

### Code Style

**Rust:**
- Run `cargo fmt` before committing
- Run `cargo clippy` to check for common issues
- Use `panic_with_error!` instead of bare `panic!`

**TypeScript:**
- Run `npm run lint` in frontend/backend directories
- Use TypeScript strict mode
- Prefer explicit types over `any`

### Commit Messages

Use semantic commit prefixes:
- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring
- `test:` adding/updating tests
- `docs:` documentation changes
- `chore:` maintenance tasks

Example: `feat(voting): add nullifier field validation`

### Pull Request Process

1. Create a feature branch from `master`
2. Make your changes with clear, focused commits
3. Ensure all tests pass: `cargo test --workspace`
4. Update documentation if needed
5. Submit PR with description of changes

### Testing Requirements

- All new features must include tests
- Bug fixes should include regression tests
- Maintain or improve test coverage
- Integration tests for cross-contract flows

## Architecture Overview

```
contracts/
├── dao-registry/      # DAO creation & admin management
├── membership-sbt/    # Soulbound membership NFTs
├── membership-tree/   # On-chain Poseidon Merkle tree
├── voting/            # Groth16 verification + voting
├── comments/          # Anonymous ZK comments
└── zkvote-groth16/    # Shared Groth16 verification library

frontend/              # React + Vite frontend
backend/               # Express relayer for anonymous voting
circuits/              # Circom ZK circuits
```

### Key Invariants

1. **Field validation**: All BN254 public signals must be < Fr modulus
2. **Nullifier uniqueness**: One vote per nullifier per proposal
3. **Admin verification**: All privileged ops verify through registry
4. **VK versioning**: Proposals snapshot VK version at creation

### Circuit Modifications

If modifying `vote.circom`:

1. Regenerate the circuit artifacts:
   ```bash
   cd circuits
   ./compile.sh
   ```

2. Update verification key in contracts
3. Run verification script:
   ```bash
   ./scripts/verify-circuit.sh circuits
   ```

4. Update trusted setup documentation

## Security

- Report security issues privately via GitHub Security Advisories
- Do not commit secrets, keys, or sensitive data
- Follow OWASP guidelines for input validation
- All ZK public signals must be field-validated

## Questions?

- Open a GitHub Issue for bugs or feature requests
- Check existing issues before creating new ones
- See [README.md](README.md) for project overview
- See [THREAT_MODEL.md](THREAT_MODEL.md) for security considerations
