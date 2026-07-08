interface DeadlineInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const PRESETS = [
  { label: "1 Day", seconds: 86400 },
  { label: "3 Days", seconds: 3 * 86400 },
  { label: "5 Days", seconds: 5 * 86400 },
  { label: "7 Days", seconds: 7 * 86400 },
  { label: "10 Days", seconds: 10 * 86400 },
  { label: "30 Days", seconds: 30 * 86400 },
  { label: "90 Days", seconds: 90 * 86400 },
  { label: "No Deadline", seconds: 0 },
];

function formatDuration(seconds: number): string {
  if (seconds === 0) return "No deadline";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (mins > 0) parts.push(`${mins} minute${mins !== 1 ? "s" : ""}`);
  if (secs > 0 && days === 0)
    parts.push(`${secs} second${secs !== 1 ? "s" : ""}`);

  return parts.join(", ") || "0 seconds";
}

export default function DeadlineInput({
  value,
  onChange,
  disabled = false,
}: DeadlineInputProps) {
  const seconds = parseInt(value, 10) || 0;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-foreground">
        Voting Deadline (in seconds from now)
      </label>
      <input
        type="number"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Enter seconds (e.g., 86400 for 1 day)"
        className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50"
      />
      <p className="text-sm text-muted-foreground">{formatDuration(seconds)}</p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(String(preset.seconds))}
            disabled={disabled}
            className="px-3 py-2 text-sm border border-border rounded-md bg-card text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- Used by other components
export { formatDuration };
