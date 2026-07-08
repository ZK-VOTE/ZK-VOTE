import { useState, useMemo } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { MessageSquare, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "./ui/Button";
import { Card, CardContent, CardHeader } from "./ui/Card";
import Comment from "./Comment";
import CommentForm from "./CommentForm";
import RevisionHistory from "./RevisionHistory";
import { type CommentWithContent } from "../lib/comments";
import { useCommentsQuery, useInvalidateComments } from "../queries";

// Build a map of nullifiers to anonymous member numbers
function buildNullifierMap(
  comments: CommentWithContent[],
): Map<string, number> {
  const nullifierMap = new Map<string, number>();
  let memberNumber = 1;

  // Collect all nullifiers from comments and their replies (in order of appearance)
  const collectNullifiers = (commentList: CommentWithContent[]) => {
    for (const comment of commentList) {
      if (comment.nullifier && !nullifierMap.has(comment.nullifier)) {
        nullifierMap.set(comment.nullifier, memberNumber++);
      }
      if (comment.replies.length > 0) {
        collectNullifiers(comment.replies);
      }
    }
  };

  collectNullifiers(comments);
  return nullifierMap;
}

interface CommentSectionProps {
  daoId: number;
  proposalId: number;
  publicKey: string;
  kit: StellarWalletsKit | null;
  hasMembership: boolean;
  isRegistered: boolean;
  eligibleRoot: bigint;
  isAdmin: boolean;
}

export default function CommentSection({
  daoId,
  proposalId,
  publicKey,
  kit,
  hasMembership,
  isRegistered,
  eligibleRoot,
  isAdmin,
}: CommentSectionProps) {
  const [showRevisions, setShowRevisions] = useState<CommentWithContent | null>(
    null,
  );

  // Use React Query for comments
  const {
    data: comments = [],
    isLoading,
    isFetching: isRefreshing,
    error: queryError,
    refetch,
  } = useCommentsQuery({ daoId, proposalId });

  const invalidateComments = useInvalidateComments();

  const handleRefresh = () => {
    invalidateComments(daoId, proposalId);
    refetch();
  };

  // Convert query error to string for display
  const error =
    queryError &&
    queryError instanceof Error &&
    !queryError.message.includes("404")
      ? "Failed to load comments"
      : null;

  const totalComments =
    comments.length + comments.reduce((sum, c) => sum + c.replies.length, 0);

  // Build nullifier map for anonymous member numbering
  const nullifierMap = useMemo(() => buildNullifierMap(comments), [comments]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            <h3 className="text-lg font-semibold">
              Comments
              {totalComments > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({totalComments})
                </span>
              )}
            </h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Comment form */}
        <CommentForm
          daoId={daoId}
          proposalId={proposalId}
          publicKey={publicKey}
          kit={kit}
          hasMembership={hasMembership}
          isRegistered={isRegistered}
          eligibleRoot={eligibleRoot}
          onSubmit={() => {
            // Small delay to allow backend to index the new comment
            setTimeout(handleRefresh, 500);
          }}
        />

        {/* Separator */}
        {(comments.length > 0 || isLoading) && <hr className="border-border" />}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <div className="text-center py-8 text-muted-foreground">
            <p>{error}</p>
            <Button variant="link" onClick={handleRefresh} className="mt-2">
              Try again
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && comments.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No comments yet. Be the first to comment!</p>
          </div>
        )}

        {/* Comments list */}
        {!isLoading && !error && comments.length > 0 && (
          <div className="divide-y divide-border">
            {comments.map((comment) => (
              <Comment
                key={comment.id}
                comment={comment}
                daoId={daoId}
                proposalId={proposalId}
                publicKey={publicKey}
                kit={kit}
                hasMembership={hasMembership}
                isRegistered={isRegistered}
                eligibleRoot={eligibleRoot}
                isAdmin={isAdmin}
                nullifierMap={nullifierMap}
                onRefresh={handleRefresh}
                onShowRevisions={setShowRevisions}
              />
            ))}
          </div>
        )}
      </CardContent>

      {/* Revision history modal */}
      {showRevisions && (
        <RevisionHistory
          comment={showRevisions}
          onClose={() => setShowRevisions(null)}
        />
      )}
    </Card>
  );
}
