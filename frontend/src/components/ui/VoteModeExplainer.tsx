import { ShieldCheck, RefreshCw, Info } from "lucide-react";
import {
  getVoteModeExplainer,
  normalizeVoteMode,
  type VoteModeExplainer as VoteModeExplainerData,
} from "../../lib/voteModeInfo";

export interface VoteModeExplainerProps {
  mode: "Fixed" | "Trailing" | "fixed" | "trailing";
  /** Compact presentation (used inline inside radios/cards). */
  className?: string;
}

/**
 * Revocation-semantics explainer for a vote mode (issue #347).
 *
 * Copy is sourced from `lib/voteModeInfo.ts`, which mirrors
 * THREAT_MODEL.md → "Fixed Mode Revocation Semantics".
 */
export default function VoteModeExplainer({
  mode,
  className = "",
}: VoteModeExplainerProps) {
  const info: VoteModeExplainerData = getVoteModeExplainer(mode);
  const isFixed = normalizeVoteMode(mode) === "fixed";
  const Icon = isFixed ? ShieldCheck : RefreshCw;

  return (
    <div
      role="region"
      aria-label={info.title}
      data-testid="vote-mode-explainer"
      className={`rounded-lg border p-3 text-sm ${
        isFixed
          ? "border-yellow-500/30 bg-yellow-500/5"
          : "border-blue-500/30 bg-blue-500/5"
      } ${className}`}
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {info.title}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Who can vote: </span>
        {info.whoCanVote}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">
          {isFixed ? "After revocation: " : "On revocation: "}
        </span>
        {info.revocation}
      </p>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">Why: </span>
          {info.rationale}
        </span>
      </p>
    </div>
  );
}
