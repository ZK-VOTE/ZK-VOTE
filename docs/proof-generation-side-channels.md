# Side channels in browser proof generation

Evaluation and mitigations for issue #92.

## What the exposure actually is

The witness for a vote proof holds the voter's identity secret, their Merkle
path, and the candidate index. Proving happens in the voter's browser, so
anything that can observe the proving process is observing a computation over
those values.

`snarkjs` proves using JavaScript `BigInt` arithmetic. That arithmetic is not
constant time:

- **Scalar multiplication** walks the scalar's bits, so its cost tracks the bit
  pattern of the value being multiplied.
- **`BigInt` operations** are variable-time by construction — V8 sizes and
  loops over limbs according to operand magnitude. There is no constant-time
  path available to a JS caller.
- **FFT / multi-scalar multiplication**, which dominate Groth16 proving cost,
  are both witness dependent.

So proof *duration* is correlated with private inputs. This is not a
theoretical channel: it needs no special access, only a way to observe how long
proving took.

## The finding that changed the fix

The issue was written on the assumption that proving already ran in
`frontend/src/workers/proof.worker.ts`. It did not — that file did not exist,
and there were no web workers in the frontend at all. `groth16.fullProve()` ran
**on the main thread**.

That is materially worse than the issue assumed. A multi-second `BigInt`
computation on the main thread blocks rendering, so an attacker does not need
`performance.now()` to time it: frame pacing, `requestAnimationFrame` gaps, or
plain event-loop latency give a timing trace of the proof for free, from any
script sharing the page.

So the work was to build the isolation, not to harden it.

## Mitigations implemented

**Dedicated worker** (`src/workers/proof.worker.ts`). Proving gets its own
event loop and global scope. The main-thread stalls that leaked a trace are
gone, and page scripts cannot reach the worker's memory. The worker is created
per proof and terminated after, so the scope that saw the identity secret is
not kept alive between votes. Its error replies say only that proving failed —
a `snarkjs` message can name the unsatisfied constraint, which is a statement
about the witness.

**Timing masking** (`src/lib/proofTiming.ts`). Observable duration is
quantised up to a fixed grid and then padded with CSPRNG jitter:

- Quantisation alone leaks over many samples, because which side of a boundary
  an input falls on is itself information.
- Jitter alone is removable by averaging repeated observations.
- Together, an observer has to beat the grid *and* the noise.

The result is withheld until the padding elapses — resolving early and padding
after would defeat the point, since the caller observes resolution. Failures
are padded identically, so a rejected witness is not identifiable by failing
faster than a real proof completes. Jitter is drawn from
`crypto.getRandomValues`, not `Math.random`, whose sequence is predictable from
prior outputs and could therefore be subtracted back out.

**Cross-origin isolation** (`vite.config.ts`). COOP `same-origin` + COEP
`require-corp` make the page `crossOriginIsolated`, which is what puts it in
its own process and coarsens cross-origin timers. `isCrossOriginIsolated()`
surfaces the state so the app can warn rather than silently prove in a weaker
environment.

> **Deployment requirement.** The Vite config sets these headers for the dev
> server and preview only. Production must send the same two headers from
> whatever serves the built assets, or isolation is silently lost. COEP
> `require-corp` also requires every cross-origin subresource to opt in via
> CORP/CORS — that is the cost of isolation and it needs checking against any
> third-party asset the app loads.

## Measured variance

`src/lib/proveInWorker.test.ts` asserts the property the acceptance criterion
is really after: proving costs spanning most of a quantum land in a single
observed bucket, and the spread an observer sees is strictly smaller than the
spread of the true costs. It uses simulated costs so it runs in CI in
milliseconds; the assertion is about the masking, which is the part that can
regress.

## What is *not* addressed

- **`snarkjs` is still not constant time.** The mitigations bound what an
  observer of wall-clock duration learns; they do not make the underlying
  arithmetic uniform. A constant-time prover means replacing snarkjs's field
  arithmetic, not configuring it.
- **`rapidsnark`** was considered and not adopted. It is faster, but speed is
  not the property in question, and its WASM build makes no constant-time
  claim — adopting it would change the performance profile without closing the
  channel.
- **Power, cache, and branch-level channels** are out of reach of anything the
  page can do about them.
- **Quantisation costs latency.** Every proof is padded up to the next grid
  step, so the fastest proofs get slower. That is the deliberate trade: the
  alternative is letting the fast ones be identifiable.
