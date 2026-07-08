import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { useProposalListQuery, useInvalidateProposals } from "../queries";
import ProposalCard from "./ProposalCard";
import { LoadingSpinner } from "./ui";
import { Card, CardContent } from "./ui/Card";
import { Clock } from "lucide-react";

interface PendingProposal {
  title: string;
}

interface ProposalListProps {
  publicKey: string | null;
  daoId: number;
  daoName?: string;
  kit: StellarWalletsKit | null;
  hasMembership: boolean;
  vkSet: boolean;
  isInitializing?: boolean;
  pendingProposal?: PendingProposal | null;
}

export default function ProposalList({
  publicKey,
  daoId,
  daoName,
  kit,
  hasMembership,
  vkSet: _vkSet,
  isInitializing = false,
  pendingProposal = null,
}: ProposalListProps) {
  const {
    data: proposals = [],
    isLoading,
    refetch,
  } = useProposalListQuery({
    daoId,
    publicKey,
    enabled: !isInitializing && daoId > 0,
  });

  const invalidateProposals = useInvalidateProposals();

  const handleVoteComplete = () => {
    invalidateProposals(daoId);
    refetch();
  };

  if (isLoading && proposals.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size="md" color="blue" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Pending Proposal Card (confirming on network) */}
      {pendingProposal && (
        <Card className="border-dashed border-2 border-blue-300 bg-blue-50/50 dark:bg-blue-950/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900">
                <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-foreground truncate">
                  {pendingProposal.title}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Confirming on network...
                </p>
              </div>
              <LoadingSpinner size="sm" color="blue" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Proposals List */}
      {proposals.length === 0 && !pendingProposal ? (
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="text-muted-foreground">No proposals yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              daoId={daoId}
              daoName={daoName}
              publicKey={publicKey || ""}
              kit={kit}
              hasMembership={hasMembership}
              onVoteComplete={handleVoteComplete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
