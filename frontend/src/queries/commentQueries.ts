import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CommentWithContent,
  type CommentInfo,
  type CommentMetadata,
  fetchComments,
  fetchCommentContent,
  buildCommentTree,
} from "../lib/comments";
import { queryKeys } from "../lib/queryClient";

interface UseCommentsQueryOptions {
  daoId: number;
  proposalId: number;
  enabled?: boolean;
}

/**
 * Fetch all comments with their content and build the tree
 */
async function fetchCommentsWithContent(
  daoId: number,
  proposalId: number,
): Promise<CommentWithContent[]> {
  // Fetch comments from relayer
  const rawComments: CommentInfo[] = await fetchComments(daoId, proposalId);

  // Fetch content for each comment in parallel
  // TODO: Consider adding a batch /ipfs/batch endpoint on the relayer to reduce N+1 fetches
  const contentMap = new Map<string, CommentMetadata | null>();
  await Promise.all(
    rawComments.map(async (c) => {
      const content = await fetchCommentContent(c.contentCid);
      contentMap.set(c.contentCid, content);
    }),
  );

  // Build and return comment tree
  return buildCommentTree(rawComments, contentMap);
}

/**
 * React Query hook for fetching comments on a proposal.
 * Replaces useState/useEffect pattern with caching and automatic refetching.
 */
export function useCommentsQuery({
  daoId,
  proposalId,
  enabled = true,
}: UseCommentsQueryOptions) {
  return useQuery({
    queryKey: queryKeys.comments.list(daoId, proposalId),
    queryFn: () => fetchCommentsWithContent(daoId, proposalId),
    enabled: enabled && daoId > 0 && proposalId > 0,
    staleTime: 30 * 1000, // 30 seconds - comments change infrequently
    retry: (failureCount, error) => {
      // Don't retry on 404 (endpoint doesn't exist)
      if (error instanceof Error && error.message.includes("404")) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

/**
 * Hook to invalidate comments cache (call after submitting a comment)
 */
export function useInvalidateComments() {
  const queryClient = useQueryClient();

  return (daoId: number, proposalId: number) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.comments.list(daoId, proposalId),
    });
  };
}
