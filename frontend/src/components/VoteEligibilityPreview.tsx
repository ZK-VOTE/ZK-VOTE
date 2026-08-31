import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  type LucideIcon,
} from "lucide-react";
import {
  getEligibilityMessage,
  normalizeVoteMode,
  VOTE_MODE_LABELS,
  type EligibilityInput,
} from "../lib/voteModeInfo";

interface VoteEligibilityPreviewProps extends EligibilityInput {
  voteMode: "Fixed" | "Trailing";
  className?: string;
}

const toneStyles: Record<string, string> = {
  success:
    "border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-100",
  warning:
    "border-yellow-500/30 bg-yellow-500/5 text-yellow-800 dark:text-yellow-100",
  error: "border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-100",
  neutral: "border-border bg-muted/40 text-muted-foreground",
};

const toneIcons: Record<string, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
  neutral: Info,
};

/**
 * Eligibility preview shown before a member opens the vote modal
 * (issue #347). Makes the voter's status explicit (member? registered?
 * open? already voted?) and explains how the proposal's vote mode affects
 * them.
 */
export default function VoteEligibilityPreview({
  voteMode,
  hasMembership,
  isRegistered,
  hasVoted,
  isOpen,
  className = "",
}: VoteEligibilityPreviewProps) {
  const message = getEligibilityMessage(voteMode, {
    hasMembership,
    isRegistered,
    hasVoted,
    isOpen,
  });
  const Icon = toneIcons[message.tone];

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="vote-eligibility-preview"
      className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${toneStyles[message.tone]} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{message.title}</p>
        <p className="text-xs leading-relaxed opacity-90">
          {message.description}
        </p>
        <p className="text-xs opacity-80">
          Mode: {VOTE_MODE_LABELS[normalizeVoteMode(voteMode)]}
        </p>
      </div>
    </div>
  );
}
