import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { getZkVoteClient } from "../lib/client";
import { getReadOnlyVoting } from "../lib/readOnlyContracts";
import { calculateNullifier } from "../lib/zkproof";
import { getZKCredentials } from "../lib/zk";
import { parseIdFromSlug, toIdSlug } from "../lib/utils";
import { useDaoInfoQuery } from "../queries/daoQueries";
import { useProposalActions } from "../hooks/useProposalActions";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardContent } from "./ui/Card";
import { LoadingSpinner } from "./ui";
import VoteModal from "./VoteModal";
import ClaimRewards from "./ClaimRewards";
import CommentSection from "./CommentSection";
import VoteResults from "./VoteResults";
import VoteEligibilityPreview from "./VoteEligibilityPreview";
import ProposalContent from "./ProposalContent";
import ProposalHeader from "./ProposalHeader";
import { Clock, AlertCircle, ArrowLeft, Vote, Gift } from "lucide-react";

interface Proposal {
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
}

interface ProposalPageProps {
  publicKey: string | null;
  kit: StellarWalletsKit | null;
  isInitializing: boolean;
}

export default function ProposalPage({
  publicKey,
  kit,
  isInitializing,
}: ProposalPageProps) {
  const { daoSlug, proposalSlug } = useParams<{
    daoSlug: string;
    proposalSlug: string;
  }>();
  const navigate = useNavigate();

  const numericDaoId = daoSlug ? parseIdFromSlug(daoSlug) : null;
  const numericProposalId = proposalSlug ? parseIdFromSlug(proposalSlug) : null;

  // Use React Query for DAO info instead of manual localStorage caching
  const { data: daoInfo } = useDaoInfoQuery({
    daoId: numericDaoId,
    publicKey,
    enabled: !isInitializing && numericDaoId !== null,
  });

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isProposalNotFound, setIsProposalNotFound] = useState(false);

  const {
    hasMembership,
    isRegistered,
    joining,
    registering,
    registrationStatus,
    actionError,
    handleJoinDao,
    handleRegisterForVoting,
  } = useProposalActions({ publicKey, kit, numericDaoId });

  // Generate slug for navigation
  const daoSlugForNav =
    numericDaoId && daoInfo?.name
      ? toIdSlug(numericDaoId, daoInfo.name)
      : daoSlug || "";
  const daoDisplayName = daoInfo?.name || `DAO #${numericDaoId}`;

  const now = Math.floor(Date.now() / 1000);
  const hasDeadline = proposal ? proposal.endTime > 0 : false;
  const isPastDeadline =
    hasDeadline && proposal ? now > proposal.endTime : false;

  useEffect(() => {
    if (numericDaoId !== null && numericProposalId !== null) {
      loadProposal();
    }
  }, [numericDaoId, numericProposalId, publicKey]);

  const loadProposal = async () => {
    if (numericDaoId === null || numericProposalId === null) return;

    setLoading(true);
    setError(null);
    setIsProposalNotFound(false);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Contract client types not fully exported
      const votingClient: any = publicKey
        ? getZkVoteClient(publicKey).voting
        : getReadOnlyVoting();

      const proposalResult = await votingClient.get_proposal({
        dao_id: BigInt(numericDaoId),
        proposal_id: BigInt(numericProposalId),
      });

      const proposalData = proposalResult.result;

      // Check if user has already voted
      let hasVoted = false;
      if (publicKey) {
        try {
          const cached = getZKCredentials(numericDaoId, publicKey);

          if (cached) {
            const { secret } = cached;
            const nullifier = await calculateNullifier(
              secret,
              numericDaoId.toString(),
              numericProposalId.toString(),
            );

            const nullifierUsedResult = await votingClient.is_nullifier_used({
              dao_id: BigInt(numericDaoId),
              proposal_id: BigInt(numericProposalId),
              nullifier: BigInt(nullifier),
            });
            hasVoted = nullifierUsedResult.result;
          }
        } catch (err) {
          console.error("Failed to check if voted:", err);
        }
      }

      setRetryCount(0);
      setProposal({
        id: numericProposalId,
        title: proposalData.title,
        contentCid: proposalData.content_cid,
        yesVotes: Number(proposalData.yes_votes),
        noVotes: Number(proposalData.no_votes),
        hasVoted,
        eligibleRoot: proposalData.eligible_root,
        voteMode: proposalData.vote_mode.tag as "Fixed" | "Trailing",
        endTime: Number(proposalData.end_time),
        vkVersion:
          "vk_version" in proposalData && proposalData.vk_version !== undefined
            ? Number(proposalData.vk_version)
            : null,
      });
    } catch (err) {
      console.error("Failed to load proposal:", err);
      const errorMsg =
        err instanceof Error ? err.message : "Failed to load proposal";

      const isNotFound =
        errorMsg.includes("UnreachableCodeReached") ||
        errorMsg.includes("simulation failed") ||
        errorMsg.includes("InvalidAction");

      if (isNotFound) {
        setIsProposalNotFound(true);
        if (retryCount < 3) {
          setRetryCount((prev) => prev + 1);
          const delay = Math.pow(2, retryCount) * 1000;
          setTimeout(() => loadProposal(), delay);
          return;
        }
      }

      setError(
        isNotFound
          ? "Proposal not found - it may still be confirming on the network"
          : errorMsg,
      );
    } finally {
      setLoading(false);
    }
  };

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

    const timeLeft = proposal!.endTime - now;
    if (timeLeft < 86400) return "text-orange-500";
    return "text-muted-foreground";
  };

  const handleVoteComplete = () => {
    setShowVoteModal(false);
    loadProposal();
  };

  const handleClaimComplete = () => {
    setShowClaimModal(false);
    loadProposal();
  };

  // Show full page loading only if we have no DAO info yet
  if (loading && !daoInfo) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <LoadingSpinner size="lg" />
        {retryCount > 0 && (
          <p className="text-sm text-muted-foreground">
            Waiting for proposal to confirm... (attempt {retryCount}/3)
          </p>
        )}
      </div>
    );
  }

  // Error state - but still show DAO header if we have it
  if (error || (!loading && !proposal)) {
    return (
      <div className="space-y-6 animate-fade-in">
        {daoInfo && (
          <ProposalHeader
            daoSlugForNav={daoSlugForNav}
            daoDisplayName={daoDisplayName}
            numericDaoId={numericDaoId}
            daoInfo={daoInfo}
            hasMembership={hasMembership}
            isRegistered={isRegistered}
            publicKey={publicKey}
            joining={joining}
            onJoinDao={handleJoinDao}
            registering={registering}
            registrationStatus={registrationStatus}
            onRegisterForVoting={handleRegisterForVoting}
            actionError={actionError}
          />
        )}

        <Card>
          <CardContent className="p-6">
            {isProposalNotFound ? (
              <div className="flex flex-col items-center gap-4 py-4">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30">
                  <Clock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="text-center">
                  <h3 className="font-medium text-foreground mb-1">
                    Proposal not found
                  </h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    This proposal may still be confirming on the network. Please
                    wait a moment and try again.
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/daos/${daoSlugForNav}`)}
                    className="gap-2"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to DAO
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setRetryCount(0);
                      loadProposal();
                    }}
                    className="gap-2"
                  >
                    <Clock className="w-4 h-4" />
                    Try Again
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-destructive">
                {error || "Proposal not found"}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <ProposalHeader
          daoSlugForNav={daoSlugForNav}
          daoDisplayName={daoDisplayName}
          numericDaoId={numericDaoId}
          daoInfo={daoInfo}
          hasMembership={hasMembership}
          isRegistered={isRegistered}
          publicKey={publicKey}
          proposalTitle={proposal?.title}
          joining={joining}
          onJoinDao={handleJoinDao}
          registering={registering}
          registrationStatus={registrationStatus}
          onRegisterForVoting={handleRegisterForVoting}
          actionError={actionError}
        />

        {/* Proposal content */}
        <Card className="animate-fade-in">
          <CardContent className="p-6 space-y-6">
            {/* Loading state for proposal */}
            {loading && !proposal ? (
              <div className="flex items-center justify-center py-12">
                <LoadingSpinner size="lg" />
              </div>
            ) : proposal ? (
              <>
                {/* Header with back button and title */}
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => navigate(`/daos/${daoSlugForNav}`)}
                    className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-secondary hover:bg-accent transition-colors"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
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
                    <div className="flex items-center justify-between gap-4">
                      <h1 className="text-2xl font-bold">{proposal.title}</h1>
                      {hasDeadline && (
                        <div
                          className={`flex items-center gap-1.5 text-sm font-medium whitespace-nowrap ${getDeadlineColor()}`}
                        >
                          <Clock className="w-4 h-4" />
                          {formatDeadline(proposal.endTime)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Proposal body/description */}
                <ProposalContent contentCid={proposal.contentCid} />

                {/* Vote results */}
                <VoteResults
                  yesVotes={proposal.yesVotes}
                  noVotes={proposal.noVotes}
                  isOpen={!isPastDeadline}
                />

                {/* Eligibility preview (issue #347) */}
                {publicKey && (
                  <VoteEligibilityPreview
                    voteMode={proposal.voteMode}
                    hasMembership={hasMembership}
                    isRegistered={isRegistered}
                    hasVoted={proposal.hasVoted}
                    isOpen={!isPastDeadline}
                    className="mt-4"
                  />
                )}

                {/* Vote & Claim buttons */}
                <div className="pt-4 flex justify-end gap-2">
                  {hasMembership && !proposal.hasVoted && (
                    <Button
                      onClick={() => setShowVoteModal(true)}
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
                  {hasMembership && proposal.hasVoted && publicKey && (
                    <Button
                      onClick={() => setShowClaimModal(true)}
                      disabled={!isRegistered}
                      variant="outline"
                      size="sm"
                      data-testid="claim-rewards-button"
                    >
                      <Gift className="w-4 h-4 mr-1.5" />
                      Claim Reward
                    </Button>
                  )}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        {/* Comments section */}
        {proposal && numericDaoId !== null && publicKey && (
          <CommentSection
            daoId={numericDaoId}
            proposalId={proposal.id}
            publicKey={publicKey}
            kit={kit}
            hasMembership={hasMembership}
            isRegistered={isRegistered}
            eligibleRoot={proposal.eligibleRoot}
            isAdmin={daoInfo?.isAdmin || false}
          />
        )}
      </div>

      {showVoteModal && numericDaoId !== null && proposal && (
        <VoteModal
          proposalId={proposal.id}
          eligibleRoot={proposal.eligibleRoot}
          voteMode={proposal.voteMode}
          vkVersion={proposal.vkVersion}
          daoId={numericDaoId}
          publicKey={publicKey || ""}
          kit={kit}
          onClose={() => setShowVoteModal(false)}
          onComplete={handleVoteComplete}
        />
      )}

      {showClaimModal && numericDaoId !== null && proposal && publicKey && (
        <ClaimRewards
          daoId={numericDaoId}
          proposalId={proposal.id}
          eligibleRoot={proposal.eligibleRoot}
          voteMode={proposal.voteMode}
          publicKey={publicKey}
          kit={kit}
          onClose={() => setShowClaimModal(false)}
          onComplete={handleClaimComplete}
        />
      )}
    </>
  );
}
