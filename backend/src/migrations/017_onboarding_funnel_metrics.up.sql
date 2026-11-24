-- ZV-108: Onboarding backup verification and progressive secret setup
--
-- Funnel drop-off metrics for the voter-registration/onboarding flow.
-- Only an aggregate count per step is stored — never a per-session or
-- per-user row — so the server can never reconstruct an individual's path
-- through onboarding. Drop-off at a step is derived by comparing counts
-- between consecutive steps (see backend/src/services/onboardingFunnel.ts).

CREATE TABLE IF NOT EXISTS onboarding_funnel_counts (
  step TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
