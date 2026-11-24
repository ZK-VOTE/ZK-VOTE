# SPIKE-125: Supply-chain response

## Decision

Use one inventory and one audit policy for every package manager and Cargo workspace. The repository treats the lockfile that CI installs as authoritative; a second lockfile for the same workspace is drift and must be removed or regenerated in the same change.

Every dependency is classified as `patch-safe`, `proof-sensitive`, or `ceremony-linked`. Overrides require an owner, a reason, the affected parity checks, and a review date. `npm audit fix` is never run directly against proof-sensitive dependencies.

## Operating procedure

1. Record the advisory, affected manifest, owner, and deployment deadline in the security issue.
2. Generate an upgrade diff without changing the lockfile, then run package tests, circuit known-answer tests, rebuild-compare checks, and the differential proof corpus.
3. Patch-safe updates may merge after CI. Proof-sensitive updates require a maintainer sign-off on parity results. Ceremony-linked updates require a new ceremony plan and are tracked as an exception.
4. Critical advisories target a 24-hour patched deployment or a documented compensating control. Exceptions expire after 30 days.

CI must audit root, backend, frontend, circuits, and Cargo independently, report the manifest and owner for every finding, and fail on unresolved high/critical findings unless an unexpired exception is present.

## Required records

The dependency inventory must list each manifest, package manager, lockfile, override, owner, safety class, parity command, and review date. The inventory is reviewed monthly and after every runtime or proving-toolchain upgrade.

