/**
 * Dedicated worker for Groth16 proof generation (#92).
 *
 * Proving used to run on the main thread. That is the worst place for it: the
 * witness holds the voter's identity secret and candidate choice, and a
 * multi-second BigInt computation on the main thread is observable from the
 * same context — it blocks rendering, so anything able to measure frame
 * pacing or event-loop latency gets a timing trace of the proof for free,
 * without needing `performance.now()` at all.
 *
 * Moving it here gives proving its own event loop and its own global scope.
 * A script on the page can no longer read the worker's memory, and the
 * main-thread stalls that leaked the trace disappear.
 *
 * The private inputs cross the boundary once, in the request message, and the
 * worker keeps nothing after it replies: `postMessage` structured-clones the
 * payload, so the copy the worker holds is dropped when the handler returns.
 *
 * Timing is masked by the caller, around the whole prover selection, so this
 * worker does not pad: two layers of padding would compound without hiding
 * anything the outer one does not already cover.
 */

import { groth16 } from "snarkjs";

export interface ProofRequest {
  id: string;
  input: Record<string, unknown>;
  wasm: ArrayBuffer | string;
  zkey: ArrayBuffer | string;
}

export interface ProofResponse {
  id: string;
  ok: boolean;
  proof?: unknown;
  publicSignals?: unknown;
  error?: string;
}

async function prove(req: ProofRequest): Promise<ProofResponse> {
  try {
    const wasm = req.wasm instanceof ArrayBuffer ? new Uint8Array(req.wasm) : req.wasm;
    const zkey = req.zkey instanceof ArrayBuffer ? new Uint8Array(req.zkey) : req.zkey;

    const { proof, publicSignals } = await groth16.fullProve(req.input, wasm, zkey);
    return { id: req.id, ok: true, proof, publicSignals };
  } catch (err) {
    // Report only that proving failed. The message from snarkjs can name the
    // constraint that was not satisfied, which is a statement about the
    // witness — that is, about the voter.
    return { id: req.id, ok: false, error: "Proof generation failed" };
  }
}

self.onmessage = async (e: MessageEvent<ProofRequest>) => {
  const response = await prove(e.data);
  (self as unknown as Worker).postMessage(response);
};
