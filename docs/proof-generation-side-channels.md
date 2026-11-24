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

## Measurement plan (SPIKE-029 / #714)

The current implementation provides timing masking infrastructure but has NOT
been validated against real-world distributions. SPIKE-029 requires:

### Required measurements (acceptance criteria)

1. **Duration distributions per (circuit, depth, device)**
   - Collect 500+ samples per configuration
   - Segment by: vote/claim circuit, depth (10/15/20), device class
   - Record both raw and masked durations
   - Publish distributions in `RUST_WASM_WITNESS_BENCHMARK.md`

2. **Choice indistinguishability**
   - Train classifiers to predict vote choice from timing
   - Target: AUC ~0.5 (random chance) with masking enabled
   - Validate that `TIMING_QUANTUM_MS` / `MAX_JITTER_MS` are sufficient
   - Test across multiple candidate positions

3. **Depth distinguishability**
   - Measure whether depth (10/15/20) leaks through masked timing
   - Document if depth limits are needed for indistinguishability

4. **Claim vs vote proof timing**
   - Test whether claim proofs are distinguishable from vote proofs
   - `generateClaimProof` timing compared to `proveVote`

5. **Worker fallback analysis**
   - Measure worker-unavailable rate across browsers/devices
   - Profile main-thread fallback timing characteristics
   - Document policy: disable fallback or harden it equally

6. **Mobile OOM/jank limits**
   - Test low-end mobile (≤4GB RAM) at each depth
   - Record OOM rates, ANR/jank frequency
   - Set maximum supported depth per device class

### Measurement infrastructure

Available in `proofTiming.ts`:

```typescript
// Enable measurement mode (dev/test only)
enableTimingMeasurement();

// Generate proofs (timing samples auto-recorded)
await withMaskedTimingAndMeasurement(
  () => proveVote(...),
  { circuitType: 'vote', depth: 20 }
);

// Analyze collected samples
const samples = getTimingSamples();
const stats = computeTimingStatistics(samples, 
  s => s.circuitType === 'vote' && s.depth === 20
);

disableTimingMeasurement();
```

### Device class timing budgets

Placeholder values in `TIMING_BUDGETS_MS` need validation:

| Device | Depth 10 | Depth 15 | Depth 20 | Claim |
|--------|----------|----------|----------|-------|
| Desktop | 1500ms | 2500ms | 4000ms | 800ms |
| Mobile | 3000ms | 5000ms | 8000ms | 1500ms |
| Low-end | 5000ms | 9000ms | 15000ms | 2500ms |

**Action required:** Run measurement campaign, update budgets to P95 values,
validate masking effectiveness (AUC test).

### Open questions

- Is `TIMING_QUANTUM_MS = 250ms` sufficient across all depths?
- Should quantum be adaptive per circuit/depth/device?
- What is the mobile OOM rate at depth 20? Is depth 15 the safe max?
- Worker availability: 95%? 50%? Varies by browser?

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
