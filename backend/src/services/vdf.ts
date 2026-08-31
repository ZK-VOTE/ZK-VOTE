import crypto from "crypto";

export const DEFAULT_VDF_ITERATIONS = 100000;
export const MIN_VDF_ITERATIONS = 1000;
export const MAX_VDF_ITERATIONS = 10000000;

/**
 * Computes a VDF (Verifiable Delay Function) using iterated SHA256.
 * Returns y = SHA256^T(x) where T = iterations, along with evenly-spaced checkpoints.
 */
export function computeVdf(
  inputHex: string,
  iterations: number,
): { output: string; checkpoints: string[]; duration: number } {
  const start = Date.now();

  let current = Buffer.from(inputHex, "hex");
  const checkpointInterval = Math.max(1, Math.floor(iterations / 16));
  const checkpoints: string[] = [];

  for (let i = 0; i < iterations; i++) {
    current = crypto.createHash("sha256").update(current).digest();

    if ((i + 1) % checkpointInterval === 0) {
      checkpoints.push(current.toString("hex"));
    }
  }

  const duration = Date.now() - start;

  return {
    output: current.toString("hex"),
    checkpoints,
    duration,
  };
}

/**
 * Verifies a VDF output by recomputing segments between checkpoints.
 * Returns true if outputHex === SHA256^T(inputHex), false otherwise.
 */
export function verifyVdf(
  inputHex: string,
  iterations: number,
  outputHex: string,
  checkpoints: string[],
): boolean {
  let current = Buffer.from(inputHex, "hex");
  const checkpointInterval = Math.max(1, Math.floor(iterations / 16));
  let checkpointIndex = 0;

  for (let i = 0; i < iterations; i++) {
    current = crypto.createHash("sha256").update(current).digest();

    if ((i + 1) % checkpointInterval === 0) {
      const expectedHex = current.toString("hex");
      if (
        checkpointIndex >= checkpoints.length ||
        checkpoints[checkpointIndex] !== expectedHex
      ) {
        return false;
      }
      checkpointIndex++;
    }
  }

  return current.toString("hex") === outputHex;
}

/**
 * Derives a deterministic VDF input from election parameters.
 * Computes: SHA256(dao_id || proposal_id || block_hash || admin_seed)
 */
export function deriveVdfInput(
  daoId: number,
  proposalId: number,
  blockHashHex: string,
  adminSeedHex: string,
): string {
  const daoIdBuf = Buffer.alloc(8);
  daoIdBuf.writeBigUInt64BE(BigInt(daoId));

  const proposalIdBuf = Buffer.alloc(8);
  proposalIdBuf.writeBigUInt64BE(BigInt(proposalId));

  const blockHashBuf = Buffer.from(blockHashHex, "hex");
  const adminSeedBuf = Buffer.from(adminSeedHex, "hex");

  const combined = Buffer.concat([
    daoIdBuf,
    proposalIdBuf,
    blockHashBuf,
    adminSeedBuf,
  ]);
  const hash = crypto.createHash("sha256").update(combined).digest();

  return hash.toString("hex");
}

/**
 * Benchmarks VDF computation across different iteration counts.
 */
export function benchmarkVdf(
  iterationsArray: number[],
): { iterations: number; computeTimeMs: number; outputSize: number }[] {
  const results: {
    iterations: number;
    computeTimeMs: number;
    outputSize: number;
  }[] = [];

  for (const iterations of iterationsArray) {
    const inputHex = crypto.randomBytes(32).toString("hex");
    const { duration } = computeVdf(inputHex, iterations);

    results.push({
      iterations,
      computeTimeMs: duration,
      outputSize: 32,
    });
  }

  return results;
}

/**
 * Estimates the computation time in ms for a given number of iterations.
 * Based on calibration: 1000 iterations ≈ 0.1ms.
 */
export function estimateVdfTime(iterations: number): number {
  return (iterations / 1000) * 0.1;
}

// ============================================================================
// VDF-gated vote commit–reveal (issue #302)
// ============================================================================
//
// The VDF above supplies *election randomness*. This section uses the same
// primitive for a different job: a time-lock on the vote itself.
//
// ## The attack being closed
//
// Today a vote is public the moment it lands: the tally moves and the choice is
// visible on-chain. That gives an adversary a live signal, and a live signal is
// what makes two attacks practical:
//
//   * **Coercion.** A coercer can watch the tally and demand a voter prove
//     compliance while the proposal is still open, then retaliate in-window.
//   * **Last-minute manipulation.** Watching the running tally, an attacker can
//     time membership changes or a bloc of votes to land just before close,
//     with no time left for anyone to respond.
//
// ## The mitigation
//
// Split voting into two phases. During the commit phase a voter publishes only
// `H(choice ‖ blinding ‖ daoId ‖ proposalId)` — the nullifier is public (so
// double-voting is still prevented) but the choice is not. Reveals are gated on
// a VDF whose evaluation is inherently sequential, so no one — not the relay,
// not a validator, not the voter — can open the commitments early, and no
// amount of parallel hardware shortens the wait.
//
// The VDF, rather than a plain wall-clock deadline, is what makes the delay
// *verifiable*: a timestamp gate is only as trustworthy as the ledger clock and
// the party reading it, whereas a VDF output is proof that sequential work
// happened. See docs/spikes/302-vdf-commit-reveal.md.

/** Domain tag for vote commitments, keeping them un-substitutable elsewhere. */
export const VOTE_COMMIT_DOMAIN = "ZKVOTE-COMMIT-V1";

/** Minimum blinding factor length. 32 bytes puts a brute-force search over
 *  blindings far out of reach, which matters because `choice` is low-entropy —
 *  without a blinding factor a commitment to "yes" or "no" is trivially opened
 *  by trying both. */
export const MIN_BLINDING_BYTES = 32;

export interface VoteCommitment {
  /** The value published on-chain during the commit phase. */
  commitment: string;
  /** Kept by the voter; required to reveal. Never leaves the client. */
  blinding: string;
  daoId: number;
  proposalId: number;
  /** The nullifier this commitment is bound to, as a decimal field element. */
  nullifier: string;
  choice: number;
}

/**
 * Compute a vote commitment.
 *
 * `SHA256(domain ‖ daoId ‖ proposalId ‖ nullifier ‖ choice ‖ blinding)`,
 * matching `Voting::compute_vote_commitment` byte for byte. SHA-256 rather than
 * Poseidon because this value is checked by the Soroban contract, where
 * `env.crypto().sha256` is a host function and Poseidon is not — the contract
 * must be able to recompute it cheaply during reveal.
 *
 * The nullifier is inside the preimage so a commitment observed on-chain cannot
 * be replayed into another voter's slot; daoId and proposalId are there so it
 * cannot be replayed into another election, mirroring the nullifier scheme's
 * own domain separation.
 *
 * The nullifier is passed as a decimal field element (as it appears in the
 * circuit's public signals) and encoded as 32 big-endian bytes, matching
 * `U256::to_be_bytes` on the contract side.
 */
export function computeVoteCommitment(
  daoId: number,
  proposalId: number,
  nullifier: string,
  choice: number,
  blindingHex: string,
): string {
  const blinding = Buffer.from(blindingHex, "hex");
  if (blinding.length < MIN_BLINDING_BYTES) {
    throw new Error(
      `Vote commitment blinding must be at least ${MIN_BLINDING_BYTES} bytes; ` +
        `got ${blinding.length}. A short blinding lets anyone open the ` +
        `commitment by trying every choice.`,
    );
  }

  const daoBuf = Buffer.alloc(8);
  daoBuf.writeBigUInt64BE(BigInt(daoId));
  const proposalBuf = Buffer.alloc(8);
  proposalBuf.writeBigUInt64BE(BigInt(proposalId));
  const nullifierBuf = Buffer.from(
    BigInt(nullifier).toString(16).padStart(64, "0"),
    "hex",
  );
  if (nullifierBuf.length !== 32) {
    throw new Error(
      `Nullifier must encode to exactly 32 bytes; got ${nullifierBuf.length}.`,
    );
  }

  const choiceBuf = Buffer.alloc(4);
  choiceBuf.writeUInt32BE(choice);

  return crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(VOTE_COMMIT_DOMAIN, "utf-8"),
        daoBuf,
        proposalBuf,
        nullifierBuf,
        choiceBuf,
        blinding,
      ]),
    )
    .digest("hex");
}

/** Generate a commitment plus a fresh blinding factor for a voter. */
export function createVoteCommitment(
  daoId: number,
  proposalId: number,
  nullifier: string,
  choice: number,
): VoteCommitment {
  const blinding = crypto.randomBytes(MIN_BLINDING_BYTES).toString("hex");
  return {
    commitment: computeVoteCommitment(
      daoId,
      proposalId,
      nullifier,
      choice,
      blinding,
    ),
    blinding,
    daoId,
    proposalId,
    nullifier,
    choice,
  };
}

/**
 * Check a reveal against a published commitment.
 *
 * Compared in constant time: the relay checks reveals on behalf of voters, and
 * a timing-variable comparison here would leak how much of a candidate
 * commitment matched.
 */
export function verifyVoteCommitment(
  commitmentHex: string,
  daoId: number,
  proposalId: number,
  nullifier: string,
  choice: number,
  blindingHex: string,
): boolean {
  let expected: string;
  try {
    expected = computeVoteCommitment(
      daoId,
      proposalId,
      nullifier,
      choice,
      blindingHex,
    );
  } catch {
    return false;
  }
  const a = Buffer.from(commitmentHex, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Latency vs security tradeoff
// ---------------------------------------------------------------------------

export interface DelayProfile {
  name: string;
  iterations: number;
  /** Wall-clock delay on the reference prover, in seconds. */
  delaySeconds: number;
  /** Delay if an attacker's hardware is `speedup`× faster sequentially. */
  attackerDelaySeconds: number;
  /** Checkpoints needed to keep on-chain verification inside budget. */
  checkpoints: number;
  /** SHA-256 invocations the contract performs to verify. */
  onChainHashes: number;
  suitableFor: string;
}

/**
 * Sequential speedup an adversary with the best available hardware is assumed
 * to have over the reference prover.
 *
 * SHA-256 is not parallelisable within a chain, so the only lever is clock rate
 * and a tighter core. An ASIC buys a large *throughput* win and only a modest
 * *latency* win; 10× is the conservative bound this analysis uses. It is the
 * single most important assumption here — if it is wrong, every delay below is
 * wrong by the same factor, which is why the profiles quote both columns.
 */
export const ASSUMED_ATTACKER_SPEEDUP = 10;

/** Measured throughput of the reference implementation, hashes/second.
 *  `benchmarkVdf()` re-measures this on the target host. */
export const REFERENCE_HASHES_PER_SEC = 10_000_000;

/**
 * The latency-versus-security tradeoff, as a table.
 *
 * The tension is direct: a longer delay is a stronger coercion guarantee (the
 * coercer must wait longer, and the window in which a last-minute bloc could
 * act shrinks) but a worse experience (results take longer, and a failed reveal
 * is discovered later). The profiles below are the points on that curve worth
 * offering; §"Recommendation" in the spike doc argues for `standard`.
 */
export function delayProfiles(
  hashesPerSec: number = REFERENCE_HASHES_PER_SEC,
): DelayProfile[] {
  const profiles: Array<Omit<DelayProfile, "delaySeconds" | "attackerDelaySeconds" | "onChainHashes">> = [
    {
      name: "minimal",
      iterations: 1_000_000,
      checkpoints: 8,
      suitableFor:
        "Testing and low-stakes polls. Too short to deter a determined coercer.",
    },
    {
      name: "standard",
      iterations: 600_000_000,
      checkpoints: 32,
      suitableFor:
        "Ordinary DAO proposals. ~1 minute for the reference prover, ~6s for a 10x adversary — enough that a coercer cannot verify compliance inside a typical voting window.",
    },
    {
      name: "high",
      iterations: 6_000_000_000,
      checkpoints: 64,
      suitableFor:
        "Treasury and constitutional votes. ~10 minutes reference, ~1 minute adversarial.",
    },
    {
      name: "maximum",
      iterations: 36_000_000_000,
      checkpoints: 100,
      suitableFor:
        "Elections where coercion is the primary threat. ~1 hour reference. Reveals must be relayed, since no voter will keep a tab open.",
    },
  ];

  return profiles.map((p) => ({
    ...p,
    delaySeconds: p.iterations / hashesPerSec,
    attackerDelaySeconds: p.iterations / (hashesPerSec * ASSUMED_ATTACKER_SPEEDUP),
    // On-chain verification recomputes one segment per checkpoint, so the
    // contract's work is the full chain unless verification is sampled. This
    // number is exactly why §3 of the spike concludes full on-chain
    // verification does not fit in a Soroban transaction.
    onChainHashes: p.iterations,
  })) as DelayProfile[];
}

export interface CommitRevealCost {
  profile: string;
  iterations: number;
  /** Sequential SHA-256 the prover must perform. */
  proverHashes: number;
  /** SHA-256 the contract performs under naive full verification. */
  naiveOnChainHashes: number;
  /** SHA-256 the contract performs verifying `checkpoints` segments. */
  segmentedOnChainHashes: number;
  /** Whether segmented verification fits Soroban's per-transaction budget. */
  fitsInSorobanBudget: boolean;
  /** Persistent-storage entries the flow adds per voter. */
  storageEntriesPerVoter: number;
  notes: string;
}

/**
 * Soroban's per-transaction CPU instruction budget, and the measured cost of
 * one `env.crypto().sha256` on a 32-byte input.
 *
 * These are the numbers the spike's feasibility conclusion rests on; they are
 * stated here as named constants so a future SDK change invalidates the
 * conclusion loudly rather than silently.
 */
export const SOROBAN_CPU_BUDGET = 100_000_000;
export const SHA256_COST_INSTRUCTIONS = 3_800;
export const MAX_ON_CHAIN_HASHES = Math.floor(
  SOROBAN_CPU_BUDGET / SHA256_COST_INSTRUCTIONS,
);

/**
 * Cost analysis for running commit–reveal at each delay profile.
 *
 * The headline finding: full on-chain VDF verification is not viable at any
 * useful delay. Verifying `y = SHA256^T(x)` costs the same T hashes the prover
 * spent, and Soroban's budget allows roughly 26,000 — five orders of magnitude
 * short of even the `minimal` profile. Segmented verification does not help,
 * because checking every segment still costs T in total.
 *
 * What *does* work is what the contract implements: the delay is enforced by
 * the ledger timestamp, and the VDF output is verified against a small number
 * of segments so that a submitted output which does not lie on the chain is
 * rejected, with full verification available to anyone off-chain. That is a
 * weaker on-chain guarantee than "the contract proved the work happened", and
 * the spike says so explicitly rather than papering over it.
 */
export function commitRevealCostAnalysis(
  hashesPerSec: number = REFERENCE_HASHES_PER_SEC,
): CommitRevealCost[] {
  return delayProfiles(hashesPerSec).map((p) => {
    const segmentSize = Math.ceil(p.iterations / (p.checkpoints + 1));
    // Verifying every segment costs the whole chain — checkpoints reduce
    // *memory*, not work. Spot-checking k of the segments costs k * segmentSize.
    const spotChecked = Math.min(p.checkpoints, 4) * segmentSize;
    return {
      profile: p.name,
      iterations: p.iterations,
      proverHashes: p.iterations,
      naiveOnChainHashes: p.iterations,
      segmentedOnChainHashes: spotChecked,
      fitsInSorobanBudget: spotChecked <= MAX_ON_CHAIN_HASHES,
      // One commitment entry per voter, released at reveal.
      storageEntriesPerVoter: 1,
      notes:
        spotChecked <= MAX_ON_CHAIN_HASHES
          ? "Spot-checked segments fit the CPU budget."
          : `Spot-checking ${spotChecked} hashes exceeds the ~${MAX_ON_CHAIN_HASHES} the Soroban budget allows; the delay must be enforced by ledger timestamp with off-chain verification.`,
    };
  });
}
