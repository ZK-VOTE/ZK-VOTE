/**
 * Budget Tracker - Separate vote and query budgets (#710)
 *
 * Prevents polling from consuming vote budget.
 * Works alongside rateLimit.ts for operation-specific limits.
 */

export interface OperationBudgets {
  votes: number;
  queries: number;
}

export const DEFAULT_BUDGETS: OperationBudgets = {
  votes: 10,  // 10 votes per window
  queries: 60, // 60 queries per window (polling won't lock out voting)
};

const budgets = new Map<string, { votes: number; queries: number; resetAt: number }>();

/**
 * Check budget for specific operation type.
 */
export function checkBudget(
  key: string,
  operation: "vote" | "query",
  windowMs: number = 60_000,
  limits: OperationBudgets = DEFAULT_BUDGETS,
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  let budget = budgets.get(key);

  // Initialize or reset
  if (!budget || now >= budget.resetAt) {
    budget = {
      votes: limits.votes,
      queries: limits.queries,
      resetAt: now + windowMs,
    };
    budgets.set(key, budget);
  }

  const remaining = operation === "vote" ? budget.votes : budget.queries;

  if (remaining <= 0) {
    return { allowed: false, remaining: 0 };
  }

  // Consume
  if (operation === "vote") {
    budget.votes--;
  } else {
    budget.queries--;
  }

  return { allowed: true, remaining: remaining - 1 };
}

/**
 * Clear budget for key (testing/admin).
 */
export function clearBudget(key: string): void {
  budgets.delete(key);
}
