# SPIKE-128: Private Voter Notifications

## Decision

Notifications are opt-in, purpose-specific, and delivered through privacy-preserving channels. Election alerts may improve turnout, but timing and recipient membership can reveal participation, so the system must avoid proving that a person voted or belongs to a sensitive cohort.

## Safeguards

- Store notification preferences separately from ballot and voter records.
- Use opaque recipient ids and minimize message contents.
- Batch or jitter delivery where exact timing would leak an event.
- Do not include vote choice, proof material, nullifiers, or sensitive election state in notifications.
- Provide unsubscribe and data-export controls with auditable preference changes.
- Rate-limit retries and retain delivery metadata only for the documented period.

Threat-model tests must cover compromised delivery providers, shared devices, notification previews, timing correlation, and replayed unsubscribe requests.

