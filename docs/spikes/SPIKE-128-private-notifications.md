# SPIKE-128: Privacy-preserving voter notifications

## Decision

Use pull notifications and public election broadcasts as the default. Do not expose subscription rows, wallet hashes, delivery state, or per-voter timing. Push and email are opt-in experiments only after a privacy review proves that they do not create a membership oracle.

Existing wallet identifiers must be migrated from unsalted hashes to keyed HMACs held by the service. The public API must never return the identifier, subscription membership, or delivery result. Notification reads are authenticated and return only the caller's own opaque inbox entries.

## Threat model and tests

The privacy test suite must cover offline dictionary attacks, cross-election intersection, fan-out timing, duplicate delivery, token rotation, unsubscribe races, and locale fallbacks. Logs contain event and delivery identifiers but no wallet, email, push token, or notification body containing election-sensitive data.

Turnout experiments measure aggregate completion rates only, with minimum cohort sizes and no per-wallet reporting. Retention follows the data-retention policy; expired inbox entries and delivery metadata are deleted while public chain events remain immutable.

