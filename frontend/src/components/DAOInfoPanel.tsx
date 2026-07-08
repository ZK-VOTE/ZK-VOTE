import { useState, useEffect } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import {
  getReadOnlyDaoRegistry,
  getReadOnlyMembershipSbt,
  getReadOnlyMembershipTree,
  getReadOnlyVoting,
} from "../lib/readOnlyContracts";
import { LoadingSpinner, Badge } from "./ui";
import {
  CheckCircle,
  Copy,
  Check,
  Users,
  UserPlus,
  UserMinus,
  Vote,
  FileText,
  Shield,
  Key,
  Edit,
} from "lucide-react";
import defaultVK from "../lib/verification_key_soroban.json";
import ProfileChangesModal from "./ProfileChangesModal";

// Relayer URL for fetching events
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";

interface DAOInfoPanelProps {
  daoId: number;
  publicKey: string | null;
  kit: StellarWalletsKit | null;
}

interface DAODetails {
  name: string;
  admin: string;
  membershipOpen: boolean;
  membersCanPropose: boolean;
  memberCount: number;
  merkleRoot: string;
  treeDepth: number;
  leafCount: number;
  vkVersion: number | null;
  vk: {
    alpha: string;
    beta: string;
    gamma: string;
    delta: string;
    ic: string[];
  } | null;
}

interface ProfileChange {
  old: string | null;
  new: string | null;
}

interface DAOEvent {
  type: string;
  daoId: number;
  data: Record<string, unknown> & { changes?: Record<string, ProfileChange> };
  ledger: number;
  txHash: string;
  timestamp: string | null;
}

// Event type to display info mapping (includes both with and without _event suffix)
const EVENT_DISPLAY: Record<
  string,
  { label: string; icon: React.ElementType; color: string }
> = {
  dao_create: { label: "DAO Created", icon: Shield, color: "text-blue-500" },
  dao_create_event: {
    label: "DAO Created",
    icon: Shield,
    color: "text-blue-500",
  },
  admin_transfer: {
    label: "Admin Transferred",
    icon: Shield,
    color: "text-yellow-500",
  },
  member_added: {
    label: "Member Added",
    icon: UserPlus,
    color: "text-green-500",
  },
  member_revoked: {
    label: "Member Revoked",
    icon: UserMinus,
    color: "text-red-500",
  },
  member_left: {
    label: "Member Left",
    icon: UserMinus,
    color: "text-orange-500",
  },
  voter_registered: {
    label: "Voter Registered",
    icon: Users,
    color: "text-green-500",
  },
  voter_removed: {
    label: "Voter Removed",
    icon: UserMinus,
    color: "text-red-500",
  },
  voter_reinstated: {
    label: "Voter Reinstated",
    icon: UserPlus,
    color: "text-blue-500",
  },
  vk_updated: { label: "VK Updated", icon: Key, color: "text-purple-500" },
  vk_set_event: { label: "VK Set", icon: Key, color: "text-purple-500" },
  sbt_mint_event: {
    label: "Member Added",
    icon: UserPlus,
    color: "text-green-500",
  },
  proposal_created: {
    label: "Proposal Created",
    icon: FileText,
    color: "text-blue-500",
  },
  proposal_closed: {
    label: "Proposal Closed",
    icon: FileText,
    color: "text-gray-500",
  },
  proposal_archived: {
    label: "Proposal Archived",
    icon: FileText,
    color: "text-gray-400",
  },
  vote_cast: { label: "Vote Cast", icon: Vote, color: "text-green-500" },
  profile_updated: {
    label: "Profile Updated",
    icon: Edit,
    color: "text-indigo-500",
  },
};

// Compare VK with default ZKVote VK
function isDefaultVK(vk: DAODetails["vk"]): boolean {
  if (!vk) return false;

  // Compare alpha, beta, gamma, delta
  if (vk.alpha !== defaultVK.alpha) return false;
  if (vk.beta !== defaultVK.beta) return false;
  if (vk.gamma !== defaultVK.gamma) return false;
  if (vk.delta !== defaultVK.delta) return false;

  // Compare IC array
  if (vk.ic.length !== defaultVK.ic.length) return false;
  for (let i = 0; i < vk.ic.length; i++) {
    if (vk.ic[i] !== defaultVK.ic[i]) return false;
  }

  return true;
}

// Format hex string for display (truncate middle)
function formatHex(hex: string, startChars = 8, endChars = 8): string {
  if (hex.length <= startChars + endChars + 3) return hex;
  return `${hex.slice(0, startChars)}...${hex.slice(-endChars)}`;
}

// Format event data for display
function formatEventData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > 20) {
      parts.push(`${key}: ${value.slice(0, 8)}...`);
    } else if (typeof value === "object") {
      parts.push(`${key}: {...}`);
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(" • ");
}

// Copy button component
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-500" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

export default function DAOInfoPanel({
  daoId,
  publicKey,
  kit: _kit,
}: DAOInfoPanelProps) {
  const [details, setDetails] = useState<DAODetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedVK, setExpandedVK] = useState(false);
  const [events, setEvents] = useState<DAOEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedProfileEvent, setSelectedProfileEvent] =
    useState<DAOEvent | null>(null);

  useEffect(() => {
    loadDAODetails();
    loadEvents();
  }, [daoId, publicKey]);

  const loadEvents = async () => {
    try {
      setEventsLoading(true);
      setEventsError(null);

      const response = await fetch(`${RELAYER_URL}/events/${daoId}?limit=20`);
      if (!response.ok) {
        throw new Error("Failed to fetch events");
      }

      const data = await response.json();
      // Sort events: dao_create always at the end (bottom of activity log)
      const sortedEvents = (data.events || []).sort(
        (a: DAOEvent, b: DAOEvent) => {
          // dao_create/dao_create_event should always be last
          const aIsCreate =
            a.type === "dao_create" || a.type === "dao_create_event";
          const bIsCreate =
            b.type === "dao_create" || b.type === "dao_create_event";
          if (aIsCreate && !bIsCreate) return 1;
          if (bIsCreate && !aIsCreate) return -1;
          // Otherwise maintain timestamp DESC order (newest first)
          return 0;
        },
      );
      setEvents(sortedEvents);
    } catch (err) {
      console.error("Failed to load events:", err);
      setEventsError("Events unavailable - relayer may be offline");
    } finally {
      setEventsLoading(false);
    }
  };

  const loadDAODetails = async () => {
    try {
      setLoading(true);
      setError(null);

      // Use read-only clients by default, or authenticated if available
      let daoRegistry = getReadOnlyDaoRegistry();
      let membershipSbt = getReadOnlyMembershipSbt();
      let membershipTree = getReadOnlyMembershipTree();
      let voting = getReadOnlyVoting();

      if (publicKey) {
        try {
          const clients = initializeContractClients(publicKey);
          // Test if account exists by making a simple call
          await clients.daoRegistry.get_dao({ dao_id: BigInt(daoId) });
          // If successful, use authenticated clients (same interface as read-only)
          daoRegistry = clients.daoRegistry;
          membershipSbt = clients.membershipSbt;
          membershipTree = clients.membershipTree;
          voting = clients.voting;
        } catch {
          // Fall back to read-only
        }
      }

      // Fetch DAO info
      const daoResult = await daoRegistry.get_dao({ dao_id: BigInt(daoId) });

      // Try to get members_can_propose from daoResult or default to true
      // Note: This field may not be present in older contract clients
      const membersCanProposeValue =
        (daoResult.result as { members_can_propose?: boolean })
          ?.members_can_propose ?? true;

      // Fetch member count
      const memberCountResult = await membershipSbt.get_member_count({
        dao_id: BigInt(daoId),
      });

      // Fetch tree info (depth, leaf count, root) - may not exist if tree not initialized
      let treeInfo: { depth: number; leafCount: number; merkleRoot: string } = {
        depth: 0,
        leafCount: 0,
        merkleRoot: "0",
      };
      try {
        const treeInfoResult = await membershipTree.get_tree_info({
          dao_id: BigInt(daoId),
        });
        if (treeInfoResult.result) {
          treeInfo = {
            depth: Number(treeInfoResult.result[0]),
            leafCount: Number(treeInfoResult.result[1]),
            merkleRoot: treeInfoResult.result[2]?.toString() || "0",
          };
        }
      } catch {
        // Tree not initialized yet - use defaults
        if (import.meta.env.DEV)
          console.log("Tree not initialized for DAO:", daoId);
      }

      // Fetch VK version
      const vkVersionResult = await voting.vk_version({
        dao_id: BigInt(daoId),
      });
      const vkVersion =
        vkVersionResult.result !== undefined
          ? Number(vkVersionResult.result)
          : null;

      // Fetch VK if version exists
      let vk: DAODetails["vk"] = null;
      if (vkVersion !== null && vkVersion > 0) {
        try {
          const vkResult = await voting.vk_for_version({
            dao_id: BigInt(daoId),
            version: vkVersion,
          });

          // Convert Buffer to hex string
          const bufferToHex = (
            buf: Uint8Array | number[] | string | Buffer,
          ): string => {
            if (typeof buf === "string") return buf;
            if (buf instanceof Uint8Array || Array.isArray(buf)) {
              return Array.from(buf)
                .map((b: number) => b.toString(16).padStart(2, "0"))
                .join("");
            }
            return String(buf);
          };

          vk = {
            alpha: bufferToHex(vkResult.result.alpha),
            beta: bufferToHex(vkResult.result.beta),
            gamma: bufferToHex(vkResult.result.gamma),
            delta: bufferToHex(vkResult.result.delta),
            ic: vkResult.result.ic.map(bufferToHex),
          };
        } catch (err) {
          console.error("Failed to fetch VK:", err);
        }
      }

      setDetails({
        name: daoResult.result.name,
        admin: daoResult.result.admin,
        membershipOpen: daoResult.result.membership_open,
        membersCanPropose: membersCanProposeValue,
        memberCount: Number(memberCountResult.result),
        merkleRoot: treeInfo.merkleRoot,
        treeDepth: treeInfo.depth,
        leafCount: treeInfo.leafCount,
        vkVersion,
        vk,
      });
    } catch (err) {
      console.error("Failed to load DAO details:", err);
      setError("Failed to load DAO details");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <p className="text-destructive">{error || "Failed to load details"}</p>
      </div>
    );
  }

  const isZKVoteVK = isDefaultVK(details.vk);

  return (
    <div className="space-y-4">
      {/* Basic Info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Members
          </h3>
          <p className="text-2xl font-bold">{details.memberCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Registered Voters
          </h3>
          <p className="text-2xl font-bold">{details.leafCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            VK Version
          </h3>
          <div className="flex items-center gap-2">
            <p className="text-2xl font-bold">{details.vkVersion ?? "N/A"}</p>
            {isZKVoteVK && (
              <Badge variant="success" className="gap-1">
                <CheckCircle className="w-3 h-3" />
                ZKVote VK
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Admin */}
      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Admin
        </h3>
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono bg-muted px-2 py-1 rounded break-all">
            {details.admin}
          </code>
          <CopyButton text={details.admin} />
        </div>
      </div>

      {/* Proposal Mode */}
      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-1">
          Proposal Mode
        </h3>
        <p className="text-sm">
          {details.membersCanPropose ? (
            <span className="text-green-600 dark:text-green-400">
              Members can create proposals
            </span>
          ) : (
            <span className="text-orange-600 dark:text-orange-400">
              Admin-only proposals
            </span>
          )}
        </p>
      </div>

      {/* Merkle Root */}
      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Current Merkle Root
        </h3>
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono bg-muted px-2 py-1 rounded break-all">
            {details.merkleRoot}
          </code>
          <CopyButton text={details.merkleRoot} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Tree depth: {details.treeDepth} (max{" "}
          {Math.pow(2, details.treeDepth).toLocaleString()} members)
        </p>
      </div>

      {/* Verification Key */}
      {details.vk && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Verification Key
              </h3>
              {isZKVoteVK && (
                <Badge variant="success" className="gap-1">
                  <CheckCircle className="w-3 h-3" />
                  ZKVote VK
                </Badge>
              )}
            </div>
            <button
              onClick={() => setExpandedVK(!expandedVK)}
              className="text-xs text-primary hover:underline"
            >
              {expandedVK ? "Collapse" : "Expand"}
            </button>
          </div>

          {expandedVK ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Alpha (G1)</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                    {details.vk.alpha}
                  </code>
                  <CopyButton text={details.vk.alpha} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Beta (G2)</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                    {details.vk.beta}
                  </code>
                  <CopyButton text={details.vk.beta} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Gamma (G2)</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                    {details.vk.gamma}
                  </code>
                  <CopyButton text={details.vk.gamma} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Delta (G2)</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                    {details.vk.delta}
                  </code>
                  <CopyButton text={details.vk.delta} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  IC Points ({details.vk.ic.length})
                </p>
                <div className="space-y-1">
                  {details.vk.ic.map((ic, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                        [{i}] {ic}
                      </code>
                      <CopyButton text={ic} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                Alpha: {formatHex(details.vk.alpha)} | Beta:{" "}
                {formatHex(details.vk.beta, 6, 6)} | ...
              </code>
            </div>
          )}
        </div>
      )}

      {/* Activity Log */}
      <div className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-3">
          Activity Log
        </h3>

        {eventsLoading ? (
          <div className="flex items-center justify-center py-4">
            <LoadingSpinner size="sm" />
          </div>
        ) : eventsError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground italic">
              {eventsError}
            </p>
            <p className="text-xs text-muted-foreground">
              View events on{" "}
              <a
                href="https://stellar.expert"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Stellar Expert
              </a>
            </p>
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No events recorded yet
          </p>
        ) : (
          <div className="space-y-2">
            {events.map((event, index) => {
              const display = EVENT_DISPLAY[event.type] || {
                label: event.type,
                icon: FileText,
                color: "text-gray-500",
              };
              const Icon = display.icon;

              const hasChanges =
                event.type === "profile_updated" &&
                event.data?.changes &&
                Object.keys(event.data.changes).length > 0;

              return (
                <div
                  key={`${event.txHash}-${index}`}
                  className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0"
                >
                  <div className={`mt-0.5 ${display.color}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{display.label}</p>
                    {event.data &&
                      Object.keys(event.data).length > 0 &&
                      !hasChanges && (
                        <p className="text-xs text-muted-foreground truncate">
                          {formatEventData(event.data)}
                        </p>
                      )}
                    {hasChanges && event.data.changes && (
                      <button
                        onClick={() => setSelectedProfileEvent(event)}
                        className="text-xs text-primary hover:underline"
                      >
                        View {Object.keys(event.data.changes).length} change
                        {Object.keys(event.data.changes).length !== 1
                          ? "s"
                          : ""}
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground text-right">
                    <p>
                      Ledger{" "}
                      {typeof event.ledger === "number" && !isNaN(event.ledger)
                        ? event.ledger
                        : "N/A"}
                    </p>
                    {event.txHash && (
                      <p className="font-mono truncate max-w-[80px]">
                        {event.txHash.slice(0, 8)}...
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Profile Changes Modal */}
      {selectedProfileEvent && selectedProfileEvent.data?.changes && (
        <ProfileChangesModal
          changes={selectedProfileEvent.data.changes}
          timestamp={selectedProfileEvent.timestamp}
          onClose={() => setSelectedProfileEvent(null)}
        />
      )}
    </div>
  );
}
