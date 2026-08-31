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

  /**
   * Allows tests to inject a mock exec function to avoid spawning cargo.
   */
  _setExecForTest(mockFn: typeof execAsync): void {
    this._exec = mockFn;
  }

  /**
   * Aggregates a batch of vote witnesses off-chain into a single Nova recursive proof payload
   */
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

      const { stdout } = await this._exec(cargoCmd, {
        cwd: path.resolve(process.cwd(), ".."),
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

      return payload;
    } finally {
      // Cleanup transient files
      if (fs.existsSync(batchPath)) fs.unlinkSync(batchPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  }

  /**
   * Verifies a previously generated recursive proof by invoking the CLI --verify mode.
   * Returns { verified: true } on exit code 0, { verified: false } on exit code 1.
   * Never throws — returns { verified: false } on any error.
   */
  async verifyProof(
    payload: RecursiveProofPayload,
  ): Promise<{ verified: boolean }> {
    const timestamp = Date.now();
    const proofPath = path.join(this.tempDir, `verify_${timestamp}.json`);

    try {
      fs.writeFileSync(proofPath, JSON.stringify(payload, null, 2), "utf8");

      const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --verify "${proofPath}"`;

      try {
        const { stdout } = await this._exec(cargoCmd, {
          cwd: path.resolve(process.cwd(), ".."),
        });
        // Exit code 0 → stdout contains {"verified":true}
        const result = JSON.parse(stdout.trim());
        return { verified: result.verified === true };
      } catch (err: any) {
        // execAsync rejects on non-zero exit code
        // exit code 1 → {"verified":false} on stdout
        if (err.stdout) {
          try {
            const result = JSON.parse(err.stdout.trim());
            if (typeof result.verified === "boolean") {
              return { verified: result.verified };
            }
          } catch {
            // stdout not parseable — fall through to false
          }
        }
        // exit code 2 or any other unexpected error
        return { verified: false };
      }
    } finally {
      if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
    }
  }
}

export const novaAggregatorService = new NovaAggregatorService();
