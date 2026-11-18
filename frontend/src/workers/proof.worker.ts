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
import { selectProvingPlan } from "../lib/devicePreflight";

export interface ProofRequest {
  id: string;
  input: Record<string, unknown>;
  wasm: ArrayBuffer | string;
  zkey: ArrayBuffer | string;
  /** #728: Merkle depth for the circuit being proved (0 → default depth 18).
   *  Used by the OOM preflight to select the correct memory budget. */
  merkleDepth?: number;
}

export interface ProofResponse {
  id: string;
  ok: boolean;
  proof?: unknown;
  publicSignals?: unknown;
  error?: string;
  /** #728: Set to true when the request was aborted by the OOM preflight
   *  before any proving work was done. The caller should reroute to a
   *  server-assisted proving path or notify the user to use a desktop
   *  browser. No voter-identifying information is included. */
  oomAborted?: boolean;
}

// Use the same depth-to-peak budget and headroom as the page provisioner.
// A caller cannot bypass the gate by posting directly to the worker.
const DEFAULT_DEPTH = 18;

function verifyWasm(wasm: Uint8Array | string): boolean {
  if (typeof wasm === "string") return true;
  if (wasm.length < 4) return false;
  return wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d;
}

async function prove(req: ProofRequest): Promise<ProofResponse> {
  // #728: OOM preflight — abort before attempting a prove we cannot finish.
  const depth = req.merkleDepth ?? DEFAULT_DEPTH;
  const plan = selectProvingPlan(depth, {
    navigator: self.navigator as Navigator & { deviceMemory?: number },
    workerAvailable: true,
    rustAvailable: false,
  });
  if (plan.route === "unavailable") {
    return {
      id: req.id,
      ok: false,
      oomAborted: true,
      error: plan.reason ?? "This device cannot safely generate this election proof.",
    };
  }

  try {
    const wasm = req.wasm instanceof ArrayBuffer ? new Uint8Array(req.wasm) : req.wasm;
    const zkey = req.zkey instanceof ArrayBuffer ? new Uint8Array(req.zkey) : req.zkey;

    if (!verifyWasm(wasm)) {
      return { id: req.id, ok: false, error: "Invalid WASM binary: magic header mismatch" };
    }

    const { proof, publicSignals } = await groth16.fullProve(req.input as unknown as import("snarkjs").CircuitSignals, wasm as string, zkey as string);
    return { id: req.id, ok: true, proof, publicSignals };
  } catch (err) {
    // #728: distinguish OOM kills (Safari/Firefox raise RangeError or a
    // generic Error whose message contains "memory" or "allocation") from
    // constraint-satisfaction failures. Return oomAborted:true so the caller
    // can offer the server-assisted path rather than a bare error screen.
    const msg = err instanceof Error ? err.message : "";
    const isLikelyOom =
      err instanceof RangeError ||
      /out of memory|allocation failed|memory access/i.test(msg);

    if (isLikelyOom) {
      return {
        id: req.id,
        ok: false,
        oomAborted: true,
        error: "Proof generation ran out of memory. Try a desktop browser or server-assisted proving.",
      };
    }

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
