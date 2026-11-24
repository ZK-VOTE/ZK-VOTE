/**
 * Onboarding funnel instrumentation client (ZV-108).
 *
 * Privacy-safe by construction: this only ever POSTs a bare step name, with
 * no session id, wallet address, secret, or mnemonic. The backend stores a
 * single aggregate counter per step (see backend/src/services/
 * onboardingFunnel.ts) — nothing here could be used to reconstruct any one
 * member's path through onboarding.
 */

export type OnboardingFunnelStep =
  | "registration_started"
  | "explore_readonly_selected"
  | "secret_created"
  | "backup_viewed"
  | "backup_verification_started"
  | "backup_verification_passed"
  | "registration_completed";

/** Fire-and-forget: never throws, never blocks the caller's flow. */
export function trackOnboardingStep(step: OnboardingFunnelStep): void {
  try {
    fetch("/onboarding/funnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step }),
    }).catch(() => {
      // Telemetry is best-effort; a dropped beacon must never surface to the user.
    });
  } catch {
    // Same as above — e.g. `fetch` unavailable in a non-browser test runner.
  }
}
