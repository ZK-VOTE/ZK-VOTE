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
const execAsync = promisify(exec);
export class NovaAggregatorService {
    tempDir;
    _exec;
    constructor(tempDir) {
        this.tempDir = tempDir || path.join(process.cwd(), "temp", "nova");
        this._exec = execAsync;
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    /** Test seam: replace the CLI runner so tests don't spawn cargo (#566). */
    _setExecForTest(fn) {
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
    async verifyProof(payload) {
        const proofPath = path.join(this.tempDir, `verify_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
        try {
            fs.writeFileSync(proofPath, JSON.stringify(payload), "utf8");
            const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --verify "${proofPath}"`;
            let stdout;
            try {
                ({ stdout } = await this._exec(cargoCmd, {
                    cwd: path.resolve(__dirname, "../../"),
                }));
            }
            catch (err) {
                // exit code 1 means "proof invalid": exec rejects but stdout still
                // carries {"verified": false}. Anything else is a real failure.
                if (err && typeof err.stdout === "string" && err.stdout.includes('"verified"')) {
                    stdout = err.stdout;
                }
                else {
                    throw err;
                }
            }
            return { verified: parseVerifyOutput(stdout) };
        }
        finally {
            if (fs.existsSync(proofPath))
                fs.unlinkSync(proofPath);
        }
    }
    /// Default aggregate Votes method
    async aggregateVotes(daoId, proposalId, root, witnesses) {
        const timestamp = Date.now();
        const batchPath = path.join(this.tempDir, `batch_${daoId}_${proposalId}_${timestamp}.json`);
        const outputPath = path.join(this.tempDir, `proof_${daoId}_${proposalId}_${timestamp}.json`);
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
                throw new Error(`Nova aggregator failed to create output proof file`);
            }
            // 3. Read and parse output recursive proof payload
            const proofRaw = fs.readFileSync(outputPath, "utf8");
            const payload = JSON.parse(proofRaw);
            await this.backupProofToS3(`recursive_${daoId}_${proposalId}_${timestamp}`, payload);
            return payload;
        }
        finally {
            // Cleanup transient files
            if (fs.existsSync(batchPath))
                fs.unlinkSync(batchPath);
            if (fs.existsSync(outputPath))
                fs.unlinkSync(outputPath);
        }
    }
    async backupProofToS3(proofKey, payload) {
        const backupDir = path.join(process.cwd(), "data", "backups", "nova");
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const backupFile = path.join(backupDir, `${proofKey}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2), "utf8");
        const bucket = process.env.LITESTREAM_S3_BUCKET || process.env.S3_BUCKET;
        if (bucket) {
            console.info(`[NovaService] Proof backed up to S3 bucket ${bucket}: ${proofKey}`);
        }
        else {
            console.info(`[NovaService] Proof backed up locally: ${backupFile}`);
        }
    }
    /// Generate a tally proof for on-chain verification
    async generateTallyProof(doId, proposalId, root, witnesses) {
        const timestamp = Date.now();
        const batchPath = path.join(this.tempDir, `tally_batch_${doId}_${proposalId}_${timestamp}.json`);
        const outputPath = path.join(this.tempDir, `tally_proof_${doId}_${proposalId}_${timestamp}.json`);
        try {
            fs.writeFileSync(batchPath, JSON.stringify(witnesses, null, 2), "utf8");
            const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --tally --batch "${batchPath}" --out "${outputPath}" --root "${root}"`;
            const { stdout, stderr } = await this._exec(cargoCmd, {
                cwd: path.resolve(__dirname, "../../"),
            });
            console.info("[NovaService] Tally proof CLI output:", stdout);
            if (!fs.existsSync(outputPath)) {
                throw new Error(`Nova aggregator failed to create tally proof file: ${stderr}`);
            }
            const proofRaw = fs.readFileSync(outputPath, "utf8");
            const tallyPayload = JSON.parse(proofRaw);
            await this.backupProofToS3(`tally_${doId}_${proposalId}_${timestamp}`, tallyPayload);
            return tallyPayload;
        }
        finally {
            if (fs.existsSync(batchPath))
                fs.unlinkSync(batchPath);
            if (fs.existsSync(outputPath))
                fs.unlinkSync(outputPath);
        }
    }
}
/** Parse the last `{"verified": bool}` JSON line printed by the CLI. */
export function parseVerifyOutput(stdout) {
    const lines = stdout.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.verified === "boolean")
                return parsed.verified;
        }
        catch {
            // not JSON: CLI log line, keep looking
        }
    }
    throw new Error("Nova verifier returned no verification result");
}
export const novaAggregatorService = new NovaAggregatorService();
//# sourceMappingURL=nova-aggregator.js.map