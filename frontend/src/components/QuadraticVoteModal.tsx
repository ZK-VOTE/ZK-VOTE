// Quadratic Vote Modal (issue #50)
//
// Lets a member allocate voice credits across the proposals in a quadratic
// voting round. Each slider adds a quadratic cost (voiceCredits^2); the running
// total of sum(voiceCredits^2) is shown against the fixed budget. Submitting
// hands the allocations to the caller, which generates the (slow) ZK proof via
// `lib/qvoter.ts` and casts the ballot.

import { useMemo, useState } from "react";

import {
  calculateQuadraticCost,
  QV_MAX_BUDGET,
  QV_MAX_CREDITS,
  type QvAllocation,
} from "../lib/qvoter";

export interface QvProposalOption {
  id: string; // decimal proposal id
  title: string;
}

interface QuadraticVoteModalProps {
  isOpen: boolean;
  roundTitle: string;
  proposals: QvProposalOption[];
  budget?: number;
  onClose: () => void;
  onSubmit: (allocations: QvAllocation[]) => void | Promise<void>;
  isSubmitting?: boolean;
}

export default function QuadraticVoteModal({
  isOpen,
  roundTitle,
  proposals,
  budget = QV_MAX_BUDGET,
  onClose,
  onSubmit,
  isSubmitting = false,
}: QuadraticVoteModalProps) {
  const [credits, setCredits] = useState<Record<string, number>>(() =>
    Object.fromEntries(proposals.map((p) => [p.id, 0])),
  );

  const allocations: QvAllocation[] = useMemo(
    () =>
      proposals.map((p) => ({
        proposalId: p.id,
        voiceCredits: credits[p.id] ?? 0,
      })),
    [proposals, credits],
  );

  const cost = useMemo(
    () => calculateQuadraticCost(allocations, budget),
    [allocations, budget],
  );

  if (!isOpen) {
    return null;
  }

  const setCredit = (proposalId: string, value: number) => {
    setCredits((prev) => ({ ...prev, [proposalId]: value }));
  };

  const canSubmit =
    cost.withinBudget && cost.withinRange && cost.totalCreditsSpent > 0 && !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Quadratic Vote
            </h2>
            <p className="text-sm text-muted-foreground">{roundTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Allocate voice credits across proposals. Cost grows quadratically: a
          proposal set to <span className="font-medium">n</span> votes costs{" "}
          <span className="font-medium">n²</span> credits.
        </p>

        <div className="space-y-4">
          {proposals.map((p) => {
            const votes = credits[p.id] ?? 0;
            return (
              <div key={p.id} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-foreground">{p.title}</span>
                  <span className="text-sm text-muted-foreground">
                    {votes} {votes === 1 ? "vote" : "votes"} · {votes * votes}{" "}
                    credits
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={QV_MAX_CREDITS}
                  step={1}
                  value={votes}
                  disabled={isSubmitting}
                  onChange={(e) => setCredit(p.id, Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            );
          })}
        </div>

        <div className="mt-5 space-y-1 rounded-lg bg-muted/40 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Credits spent (Σ n²)</span>
            <span
              className={
                cost.withinBudget
                  ? "font-medium text-foreground"
                  : "font-medium text-destructive"
              }
            >
              {cost.totalCreditsSpent} / {budget}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-medium text-foreground">
              {Math.max(cost.remaining, 0)}
            </span>
          </div>
        </div>

        {!cost.withinBudget && (
          <p className="mt-2 text-sm text-destructive">
            Over budget — reduce some allocations.
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSubmit(allocations)}
            disabled={!canSubmit}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isSubmitting ? "Generating proof…" : "Submit quadratic vote"}
          </button>
        </div>

        {isSubmitting && (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Generating the zero-knowledge proof — this can take a few minutes.
          </p>
        )}
      </div>
    </div>
  );
}
