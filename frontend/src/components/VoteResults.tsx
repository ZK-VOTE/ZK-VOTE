import { CheckCircle, XCircle } from "lucide-react";

interface VoteResultsProps {
  yesVotes: number;
  noVotes: number;
  isOpen: boolean;
}

export default function VoteResults({ yesVotes, noVotes }: VoteResultsProps) {
  const totalVotes = yesVotes + noVotes;
  const yesPercentage = totalVotes > 0 ? (yesVotes / totalVotes) * 100 : 0;
  const noPercentage = totalVotes > 0 ? (noVotes / totalVotes) * 100 : 0;

  return (
    <div className="space-y-3 pt-4 border-t border-border">
      <h3 className="text-sm font-semibold">Results</h3>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-500">
            <CheckCircle className="w-4 h-4" />
            {yesVotes} Yes
          </span>
          <span className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-500">
            <XCircle className="w-4 h-4" />
            {noVotes} No
          </span>
        </div>
        <span className="text-muted-foreground">{totalVotes} votes total</span>
      </div>

      <div className="h-3 w-full rounded-full bg-secondary overflow-hidden flex">
        <div
          className="bg-green-500 transition-all duration-500"
          style={{ width: `${yesPercentage}%` }}
        />
        <div
          className="bg-red-500 transition-all duration-500"
          style={{ width: `${noPercentage}%` }}
        />
      </div>

      {totalVotes > 0 && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{yesPercentage.toFixed(1)}% Yes</span>
          <span>{noPercentage.toFixed(1)}% No</span>
        </div>
      )}
    </div>
  );
}
