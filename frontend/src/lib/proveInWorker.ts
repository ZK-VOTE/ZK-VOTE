/**
 * Runs Groth16 proving in a dedicated worker, falling back to the current
 * thread where workers are unavailable (#92).
 *
 * The worker is created per proof and terminated afterwards rather than
 * pooled. A pooled worker would keep the scope that witnessed the identity
 * secret alive between votes, and proving is slow enough that startup cost is
 * not what matters here.
 */

import type { ProofRequest, ProofResponse } from "../workers/proof.worker";

export interface WorkerProofResult {
  proof: unknown;
  publicSignals: unknown;
}

/** Why a proving worker died, so the UI can offer retry vs fallback (#756). */
export type WorkerCrashKind = "oom" | "exception" | "killed" | "stalled";

export class ProofWorkerError extends Error {
  constructor(
    public readonly kind: WorkerCrashKind,
    message: string,
  ) {
    super(message);
    this.name = "ProofWorkerError";
  }
}

/** Default time without a result before the worker is treated as stalled. */
export const PROOF_STALL_TIMEOUT_MS = 5 * 60 * 1000;

export function classifyWorkerCrash(message: string | undefined): WorkerCrashKind {
  const m = (message ?? "").toLowerCase();
  if (/out of memory|memory access out of bounds|allocation failed|rangeerror.*memory|oom/.test(m)) {
    return "oom";
  }
  if (!m) return "killed";
  return "exception";
}

/** Whether this environment can run the proving worker. */
export function workerAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

export async function proveInWorker(
  input: Record<string, unknown>,
  wasm: string | Uint8Array,
  zkey: string | Uint8Array,
  stallTimeoutMs: number = PROOF_STALL_TIMEOUT_MS,
  /** #728: Merkle depth so the worker can run the OOM preflight. */
  merkleDepth?: number,
): Promise<WorkerProofResult> {
  const worker = new Worker(
    new URL("../workers/proof.worker.ts", import.meta.url),
    { type: "module" },
  );

  const id = crypto.randomUUID();
  const asPayload = (v: string | Uint8Array) =>
    typeof v === "string" ? v : (v.slice().buffer as ArrayBuffer);

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<WorkerProofResult>((resolve, reject) => {
      // A worker killed by the OS or stuck under memory pressure may never
      // fire onerror; without this the UI would spin forever (#756).
      stallTimer = setTimeout(
        () =>
          reject(new ProofWorkerError("stalled", "Proof generation stalled — please retry")),
        stallTimeoutMs,
      );
      worker.onmessage = (e: MessageEvent<ProofResponse>) => {
        const res = e.data;
        if (res.id !== id) return;
        if (res.ok) {
          resolve({ proof: res.proof, publicSignals: res.publicSignals });
        } else {
          // #728: treat oomAborted:true as an OOM crash so the UI can route to
          // server-assisted proving without waiting for a doomed retry.
          const kind = res.oomAborted ? "oom" : classifyWorkerCrash(res.error);
          reject(new ProofWorkerError(kind, res.error ?? "Proof generation failed"));
        }
      };
      worker.onerror = (e: ErrorEvent) => {
        const kind = classifyWorkerCrash(e?.message);
        reject(new ProofWorkerError(kind, e?.message || "Proof generation failed"));
      };
      worker.onmessageerror = () =>
        reject(new ProofWorkerError("exception", "Proof worker sent an unreadable message"));

      const req: ProofRequest = {
        id,
        input,
        wasm: asPayload(wasm),
        zkey: asPayload(zkey),
        merkleDepth,
      };
      worker.postMessage(req);
    });
  } finally {
    clearTimeout(stallTimer);
    // Drop the scope that held the witness rather than leaving it resident.
    worker.terminate();
  }
}
