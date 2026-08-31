-- ============================================
-- Migration 004: Add canonical_proof_hash for malleability-safe dedup
-- Created: 2026-08-30
-- ============================================
--
-- Groth16 proofs are malleable: (A, B, C) and (-A, -B, C) both verify.
-- Both malleable forms of a proof must map to the same dedup key so that
-- a retry using the negated form is correctly detected as a duplicate.
--
-- canonical_proof_hash = SHA256(canonical_a_hex || canonical_b_hex || c_hex)
-- where (canonical_a, canonical_b) are produced by canonicalizeProof().
-- Existing rows have NULL here and are handled by the NULL-safe lookup path.

ALTER TABLE proof_commitments ADD COLUMN canonical_proof_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_proof_commitments_canonical
  ON proof_commitments(canonical_proof_hash);
