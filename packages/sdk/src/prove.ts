/**
 * Proof generation functions.
 *
 * Proving uses snarkjs Groth16 with real WASM witness calculation and a real
 * proving key loaded through `keys.ts`. There are no placeholder proofs.
 */

import type { CircuitArtifacts } from './keys'
import { assertCircuitReady, getKey } from './keys'
import { poseidonHash, fieldFromBytes, labelToField, DOMAIN_TAGS, BN254_FIELD_MODULUS } from './derive'
import {
  AbortError,
  InvalidInputError,
  ProofGenerationError,
  WorkerUnavailableError,
  type CircuitInputs,
  type ProveOptions
} from './types'

export interface VoteProofParams {
  identitySecret: Uint8Array
  pollId: string
  choice: string
  merkleProof: {
    root: string
    siblings: string[]
    pathIndices: number[]
  }
  /**
   * Which loaded manifest key (by circuit name) this proof is generated
   * against. Defaults to 'vote'. Used to look up the ZV-113
   * registry-compatibility result recorded by loadKeys() - see
   * `assertCircuitReady()` - and to pick the proving artifacts.
   */
  circuitName?: string
  /** Optional circuit inputs. Defaults to legacy fields where possible. */
  daoId?: string
  proposalId?: string
  numCandidates?: number
  salt?: string
  blindingFactor?: string
}

export interface ClaimProofParams {
  identitySecret: Uint8Array
  daoId: string
  membershipProof: {
    root: string
    siblings: string[]
    pathIndices: number[]
  }
  /** Same purpose as `VoteProofParams.circuitName`. Defaults to 'claim'. */
  circuitName?: string
  proposalId?: string
  salt?: string
  voteNullifier?: string
  claimNullifier?: string
}

export interface Proof {
  proof: {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
    curve: string
  }
  publicSignals: string[]
}

/** Options for worker-based proving. */
export interface WorkerProveOptions extends ProveOptions {
  /** Browser-only: URL of a classic script that exposes global `snarkjs`. */
  snarkjsUrl?: string
  /** Optional URL of a prebuilt worker script (overrides the inline worker). */
  workerScriptUrl?: string
  /** Hard timeout for the worker, in milliseconds. Default: 5 minutes. */
  workerTimeoutMs?: number
}

function assertSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    throw new InvalidInputError('Identity secret must be a 32-byte Uint8Array')
  }
}

function assertMerkleProof(proof: { root: string; siblings: string[]; pathIndices: number[] }): void {
  if (!proof || typeof proof.root !== 'string' || proof.root.trim() === '') {
    throw new InvalidInputError('Merkle root is required')
  }
  if (!Array.isArray(proof.siblings) || !Array.isArray(proof.pathIndices)) {
    throw new InvalidInputError('Merkle siblings and pathIndices arrays are required')
  }
  if (proof.siblings.length !== proof.pathIndices.length) {
    throw new InvalidInputError('Merkle siblings and pathIndices must have the same length')
  }
  for (const index of proof.pathIndices) {
    if (index !== 0 && index !== 1) {
      throw new InvalidInputError('Merkle path indices must be 0 or 1')
    }
  }
}

/** Convert a caller value to a decimal BN254 field element string. */
function toFieldString(value: string | number | bigint, label: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new InvalidInputError(`${label} must be a safe integer`)
    return BigInt(value).toString()
  }
  if (typeof value === 'bigint') return (value % BN254_FIELD_MODULUS).toString()
  const trimmed = value.trim()
  if (/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) return (BigInt(trimmed) % BN254_FIELD_MODULUS).toString()
  // Non-numeric labels (e.g. "poll-123") are domain-separated into the field.
  return poseidonHash([DOMAIN_TAGS.NULLIFIER, labelToField(trimmed)]).toString()
}

/** Race a promise against an AbortSignal, cleaning up listeners afterwards. */
function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new AbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/**
 * Generate a proof with explicit artifacts. This is the real snarkjs entry
 * point used by all higher-level APIs and by tests with fixture artifacts.
 */
export async function proveWithArtifacts(
  inputs: CircuitInputs,
  artifacts: CircuitArtifacts,
  options: ProveOptions = {}
): Promise<Proof> {
  if (options.signal?.aborted) throw new AbortError()
  if (!artifacts?.wasm?.byteLength || !artifacts?.zkey?.byteLength) {
    throw new ProofGenerationError('Circuit artifacts are missing or empty')
  }

  try {
    // @ts-ignore - snarkjs ships no TypeScript declarations
    const snarkjs = await import('snarkjs')
    // The bundled ambient declaration only covers groth16.verify; fullProve is
    // a real snarkjs export, so describe it locally instead of widening src/*.d.ts.
    const groth16 = snarkjs.groth16 as unknown as {
      fullProve(inputs: CircuitInputs, wasm: Uint8Array, zkey: Uint8Array): Promise<{
        proof: Proof['proof']
        publicSignals: string[]
      }>
    }
    const result = await withAbort(groth16.fullProve(inputs, artifacts.wasm, artifacts.zkey), options.signal)
    const proof = result.proof as Proof['proof']
    if (proof.protocol !== 'groth16' || proof.curve !== 'bn128') {
      throw new ProofGenerationError('snarkjs produced an unexpected proof format', { proof })
    }
    return { proof, publicSignals: result.publicSignals.map((s) => String(s)) }
  } catch (err) {
    if (err instanceof AbortError || err instanceof ProofGenerationError) throw err
    throw new ProofGenerationError('Groth16 proof generation failed', { cause: err })
  }
}

/**
 * Build the exact circuit input object for `vote.circom` (6 public signals).
 * Exported so callers/tests can inspect the witness inputs.
 */
export function buildVoteCircuitInputs(params: VoteProofParams): CircuitInputs {
  assertSecret(params.identitySecret)
  assertMerkleProof(params.merkleProof)
  if (!params.pollId || !params.choice) throw new InvalidInputError('Poll ID and choice are required')

  const secret = fieldFromBytes(params.identitySecret)
  const daoId = toFieldString(params.daoId ?? params.pollId, 'daoId')
  const proposalId = toFieldString(params.proposalId ?? params.pollId, 'proposalId')
  const voteChoice = toFieldString(params.choice, 'choice')
  const numCandidatesValue = params.numCandidates ?? Number(voteChoice) + 1
  if (!Number.isSafeInteger(numCandidatesValue) || numCandidatesValue <= Number(voteChoice)) {
    throw new InvalidInputError('numCandidates must be greater than the vote choice')
  }
  const salt = params.salt
    ? toFieldString(params.salt, 'salt')
    : poseidonHash([DOMAIN_TAGS.TRAPDOOR, secret]).toString()
  const blindingFactor = params.blindingFactor
    ? toFieldString(params.blindingFactor, 'blindingFactor')
    : poseidonHash([DOMAIN_TAGS.NULLIFIER, secret, salt]).toString()
  const nullifier = poseidonHash([secret, daoId, proposalId]).toString()

  return {
    root: toFieldString(params.merkleProof.root, 'root'),
    nullifier,
    daoId,
    proposalId,
    voteChoice,
    numCandidates: String(numCandidatesValue),
    secret: secret.toString(),
    salt,
    blindingFactor,
    pathElements: params.merkleProof.siblings.map((s) => toFieldString(s, 'sibling')),
    pathIndices: params.merkleProof.pathIndices.map((i) => String(i))
  }
}

/** Build the exact circuit input object for `claim.circom` (5 public signals). */
export function buildClaimCircuitInputs(params: ClaimProofParams): CircuitInputs {
  assertSecret(params.identitySecret)
  assertMerkleProof(params.membershipProof)
  if (!params.daoId) throw new InvalidInputError('DAO ID is required')

  const secret = fieldFromBytes(params.identitySecret)
  const daoId = toFieldString(params.daoId, 'daoId')
  const proposalId = toFieldString(params.proposalId ?? params.daoId, 'proposalId')
  const salt = params.salt
    ? toFieldString(params.salt, 'salt')
    : poseidonHash([DOMAIN_TAGS.TRAPDOOR, secret]).toString()
  const voteNullifier = params.voteNullifier
    ? toFieldString(params.voteNullifier, 'voteNullifier')
    : poseidonHash([secret, daoId, proposalId]).toString()
  const claimNullifier = params.claimNullifier
    ? toFieldString(params.claimNullifier, 'claimNullifier')
    : poseidonHash([secret, daoId, proposalId, DOMAIN_TAGS.CLAIM]).toString()

  return {
    root: toFieldString(params.membershipProof.root, 'root'),
    voteNullifier,
    claimNullifier,
    daoId,
    proposalId,
    secret: secret.toString(),
    salt,
    pathElements: params.membershipProof.siblings.map((s) => toFieldString(s, 'sibling')),
    pathIndices: params.membershipProof.pathIndices.map((i) => String(i))
  }
}

/** Generate a zero-knowledge proof for voting (main thread). */
export async function generateVoteProof(params: VoteProofParams, options: ProveOptions = {}): Promise<Proof> {
  // ZV-113: refuse to prove with a circuit version the registry rejected
  // during loadKeys(). Throws UnsupportedCircuitVersionError if so; a
  // no-op if that circuit was never registry-checked at all.
  assertCircuitReady(options.circuitName ?? params.circuitName ?? 'vote')
  const artifacts = getKey(options.circuitName ?? params.circuitName ?? 'vote')
  return proveWithArtifacts(buildVoteCircuitInputs(params), artifacts, options)
}

/** Generate a zero-knowledge proof for a membership claim (main thread). */
export async function generateClaimProof(params: ClaimProofParams, options: ProveOptions = {}): Promise<Proof> {
  assertCircuitReady(options.circuitName ?? params.circuitName ?? 'claim')
  const artifacts = getKey(options.circuitName ?? params.circuitName ?? 'claim')
  return proveWithArtifacts(buildClaimCircuitInputs(params), artifacts, options)
}

// Node worker_threads source. Runs the same real snarkjs code off the main
// thread; `require` is available because the worker is created with eval:true.
const NODE_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
(async () => {
  try {
    const snarkjs = require(workerData.snarkjsPath);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      workerData.inputs, workerData.wasm, workerData.zkey
    );
    parentPort.postMessage({ ok: true, proof, publicSignals: publicSignals.map(String) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
})();
`

// Browser classic-worker source; snarkjs is loaded from a caller-supplied URL.
const BROWSER_WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { inputs, wasm, zkey, snarkjsUrl } = event.data;
  try {
    importScripts(snarkjsUrl);
    const result = await self.snarkjs.groth16.fullProve(inputs, wasm, zkey);
    self.postMessage({ ok: true, proof: result.proof, publicSignals: result.publicSignals.map(String) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
`

interface WorkerResult {
  ok: boolean
  proof?: Proof['proof']
  publicSignals?: string[]
  error?: string
}

/** feature-detect a usable worker runtime. */
function detectWorkerRuntime(options: WorkerProveOptions): 'node' | 'browser' | null {
  if (options.workerScriptUrl) return typeof Worker !== 'undefined' ? 'browser' : null
  if (typeof process !== 'undefined' && (process as any).versions?.node) return 'node'
  if (typeof Worker !== 'undefined' && typeof options.snarkjsUrl === 'string') return 'browser'
  return null
}

/** Run real proving in a worker. Falls back to main thread only if no worker exists. */
async function proveInWorker(inputs: CircuitInputs, artifacts: CircuitArtifacts, options: WorkerProveOptions): Promise<Proof> {
  const runtime = detectWorkerRuntime(options)
  if (!runtime) {
    // Workers are genuinely unavailable in this environment. Never a mock.
    return proveWithArtifacts(inputs, artifacts, options)
  }

  const timeoutMs = options.workerTimeoutMs ?? 5 * 60 * 1000

  if (runtime === 'node') {
    let WorkerCtor: any
    let snarkjsPath = 'snarkjs'
    try {
      // @ts-ignore - dynamic import of a Node builtin; tsup's dts pass uses an older module target
      WorkerCtor = (await import('node:worker_threads')).Worker
      // @ts-ignore - dynamic import of a Node builtin; tsup's dts pass uses an older module target
      const { createRequire } = await import('node:module')
      snarkjsPath = createRequire(process.cwd() + '/').resolve('snarkjs')
    } catch {
      // Worker threads genuinely unavailable: use the main thread, never a mock.
      return proveWithArtifacts(inputs, artifacts, options)
    }

    let worker: any
    try {
      worker = new WorkerCtor(NODE_WORKER_SOURCE, {
        eval: true,
        workerData: { inputs, wasm: artifacts.wasm, zkey: artifacts.zkey, snarkjsPath }
      })
    } catch (err) {
      throw new WorkerUnavailableError('Node worker could not be started', { cause: err })
    }

    try {
      const result = await withAbort(
        new Promise<WorkerResult>((resolve, reject) => {
          const timer = setTimeout(() => reject(new ProofGenerationError('Worker proof generation timed out')), timeoutMs)
          worker.once('message', (msg: WorkerResult) => {
            clearTimeout(timer)
            resolve(msg)
          })
          worker.once('error', (err: Error) => {
            clearTimeout(timer)
            reject(new ProofGenerationError('Worker proof generation failed', { cause: err }))
          })
          worker.once('exit', (code: number) => {
            clearTimeout(timer)
            if (code !== 0) reject(new ProofGenerationError(`Worker exited with code ${code}`))
          })
        }),
        options.signal
      )
      return workerResultToProof(result)
    } finally {
      await worker.terminate()
    }
  }

  // Browser worker
  const blob = new Blob([BROWSER_WORKER_SOURCE], { type: 'application/javascript' })
  const url = options.workerScriptUrl ?? URL.createObjectURL(blob)
  const worker = new Worker(url)
  try {
    const result = await withAbort(
      new Promise<WorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ProofGenerationError('Worker proof generation timed out')), timeoutMs)
        worker.onmessage = (event: MessageEvent<WorkerResult>) => {
          clearTimeout(timer)
          resolve(event.data)
        }
        worker.onerror = (event: ErrorEvent) => {
          clearTimeout(timer)
          reject(new ProofGenerationError('Worker proof generation failed', { cause: event.message }))
        }
        worker.postMessage({ inputs, wasm: artifacts.wasm, zkey: artifacts.zkey, snarkjsUrl: options.snarkjsUrl })
      }),
      options.signal
    )
    return workerResultToProof(result)
  } finally {
    worker.terminate()
    if (!options.workerScriptUrl) URL.revokeObjectURL(url)
  }
}

function workerResultToProof(result: WorkerResult): Proof {
  if (!result?.ok || !result.proof || !result.publicSignals) {
    throw new ProofGenerationError('Worker did not produce a proof', { error: result?.error })
  }
  if (result.proof.protocol !== 'groth16' || result.proof.curve !== 'bn128') {
    throw new ProofGenerationError('Worker produced an unexpected proof format')
  }
  return { proof: result.proof, publicSignals: result.publicSignals }
}

/**
 * Generate a vote proof in a worker thread (or a browser Web Worker) so the
 * main thread stays responsive during witness calculation.
 */
export async function generateVoteProofInWorker(params: VoteProofParams, options: WorkerProveOptions = {}): Promise<Proof> {
  assertCircuitReady(options.circuitName ?? params.circuitName ?? 'vote')
  const artifacts = getKey(options.circuitName ?? params.circuitName ?? 'vote')
  return proveInWorker(buildVoteCircuitInputs(params), artifacts, options)
}
