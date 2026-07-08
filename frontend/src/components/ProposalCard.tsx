import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { getZKCredentials } from "../lib/zk";
import { toIdSlug } from "../lib/utils";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardContent } from "./ui/Card";
import VoteModal from "./VoteModal";
import {
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Eye,
  Vote,
} from "lucide-react";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";

interface ProposalMetadata {
  version: number;
  body: string;
  videoUrl?: string;
  image?: {
    cid: string;
    filename: string;
    mimeType: string;
  };
}

interface ProposalCardProps {
  proposal: {
    id: number;
    title: string;
    contentCid: string;
    yesVotes: number;
    noVotes: number;
    hasVoted: boolean;
    eligibleRoot: bigint;
    voteMode: "Fixed" | "Trailing";
    endTime: number;
    vkVersion?: number | null;
  };
  daoId: number;
  daoName?: string;
  publicKey: string;
  kit: StellarWalletsKit | null;
  hasMembership: boolean;
  onVoteComplete: () => void;
}

export default function ProposalCard({
  proposal,
  daoId,
  daoName,
  publicKey,
  kit,
  hasMembership,
  onVoteComplete,
}: ProposalCardProps) {
  const navigate = useNavigate();
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [metadata, setMetadata] = useState<ProposalMetadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const MAX_RETRIES = 3;

  const totalVotes = proposal.yesVotes + proposal.noVotes;
  const yesPercentage =
    totalVotes > 0 ? (proposal.yesVotes / totalVotes) * 100 : 0;
  const noPercentage =
    totalVotes > 0 ? (proposal.noVotes / totalVotes) * 100 : 0;

  const isRegistered = publicKey ? !!getZKCredentials(daoId, publicKey) : false;

  const now = Math.floor(Date.now() / 1000);
  const hasDeadline = proposal.endTime > 0;
  const isPastDeadline = hasDeadline && now > proposal.endTime;

  // Check if contentCid looks like a valid CID
  const hasRichContent =
    proposal.contentCid &&
    (proposal.contentCid.startsWith("Qm") ||
      proposal.contentCid.startsWith("bafy") ||
      proposal.contentCid.startsWith("bafk"));

  // Fetch metadata eagerly to show thumbnail, with exponential backoff retry
  useEffect(() => {
    if (
      hasRichContent &&
      !metadata &&
      !loadingMetadata &&
      retryCount < MAX_RETRIES
    ) {
      setLoadingMetadata(true);

      const fetchWithRetry = async () => {
        try {
          const res = await fetch(`${RELAYER_URL}/ipfs/${proposal.contentCid}`);
          if (!res.ok) throw new Error("Failed to fetch metadata");
          const data = await res.json();
          setMetadata(data);
          setLoadingMetadata(false);
        } catch {
          const newRetryCount = retryCount + 1;
          setRetryCount(newRetryCount);

          if (newRetryCount >= MAX_RETRIES) {
            setLoadingMetadata(false);
          } else {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, newRetryCount - 1) * 1000;
            setTimeout(() => {
              setLoadingMetadata(false);
            }, delay);
          }
        }
      };

      fetchWithRetry();
    }
  }, [
    hasRichContent,
    proposal.contentCid,
    metadata,
    loadingMetadata,
    retryCount,
  ]);

  const formatDeadline = (timestamp: number): string => {
    if (timestamp === 0) return "No deadline";

    const timeLeft = timestamp - now;

    if (timeLeft < 0) {
      return "Closed";
    } else if (timeLeft < 3600) {
      const minutes = Math.floor(timeLeft / 60);
      return `${minutes} minute${minutes !== 1 ? "s" : ""} left`;
    } else if (timeLeft < 86400) {
      const hours = Math.floor(timeLeft / 3600);
      return `${hours} hour${hours !== 1 ? "s" : ""} left`;
    } else {
      const days = Math.floor(timeLeft / 86400);
      return `${days} day${days !== 1 ? "s" : ""} left`;
    }
  };

  const getDeadlineColor = (): string => {
    if (!hasDeadline) return "text-muted-foreground";
    if (isPastDeadline) return "text-destructive";

    const timeLeft = proposal.endTime - now;
    if (timeLeft < 86400) return "text-orange-500";
    return "text-muted-foreground";
  };

  const getImageUrl = (cid: string): string => {
    return `${RELAYER_URL}/ipfs/image/${cid}`;
  };

  const handleViewDetails = () => {
    const daoSlug = daoName ? toIdSlug(daoId, daoName) : String(daoId);
    const proposalSlug = toIdSlug(proposal.id, proposal.title);
    navigate(`/daos/${daoSlug}/proposals/${proposalSlug}`);
  };

  return (
    <>
      <Card
        className="group/card transition-all overflow-hidden cursor-pointer hover:shadow-md hover:border-primary/30"
        onClick={handleViewDetails}
      >
        <CardContent className="p-0">
          <div className="flex">
            {/* Thumbnail image on left */}
            {metadata?.image && (
              <div className="flex-shrink-0 w-32 sm:w-56 bg-muted relative">
                {!imageLoaded && (
                  <div className="absolute inset-0 animate-shimmer" />
                )}
                <img
                  src={getImageUrl(metadata.image.cid)}
                  alt={metadata.image.filename || "Proposal image"}
                  className={`w-full h-full object-cover transition-opacity duration-300 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
                  loading="lazy"
                  onLoad={() => setImageLoaded(true)}
                />
              </div>
            )}

            {/* Main content */}
            <div className="flex-1 p-6">
              <div className="flex flex-col gap-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      #{proposal.id}
                    </span>
                    {proposal.vkVersion !== undefined &&
                      proposal.vkVersion !== null && (
                        <Badge
                          variant="purple"
                          className="text-[10px] px-1.5 py-0 h-5"
                        >
                          v{proposal.vkVersion}
                        </Badge>
                      )}
                    <Badge
                      variant={
                        proposal.voteMode === "Fixed" ? "warning" : "success"
                      }
                      className="text-[10px] px-1.5 py-0 h-5"
                    >
                      {proposal.voteMode}
                    </Badge>
                    {proposal.hasVoted && (
                      <Badge
                        variant="blue"
                        className="text-[10px] px-1.5 py-0 h-5"
                      >
                        Voted
                      </Badge>
                    )}
                    {isPastDeadline && (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0 h-5"
                      >
                        Closed
                      </Badge>
                    )}
                  </div>
                  <h3 className="text-base font-semibold leading-normal">
                    {proposal.title}
                  </h3>

                  {/* Legacy content (non-CID) */}
                  {!hasRichContent && proposal.contentCid && (
                    <p className="text-sm text-muted-foreground mt-1 truncate">
                      {proposal.contentCid}
                    </p>
                  )}

                  {hasDeadline && (
                    <div
                      className={`flex items-center gap-1.5 text-xs font-medium ${getDeadlineColor()} mt-1`}
                    >
                      <Clock className="w-3.5 h-3.5" />
                      {formatDeadline(proposal.endTime)}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-500">
                        <CheckCircle className="w-4 h-4" />
                        {proposal.yesVotes}
                      </span>
                      <span className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-500">
                        <XCircle className="w-4 h-4" />
                        {proposal.noVotes}
                      </span>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {totalVotes} votes total
                    </span>
                  </div>

                  <div className="h-2 w-full rounded-full bg-secondary overflow-hidden flex">
                    <div
                      className="bg-green-500 transition-all duration-500"
                      style={{ width: `${yesPercentage}%` }}
                    />
                    <div
                      className="bg-red-500 transition-all duration-500"
                      style={{ width: `${noPercentage}%` }}
                    />
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleViewDetails();
                    }}
                    variant="outline"
                    size="sm"
                  >
                    <Eye className="w-4 h-4 mr-1.5" />
                    View
                  </Button>
                  {hasMembership && !proposal.hasVoted && (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowVoteModal(true);
                      }}
                      disabled={!isRegistered || isPastDeadline}
                      variant="outline"
                      size="sm"
                    >
                      {!isRegistered ? (
                        <>
                          <AlertCircle className="w-4 h-4 mr-1.5" />
                          Register
                        </>
                      ) : isPastDeadline ? (
                        "Closed"
                      ) : (
                        <>
                          <Vote className="w-4 h-4 mr-1.5" />
                          Vote
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {showVoteModal && (
        <VoteModal
          proposalId={proposal.id}
          eligibleRoot={proposal.eligibleRoot}
          voteMode={proposal.voteMode}
          vkVersion={proposal.vkVersion}
          daoId={daoId}
          publicKey={publicKey}
          kit={kit}
          onClose={() => setShowVoteModal(false)}
          onComplete={() => {
            setShowVoteModal(false);
            onVoteComplete();
          }}
        />
      )}
    </>
  );
}
