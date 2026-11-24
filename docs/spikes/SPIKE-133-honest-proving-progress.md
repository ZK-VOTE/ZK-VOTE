# SPIKE-133: Honest Proving Progress

## Decision

Proving progress is phase-based, not a fabricated percentage. The UI reports what is known, preserves elapsed time, and distinguishes local computation from submission and confirmation.

## State model

`idle -> preparing -> proving -> packaging -> submitting -> confirming -> complete` with a terminal `failed` state. A retry starts a new attempt and retains the previous failure reason.

During `proving`, show elapsed time and a truthful message such as “Generating your proof locally”. Show an indeterminate progress indicator unless the prover exposes a measured phase boundary. Never imply completion from a timer.

## Accessibility and recovery

The current phase is announced in an `aria-live="polite"` region, remains visible without color, and respects reduced motion. The UI provides cancel/retry actions where safe, explains whether a proof was discarded or retained, and does not allow navigation to silently lose an in-flight operation.

## Acceptance checks

Test slow proving, worker failure, tab visibility changes, cancellation, retry, reduced motion, and screen-reader announcements. A screenshot or interaction regression must verify that the phase, elapsed time, and next action remain unambiguous.

