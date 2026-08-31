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

/** Whether this environment can run the proving worker. */
export function workerAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

export async function proveInWorker(
  input: Record<string, unknown>,
  wasm: string | Uint8Array,
  zkey: string | Uint8Array,
): Promise<WorkerProofResult> {
  const worker = new Worker(
    new URL("../workers/proof.worker.ts", import.meta.url),
    { type: "module" },
  );

  const id = crypto.randomUUID();
  const asPayload = (v: string | Uint8Array) =>
    typeof v === "string" ? v : (v.slice().buffer as ArrayBuffer);

  try {
    return await new Promise<WorkerProofResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ProofResponse>) => {
        const res = e.data;
        if (res.id !== id) return;
        if (res.ok) {
          resolve({ proof: res.proof, publicSignals: res.publicSignals });
        } else {
          reject(new Error(res.error ?? "Proof generation failed"));
        }
      };
      worker.onerror = () => reject(new Error("Proof generation failed"));

      const req: ProofRequest = {
        id,
        input,
        wasm: asPayload(wasm),
        zkey: asPayload(zkey),
      };
      worker.postMessage(req);
    });
  } finally {
    // Drop the scope that held the witness rather than leaving it resident.
    worker.terminate();
  }
}
