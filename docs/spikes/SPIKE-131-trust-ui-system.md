# SPIKE-131: Trust-Critical UI System

## Decision

Use the existing `frontend/src/components/ui` primitives as the only source of truth for interactive chrome. Add semantic status patterns and design tokens around those primitives before adding new product surfaces.

## Inventory and contracts

| Concern | Canonical contract |
| --- | --- |
| Action controls | `Button` variants with visible focus, disabled, pending, and destructive states |
| Status | `Badge` or `Alert` with text; color is supplementary, never the only signal |
| Async states | loading, empty, error, degraded, and conflict states must be explicit |
| Legitimacy | quorum, provenance, freshness, and dispute data use labelled rows with timestamps |
| Themes | CSS variables in `index.css`; light, dark, forced-colors, and reduced-motion are tested |

Existing raw color buttons and color-only indicators are migration targets. New surfaces must not introduce one-off status markup or direct utility colors for semantic states.

## Review gate

Every UI PR adding a surface must include:

1. A state matrix covering loading, success, empty, error, degraded, and conflict.
2. Keyboard and screen-reader checks for every action and status.
3. Contrast verification for light, dark, and forced-colors modes.
4. Reduced-motion behavior for transitions and proving progress.
5. A screenshot regression for changed trust-critical states.

## Implementation order

1. Replace color-only vote/result indicators with labelled status components.
2. Migrate raw vote buttons and banners to the shared primitives.
3. Add visual regression coverage for the migrated states.
4. Require the review gate in frontend pull requests.

