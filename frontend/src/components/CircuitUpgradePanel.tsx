import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, Clock, RefreshCw, Shield } from "lucide-react";
import { useState } from "react";
import type { CircuitStatusResponse, VkProposal } from "../types/index";
import { relayerFetch } from "../lib/api";

interface CircuitUpgradePanelProps {
  daoId: number;
  circuitType: "Vote" | "Comment";
}

function CircuitBadge({
  label,
  variant,
}: {
  label: string;
  variant: "current" | "available" | "expired";
}) {
  const colors = {
    current: "bg-green-100 text-green-800 border-green-300",
    available: "bg-blue-100 text-blue-800 border-blue-300",
    expired: "bg-red-100 text-red-800 border-red-300",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[variant]}`}
    >
      {label}
    </span>
  );
}

function MigrationTimeline({
  migration,
}: {
  migration: NonNullable<CircuitStatusResponse["migration"]>;
}) {
  const deadlineDate = new Date(migration.deadline * 1000);
  const [now] = useState(() => Date.now());
  const remaining = Math.max(0, deadlineDate.getTime() - now);
  const daysRemaining = Math.ceil(remaining / (1000 * 60 * 60 * 24));

  return (
    <div className="border border-yellow-300 bg-yellow-50 rounded-lg p-4 mt-4">
      <h4 className="text-sm font-semibold text-yellow-800 flex items-center gap-2">
        <Clock className="w-4 h-4" />
        Migration In Progress
      </h4>
      <div className="mt-2 text-sm text-yellow-700 space-y-1">
        <p>
          From: <span className="font-mono">{migration.fromCircuitId}</span>
        </p>
        <p>
          To: <span className="font-mono">{migration.toCircuitId}</span>
        </p>
        <p>
          Deadline: {deadlineDate.toLocaleDateString()} (
          {daysRemaining > 0 ? `${daysRemaining} days remaining` : "Passed"})
        </p>
        {migration.inOverlapWindow && (
          <p className="flex items-center gap-1 text-yellow-800 font-medium">
            <Clock className="w-3.5 h-3.5" />
            Overlap window active — both circuits accepted
          </p>
        )}
      </div>
    </div>
  );
}

function PendingVkProposal({
  proposal,
}: {
  proposal: VkProposal;
}) {
  const executeDate = new Date(proposal.executeAfter * 1000);
  const [now] = useState(() => Date.now());
  const remaining = Math.max(0, executeDate.getTime() - now);
  const hoursRemaining = Math.ceil(remaining / (1000 * 60 * 60));
  const quorumMet = proposal.approvals >= proposal.requiredApprovals;
  const approvalPercent = Math.min(
    100,
    Math.round((proposal.approvals / proposal.requiredApprovals) * 100),
  );

  return (
    <div className="border border-blue-300 bg-blue-50 rounded-lg p-4 mt-4">
      <h4 className="text-sm font-semibold text-blue-800 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        Pending VK Upgrade
      </h4>
      <div className="mt-2 text-sm text-blue-700 space-y-1">
        <p>
          Circuit: <span className="font-mono">{proposal.circuitId}</span>
        </p>
        <p>
          Execute after: {executeDate.toLocaleString()} (
          {hoursRemaining > 0 ? `${hoursRemaining}h remaining` : "Ready"})
        </p>
        <div className="w-full bg-blue-200 rounded-full h-2 mt-2">
          <div
            className={`h-2 rounded-full ${quorumMet ? "bg-green-500" : "bg-blue-500"}`}
            style={{ width: `${approvalPercent}%` }}
          />
        </div>
        <p>
          Approvals: {proposal.approvals} / {proposal.requiredApprovals}
          {quorumMet && " (quorum met)"}
        </p>
        <p className="text-xs text-blue-600">
          Status: {proposal.status}
        </p>
      </div>
    </div>
  );
}

export default function CircuitUpgradePanel({
  daoId,
  circuitType,
}: CircuitUpgradePanelProps) {
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<CircuitStatusResponse>({
    queryKey: ["circuit-status", daoId, circuitType],
    queryFn: async () => {
      const res = await relayerFetch(
        `/api/circuits/${daoId}/${circuitType.toLowerCase()}/status`,
      );
      if (!res.ok) throw new Error("Failed to fetch circuit status");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  if (isLoading) {
    return (
      <div className="animate-pulse p-4 border rounded-lg">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-red-300 bg-red-50 rounded-lg">
        <p className="text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Failed to load circuit status
        </p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="border border-border rounded-lg p-4 bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">Circuit Registry</h3>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-3 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          title="Refresh"
          aria-label="Refresh circuit status"
        >
          <RefreshCw
            className={`w-4 h-4 text-muted-foreground ${refreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Current Circuit</span>
          <CircuitBadge label={data.currentCircuit} variant="current" />
        </div>

        <div className="text-sm text-gray-500 flex items-center gap-1">
          <CheckCircle className="w-3.5 h-3.5 text-green-500" />
          {data.availableCircuits.length} circuit
          {data.availableCircuits.length !== 1 ? "s" : ""} available
        </div>

        {data.availableCircuits.length > 0 && (
          <div className="mt-2">
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Available Circuits
            </h4>
            <div className="space-y-1">
              {data.availableCircuits.map((c) => (
                <div
                  key={c.circuitId}
                  className="flex items-center justify-between text-sm py-1"
                >
                  <span className="font-mono text-xs">{c.circuitId}</span>
                  <span className="text-xs text-gray-400">
                    {c.numPublicSignals} signals
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.migration && <MigrationTimeline migration={data.migration} />}
        {data.pendingVkProposal && (
          <PendingVkProposal proposal={data.pendingVkProposal} />
        )}
      </div>
    </div>
  );
}
