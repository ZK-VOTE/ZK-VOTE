type Props = {
  status: string | null;
  errors: string[];
};

// Minimal status display for relayer readiness/mismatches - only show errors
export function RelayerStatus({ status, errors }: Props) {
  // Only show when there are actual errors, not when "ready"
  const hasProblems = errors.length > 0 || (status && status !== "ready");
  if (!hasProblems) return null;
  return (
    <div className="text-sm text-red-500">
      {status && status !== "ready" && <div>Relayer status: {status}</div>}
      {errors.length > 0 && (
        <ul className="list-disc ml-4">
          {errors.map((err, idx) => (
            <li key={idx}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
