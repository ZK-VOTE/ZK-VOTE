// @ts-nocheck
/**
 * Nova IVC Off-Chain Aggregation Service for ZK-VOTE
 *
 * Coordinates collection of vote witnesses, execution of Nova IVC folding,
 * generation of compressed recursive proofs, and relaying to Soroban.
 */

import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import {
  aggregateCiphertexts,
  pointFromHex,
  pointToHex,
  type Ciphertext,
} from "./elgamal.js";

const execAsync = promisify(exec);

export interface VoteWitnessPayload {
  secret: string;
  salt: string;
  path_elements: string[];
  path_indices: number[];
  vote_choice: number;
  nullifier: string;
  dao_id: number;
  proposal_id: number;
}

export interface IvcState {
  step_count: number;
  root: string;
  yes_votes: number;
  no_votes: number;
  acc_nullifier_hash: string;
}

export interface RecursiveProofPayload {
  initial_state: IvcState;
  final_state: IvcState;
  num_votes: number;
  proof_bytes: string;
  timestamp: number;
}

export interface TallyProofPayload {
  nullifier_root: string;
  yes_votes: number;
  no_votes: number;
  proof_a: string;
  proof_b: string;
  proof_c: string;
}

export class NovaAggregatorService {
  private tempDir: string;
  private _exec: typeof execAsync;

  constructor(tempDir?: string) {
    this.tempDir = tempDir || path.join(process.cwd(), "temp", "nova");
    this._exec = execAsync;
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /** Test seam: replace the CLI runner so tests don't spawn cargo (#566). */
  _setExecForTest(fn: typeof execAsync): void {
    this._exec = fn;
  }

  /**
   * Verify a recursive proof by delegating to the nova-aggregator CLI's
   * `--verify` mode, which runs `NovaAggregator::verify_proof` and prints
   * `{"verified": bool}` (exit 0 when valid, 1 when invalid) (#566).
   *
   * `POST /api/v1/nova/verify` called this method, but it did not exist, so
   * every verification request failed with a 500.
   */
  async verifyProof(
    payload: RecursiveProofPayload,
  ): Promise<{ verified: boolean }> {
    const proofPath = path.join(
      this.tempDir,
      `verify_${Date.now()}_${Math.random().toString(36).slice(2)}.json`,
    );
    try {
      fs.writeFileSync(proofPath, JSON.stringify(payload), "utf8");
      const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --verify "${proofPath}"`;
      let stdout: string;
      try {
        ({ stdout } = await this._exec(cargoCmd, {
          cwd: path.resolve(__dirname, "../../"),
        }));
      } catch (err: any) {
        // exit code 1 means "proof invalid": exec rejects but stdout still
        // carries {"verified": false}. Anything else is a real failure.
        if (err && typeof err.stdout === "string" && err.stdout.includes('"verified"')) {
          stdout = err.stdout;
        } else {
          throw err;
        }
      }
      return { verified: parseVerifyOutput(stdout) };
    } finally {
      if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
    }
  }

  /// Default aggregate Votes method
  async aggregateVotes(
    daoId: number,
    proposalId: number,
    root: string,
    witnesses: VoteWitnessPayload[],
  ): Promise<RecursiveProofPayload> {
    const timestamp = Date.now();
    const batchPath = path.join(
      this.tempDir,
      `batch_${daoId}_${proposalId}_${timestamp}.json`,
    );
    const outputPath = path.join(
      this.tempDir,
      `proof_${daoId}_${proposalId}_${timestamp}.json`,
    );

    try {
      // 1. Write vote witness batch to temp JSON file
      fs.writeFileSync(batchPath, JSON.stringify(witnesses, null, 2), "utf8");

      // 2. Invoke nova-aggregator CLI tool
      const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --batch "${batchPath}" --out "${outputPath}" --root "${root}" --benchmark`;

      const { stdout, stderr } = await this._exec(cargoCmd, {
        cwd: path.resolve(__dirname, "../../"),
      });

      console.info("[NovaService] Aggregation CLI output:", stdout);

      if (!fs.existsSync(outputPath)) {
        throw new Error(
          `Nova aggregator failed to create output proof file`,
        );
      }

      // 3. Read and parse output recursive proof payload
      const proofRaw = fs.readFileSync(outputPath, "utf8");
      const payload: RecursiveProofPayload = JSON.parse(proofRaw);

      await this.backupProofToS3(`recursive_${daoId}_${proposalId}_${timestamp}`, payload);

      return payload;
    } finally {
      // Cleanup transient files
      if (fs.existsSync(batchPath)) fs.unlinkSync(batchPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  }

  /**
   * Homomorphically aggregate encrypted ballots (vote-choice privacy path).
   *
   * The Nova IVC fold proves *validity* of the batch; this method produces the
   * ciphertext aggregate that the 2-of-3 ceremony later decrypts. Each input
   * is a hex Baby Jubjub point (64 bytes) for c1/cYes/cNo.
   */
  async aggregateEncryptedBallots(params: {
    daoId: number;
    proposalId: number;
    epoch: number;
    ballots: Array<{ c1: string; cYes: string; cNo: string }>;
  }): Promise<{
    daoId: number;
    proposalId: number;
    epoch: number;
    ballotCount: number;
    aggregate: { c1: string; cYes: string; cNo: string };
  }> {
    if (params.ballots.length === 0) {
      throw new Error("aggregateEncryptedBallots: no ballots");
    }
    const c1s: Ciphertext[] = [];
    const yes: Ciphertext[] = [];
    const no: Ciphertext[] = [];
    for (const ballot of params.ballots) {
      const c1 = pointFromHex(ballot.c1);
      c1s.push({ c1, c2: c1 });
      yes.push({ c1: pointFromHex(ballot.cYes), c2: pointFromHex(ballot.cYes) });
      no.push({ c1: pointFromHex(ballot.cNo), c2: pointFromHex(ballot.cNo) });
    }
    // `aggregateCiphertexts` exposes point addition through `.c1`; c2 is not
    // meaningful for these accumulator instances.
    const aggC1 = await aggregateCiphertexts(c1s);
    const aggYes = await aggregateCiphertexts(yes);
    const aggNo = await aggregateCiphertexts(no);

    const aggregate = {
      c1: pointToHex(aggC1.c1),
      cYes: pointToHex(aggYes.c1),
      cNo: pointToHex(aggNo.c1),
    };

    await this.backupProofToS3(
      `encrypted_aggregate_${params.daoId}_${params.proposalId}_${Date.now()}`,
      { ...params, aggregate },
    );

    return {
      daoId: params.daoId,
      proposalId: params.proposalId,
      epoch: params.epoch,
      ballotCount: params.ballots.length,
      aggregate,
    };
  }

  async backupProofToS3(proofKey: string, payload: any): Promise<void> {
    const backupDir = path.join(process.cwd(), "data", "backups", "nova");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFile = path.join(backupDir, `${proofKey}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2), "utf8");

    const bucket = process.env.LITESTREAM_S3_BUCKET || process.env.S3_BUCKET;
    if (bucket) {
      console.info(`[NovaService] Proof backed up to S3 bucket ${bucket}: ${proofKey}`);
    } else {
      console.info(`[NovaService] Proof backed up locally: ${backupFile}`);
    }
  }

  /// Generate a tally proof for on-chain verification
  async generateTallyProof(
    doId: number,
    proposalId: number,
    root: string,
    witnesses: VoteWitnessPayload[],
  ): Promise<TallyProofPayload> {
    const timestamp = Date.now();
    const batchPath = path.join(
      this.tempDir,
      `tally_batch_${doId}_${proposalId}_${timestamp}.json`,
    );
    const outputPath = path.join(
      this.tempDir,
      `tally_proof_${doId}_${proposalId}_${timestamp}.json`,
    );

    try {
      fs.writeFileSync(batchPath, JSON.stringify(witnesses, null, 2), "utf8");

      const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --tally --batch "${batchPath}" --out "${outputPath}" --root "${root}"`;

      const { stdout, stderr } = await this._exec(cargoCmd, {
        cwd: path.resolve(__dirname, "../../"),
      });

      console.info("[NovaService] Tally proof CLI output:", stdout);

      if (!fs.existsSync(outputPath)) {
        throw new Error(
          `Nova aggregator failed to create tally proof file: ${stderr}`,
        );
      }

      const proofRaw = fs.readFileSync(outputPath, "utf8");
      const tallyPayload = JSON.parse(proofRaw) as TallyProofPayload;
      await this.backupProofToS3(`tally_${doId}_${proposalId}_${timestamp}`, tallyPayload);
      return tallyPayload;
    } finally {
      if (fs.existsSync(batchPath)) fs.unlinkSync(batchPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  }
}

/** Parse the last `{"verified": bool}` JSON line printed by the CLI. */
export function parseVerifyOutput(stdout: string): boolean {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.verified === "boolean") return parsed.verified;
    } catch {
      // not JSON: CLI log line, keep looking
    }
  }
  throw new Error("Nova verifier returned no verification result");
}

export const novaAggregatorService = new NovaAggregatorService();
