# SPIKE-132: Safe Amount and Address Forms

## Decision

Validate at the boundary and again before signing. Inputs are parsed into bounded domain values rather than passed through as strings. Errors identify the field, accepted format, and next action.

## Shared rules

- Stellar addresses must pass the SDK public-key validator and are normalized before comparison.
- Amounts must be decimal strings with an explicit maximum precision and a positive, bounded stroop value.
- Contract IDs, asset codes, issuers, and memo fields have length limits before any RPC or proof work.
- Submit controls remain disabled while validation or proving is pending.
- Server and contract errors are mapped to the same field-level error vocabulary.

## Required test cases

Cover empty values, whitespace, Unicode confusables, scientific notation, negative and zero amounts, precision overflow, integer overflow, invalid addresses, wrong-network addresses, duplicate submissions, and stale form state. Tests must assert that invalid input never reaches transaction construction or proving.

