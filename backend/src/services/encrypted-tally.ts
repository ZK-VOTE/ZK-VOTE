/**
 * Encrypted-tally coordination and 2-of-3 decryption ceremony.
 *
 * Ballots never reveal `voteChoice` to the relayer: the circuit proves that
 * `(c1, cYes, cNo)` encrypts `(choice, 1 - choice)` under the election key, and
 * the contract stores only those points. After `end_time` the ceremony:
 *
 *   1. aggregates all ciphertexts homomorphically:
 *        C1 = Σ c1_i, CYes = Σ cYes_i, CNo = Σ cNo_i
 *   2. each authority publishes D_i = sk_i * C1
 *   3. any t shares are Lagrange-combined into D = sk * C1
 *   4. CYes - D = (#yes) * G and CNo - D = (#no) * G
 *
 * Step 4 is a small discrete log, so only the aggregate totals are revealed.
 *
 * SECURITY NOTE: this reference implementation keeps the full private key and
 * shares in memory so the ceremony can be exercised end-to-end in tests and in
 * a single-host deployment. Production deployments must place each share in an
 * independent KMS/HSM and run the ceremony on separate authority hosts; the
 * coordinator should never see more than the submitted decryption points.
 */

import { createHash } from "node:crypto";
import {
  addPoints,
  combineDecryptionShares,
  createShares,
  decryptCiphertext,
  decryptWithCombinedShare,
  generateDecryptionShare,
  generateElGamalKeypair,
  pointToHex,
  type BallotCiphertext,
  type Ciphertext,
  type Point,
} from "./elgamal.js";

export const DEFAULT_CEREMONY_THRESHOLD = 2;
export const DEFAULT_CEREMONY_AUTHORITIES = 3;

export interface CeremonyAuthority {
  index: number;
  address?: string;
  share: bigint;
}

export interface EncryptedElection {
  electionId: string;
  publicKey: Point;
  privateKey: bigint;
  threshold: number;
  authorities: CeremonyAuthority[];
  endTime: number;
  createdAt: number;
  ballots: BallotCiphertext[];
  aggregate: {
    c1: Point;
    cYes: Point;
    cNo: Point;
  } | null;
  finalized: boolean;
  result?: EncryptedTallyResult;
}

export interface EncryptedTallyResult {
  electionId: string;
  yesVotes: number;
  noVotes: number;
  ballotCount: number;
  aggregateC1: string;
  aggregateCYes: string;
  aggregateCNo: string;
  /** Hex SHA256 of the canonical transcript, suitable for audit logs. */
  transcriptHash: string;
  finalizedAt: number;
  approvers: number[];
}

export class TallyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ELECTION_NOT_FOUND"
      | "ELECTION_EXISTS"
      | "ELECTION_STILL_OPEN"
      | "ALREADY_FINALIZED"
      | "INSUFFICIENT_APPROVALS"
      | "INVALID_APPROVAL"
      | "INVALID_BALLOT"
      | "TALLY_MISMATCH",
  ) {
    super(message);
    this.name = "TallyError";
  }
}

function identity(): Point {
  return { x: 0n, y: 1n };
}

export class EncryptedTallyService {
  private readonly elections = new Map<string, EncryptedElection>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Create an election key and split it t-of-n. The returned shares are meant
   * to be distributed to independent authority hosts and then deleted from the
   * coordinator; tests keep them in the returned object.
   */
  async createElection(params: {
    electionId: string;
    endTime: number;
    threshold?: number;
    totalAuthorities?: number;
  }): Promise<{
    election: Omit<EncryptedElection, "privateKey" | "authorities">;
    shares: Array<{ index: number; value: bigint }>;
  }> {
    if (this.elections.has(params.electionId)) {
      throw new TallyError(
        `election ${params.electionId} already exists`,
        "ELECTION_EXISTS",
      );
    }
    const threshold = params.threshold ?? DEFAULT_CEREMONY_THRESHOLD;
    const total = params.totalAuthorities ?? DEFAULT_CEREMONY_AUTHORITIES;
    if (threshold < 1 || threshold > total) {
      throw new TallyError("invalid ceremony threshold", "INVALID_APPROVAL");
    }

    const { privateKey, publicKey } = await generateElGamalKeypair();
    const shares = createShares(privateKey, threshold, total);
    const election: EncryptedElection = {
      electionId: params.electionId,
      publicKey,
      privateKey,
      threshold,
      authorities: shares.map((s) => ({ index: s.index, share: s.value })),
      endTime: params.endTime,
      createdAt: this.now(),
      ballots: [],
      aggregate: null,
      finalized: false,
    };
    this.elections.set(params.electionId, election);

    return {
      election: {
        electionId: election.electionId,
        publicKey: election.publicKey,
        threshold: election.threshold,
        endTime: election.endTime,
        createdAt: election.createdAt,
        ballots: [],
        aggregate: null,
        finalized: false,
      },
      shares,
    };
  }

  getPublicKey(electionId: string): Point {
    return this.require(electionId).publicKey;
  }

  async registerBallot(
    electionId: string,
    ballot: BallotCiphertext,
  ): Promise<{ count: number; aggregate: { c1: string; cYes: string; cNo: string } }> {
    const election = this.require(electionId);
    if (election.finalized) {
      throw new TallyError("election already finalized", "ALREADY_FINALIZED");
    }
    if (this.now() > election.endTime) {
      throw new TallyError("election is closed", "ELECTION_STILL_OPEN");
    }
    const isValid =
      ballot?.c1 && ballot.cYes && ballot.cNo &&
      typeof ballot.c1.x === "bigint" &&
      typeof ballot.cYes.x === "bigint" &&
      typeof ballot.cNo.x === "bigint";
    if (!isValid) {
      throw new TallyError("malformed ballot ciphertext", "INVALID_BALLOT");
    }

    election.ballots.push(ballot);
    if (!election.aggregate) {
      election.aggregate = {
        c1: ballot.c1,
        cYes: ballot.cYes,
        cNo: ballot.cNo,
      };
    } else {
      election.aggregate = {
        c1: await addPoints(election.aggregate.c1, ballot.c1),
        cYes: await addPoints(election.aggregate.cYes, ballot.cYes),
        cNo: await addPoints(election.aggregate.cNo, ballot.cNo),
      };
    }

    return {
      count: election.ballots.length,
      aggregate: {
        c1: pointToHex(election.aggregate.c1),
        cYes: pointToHex(election.aggregate.cYes),
        cNo: pointToHex(election.aggregate.cNo),
      },
    };
  }

  /** An authority computes its decryption share for the aggregate. */
  async createApproval(
    electionId: string,
    authorityIndex: number,
  ): Promise<{ index: number; point: Point }> {
    const election = this.require(electionId);
    if (election.finalized) {
      throw new TallyError("election already finalized", "ALREADY_FINALIZED");
    }
    const authority = election.authorities.find(
      (a) => a.index === authorityIndex,
    );
    if (!authority) {
      throw new TallyError(
        `authority ${authorityIndex} not configured`,
        "INVALID_APPROVAL",
      );
    }
    if (!election.aggregate) {
      throw new TallyError("no ballots to decrypt", "TALLY_MISMATCH");
    }
    const c1: Ciphertext = { c1: election.aggregate.c1, c2: identity() };
    const point = await generateDecryptionShare(c1, authority.share);
    return { index: authorityIndex, point };
  }

  /**
   * Finalize with at least `threshold` distinct authority approvals. Reveals
   * only the aggregate yes/no counts.
   */
  async finalize(params: {
    electionId: string;
    approvals: Array<{ index: number; point: Point }>;
    now?: number;
  }): Promise<EncryptedTallyResult> {
    const election = this.require(params.electionId);
    if (election.finalized) {
      throw new TallyError("election already finalized", "ALREADY_FINALIZED");
    }
    const at = params.now ?? this.now();
    if (at <= election.endTime) {
      throw new TallyError(
        "decryption ceremony cannot run before end_time",
        "ELECTION_STILL_OPEN",
      );
    }
    if (!election.aggregate) {
      throw new TallyError("no ballots to decrypt", "TALLY_MISMATCH");
    }

    const unique = new Map<number, Point>();
    for (const approval of params.approvals) {
      if (
        !election.authorities.some((a) => a.index === approval.index)
      ) {
        throw new TallyError(
          `authority ${approval.index} not configured`,
          "INVALID_APPROVAL",
        );
      }
      unique.set(approval.index, approval.point);
    }
    if (unique.size < election.threshold) {
      throw new TallyError(
        `need ${election.threshold} distinct approvals, got ${unique.size}`,
        "INSUFFICIENT_APPROVALS",
      );
    }

    const combined = await combineDecryptionShares(
      Array.from(unique.entries()).map(([index, point]) => ({ index, point })),
    );
    const yesCiphertext: Ciphertext = {
      c1: election.aggregate.c1,
      c2: election.aggregate.cYes,
    };
    const noCiphertext: Ciphertext = {
      c1: election.aggregate.c1,
      c2: election.aggregate.cNo,
    };
    const yesVotes = Number(
      await decryptWithCombinedShare(
        yesCiphertext,
        combined,
        Math.max(1_000_000, election.ballots.length * 2 + 10),
      ),
    );
    const noVotes = Number(
      await decryptWithCombinedShare(
        noCiphertext,
        combined,
        Math.max(1_000_000, election.ballots.length * 2 + 10),
      ),
    );

    if (yesVotes + noVotes !== election.ballots.length) {
      throw new TallyError(
        `decrypted totals ${yesVotes}+${noVotes} do not match ${election.ballots.length} ballots`,
        "TALLY_MISMATCH",
      );
    }

    const aggregateC1 = pointToHex(election.aggregate.c1);
    const aggregateCYes = pointToHex(election.aggregate.cYes);
    const aggregateCNo = pointToHex(election.aggregate.cNo);
    const transcript = JSON.stringify({
      electionId: election.electionId,
      yesVotes,
      noVotes,
      ballotCount: election.ballots.length,
      aggregateC1,
      aggregateCYes,
      aggregateCNo,
      approvers: Array.from(unique.keys()).sort((a, b) => a - b),
    });
    const transcriptHash = createHash("sha256")
      .update(transcript)
      .digest("hex");

    const result: EncryptedTallyResult = {
      electionId: election.electionId,
      yesVotes,
      noVotes,
      ballotCount: election.ballots.length,
      aggregateC1,
      aggregateCYes,
      aggregateCNo,
      transcriptHash,
      finalizedAt: at,
      approvers: Array.from(unique.keys()).sort((a, b) => a - b),
    };
    election.finalized = true;
    election.result = result;
    return result;
  }

  /**
   * Test / recovery helper: decrypt directly with the full key. Never expose
   * this through an API in production.
   */
  async recoverTally(electionId: string): Promise<{ yesVotes: number; noVotes: number }> {
    const election = this.require(electionId);
    if (!election.aggregate) {
      throw new TallyError("no ballots to decrypt", "TALLY_MISMATCH");
    }
    const yesVotes = Number(
      await decryptCiphertext(
        { c1: election.aggregate.c1, c2: election.aggregate.cYes },
        election.privateKey,
      ),
    );
    const noVotes = Number(
      await decryptCiphertext(
        { c1: election.aggregate.c1, c2: election.aggregate.cNo },
        election.privateKey,
      ),
    );
    return { yesVotes, noVotes };
  }

  getResult(electionId: string): EncryptedTallyResult | null {
    return this.require(electionId).result ?? null;
  }

  private require(electionId: string): EncryptedElection {
    const election = this.elections.get(electionId);
    if (!election) {
      throw new TallyError(
        `unknown election ${electionId}`,
        "ELECTION_NOT_FOUND",
      );
    }
    return election;
  }
}

export const encryptedTally = new EncryptedTallyService();
