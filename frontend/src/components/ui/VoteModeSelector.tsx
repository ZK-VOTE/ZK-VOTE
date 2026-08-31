import { useState } from "react";
import VoteModeExplainer from "./VoteModeExplainer";

interface VoteModeSelectorProps {
  value: "fixed" | "trailing";
  onChange: (value: "fixed" | "trailing") => void;
  disabled?: boolean;
}

export default function VoteModeSelector({
  value,
  onChange,
  disabled = false,
}: VoteModeSelectorProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-foreground">
        Vote Mode
      </label>
      <div className="space-y-2">
        <label
          data-testid="vote-mode-option-fixed"
          className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
            value === "fixed"
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:border-muted-foreground"
          } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input
            type="radio"
            name="voteMode"
            value="fixed"
            checked={value === "fixed"}
            onChange={() => onChange("fixed")}
            disabled={disabled}
            className="mt-1 h-4 w-4 text-primary focus:ring-ring"
          />
          <div>
            <span className="font-medium text-foreground">
              Fixed (Snapshot)
            </span>
            <p className="text-sm text-muted-foreground">
              Only members who were present when the proposal was created can
              vote. Prevents vote manipulation through last-minute joins.
            </p>
          </div>
        </label>
        <label
          data-testid="vote-mode-option-trailing"
          className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
            value === "trailing"
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:border-muted-foreground"
          } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input
            type="radio"
            name="voteMode"
            value="trailing"
            checked={value === "trailing"}
            onChange={() => onChange("trailing")}
            disabled={disabled}
            className="mt-1 h-4 w-4 text-primary focus:ring-ring"
          />
          <div>
            <span className="font-medium text-foreground">
              Trailing (Dynamic)
            </span>
            <p className="text-sm text-muted-foreground">
              Members can vote even if they joined after the proposal was
              created. More inclusive but may allow vote manipulation.
            </p>
          </div>
        </label>
      </div>

      {/* Revocation-semantics explainer for the selected mode (issue #347) */}
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          disabled={disabled}
          aria-expanded={showDetails}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {showDetails
            ? "Hide revocation details"
            : "How does revocation affect this mode?"}
        </button>
        {showDetails && <VoteModeExplainer mode={value} />}
      </div>
    </div>
  );
}
