/**
 * Onboarding funnel drop-off metrics (ZV-108).
 *
 * Privacy-safe by construction: the only thing ever persisted is a single
 * monotonically-increasing counter per step. There is no session id, user
 * id, or timestamp-per-event — nothing that could be joined across steps to
 * reconstruct an individual's path through onboarding. Drop-off at a step
 * is derived by comparing the counter at that step to the counter at the
 * step before it.
 */

import type { Kysely } from "kysely";
import type { DB } from "../generated/db-types.js";

/**
 * Funnel steps, in the order a member progresses through them. "explore"
 * is a parallel branch (progressive onboarding lets a member browse
 * read-only without ever creating a secret), so it's reported separately
 * rather than folded into the main drop-off chain.
 */
export const ONBOARDING_FUNNEL_STEPS = [
  "registration_started",
  "explore_readonly_selected",
  "secret_created",
  "backup_viewed",
  "backup_verification_started",
  "backup_verification_passed",
  "registration_completed",
] as const;

export type OnboardingFunnelStep = (typeof ONBOARDING_FUNNEL_STEPS)[number];

const STEP_SET: ReadonlySet<string> = new Set(ONBOARDING_FUNNEL_STEPS);

export function isOnboardingFunnelStep(
  value: unknown,
): value is OnboardingFunnelStep {
  return typeof value === "string" && STEP_SET.has(value);
}

export interface OnboardingFunnelDeps {
  kysely: Kysely<DB>;
}

let deps: OnboardingFunnelDeps | null = null;

export function initOnboardingFunnel(d: OnboardingFunnelDeps): void {
  deps = d;
}

function getDeps(): OnboardingFunnelDeps {
  if (!deps) {
    throw new Error(
      "onboardingFunnel: initOnboardingFunnel() must be called before use",
    );
  }
  return deps;
}

/** Record that one more client reached `step`. Fire-and-forget by callers. */
export async function recordFunnelStep(
  step: OnboardingFunnelStep,
): Promise<void> {
  const { kysely } = getDeps();
  const now = new Date().toISOString();

  await kysely
    .insertInto("onboarding_funnel_counts")
    .values({ step, count: 1, updated_at: now })
    .onConflict((oc) =>
      oc.column("step").doUpdateSet((eb) => ({
        count: eb("onboarding_funnel_counts.count", "+", 1),
        updated_at: now,
      })),
    )
    .execute();
}

export interface FunnelStepSummary {
  step: OnboardingFunnelStep;
  count: number;
  /**
   * How many fewer clients reached this step than the previous one in the
   * main chain (never computed for "explore_readonly_selected", which is a
   * parallel branch off of "registration_started", not a drop-off step).
   */
  droppedFromPrevious: number | null;
}

/** Aggregate funnel counts, in step order, with per-step drop-off. */
export async function getFunnelSummary(): Promise<FunnelStepSummary[]> {
  const { kysely } = getDeps();
  const rows = await kysely
    .selectFrom("onboarding_funnel_counts")
    .select(["step", "count"])
    .execute();

  const countsByStep = new Map<string, number>();
  for (const row of rows) {
    if (isOnboardingFunnelStep(row.step)) {
      countsByStep.set(row.step, Number(row.count));
    }
  }

  let previousChainCount: number | null = null;
  return ONBOARDING_FUNNEL_STEPS.map((step) => {
    const count = countsByStep.get(step) ?? 0;
    const isParallelBranch = step === "explore_readonly_selected";

    const droppedFromPrevious =
      isParallelBranch || previousChainCount === null
        ? null
        : Math.max(0, previousChainCount - count);

    if (!isParallelBranch) previousChainCount = count;

    return { step, count, droppedFromPrevious };
  });
}
