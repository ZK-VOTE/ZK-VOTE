
# STARK Circuits for Post-Quantum Validation

This directory contains the Plonky2 implementations for the vote and comment semantics.
- Unlike Groth16 which uses Circom, our STARK implementation leverages Plonky2's Rust-based builder DSL.
- **Vote Semantics**: Validates membership via Poseidon2/Goldilocks tree.
- **Comment Semantics**: Validates anonymous comment binding.

