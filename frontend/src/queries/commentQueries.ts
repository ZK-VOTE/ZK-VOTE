import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CommentWithContent,
  type CommentInfo,
  type CommentMetadata,
  type PaginatedResult,
  fetchComments,
  fetchAllComments,
  fetchCommentContent,
  buildCommentTree,
} from "../lib/comments";
import { queryKeys } from "../lib/queryClient";

interface UseCommentsQueryOptions {
  daoId: number;
  proposalId: number;
  pageSize?: number;
  enabled?: boolean;
}

/**
 * Fetch paginated comments for a proposal (first page only).
 */
async function fetchPaginatedComments(
  daoId: number,
  proposalId: number,
  cursor?: string,
): Promise<PaginatedResult<CommentInfo>> {
  return fetchComments(daoId, proposalId, cursor);
}

/**
 * Fetch all comments with their content and build the tree (auto-paginates).
 */
async function fetchAllCommentsWithContent(
  daoId: number,
  proposalId: number,
): Promise<CommentWithContent[]> {
  // Fetch all comments (auto-paginates)
  const rawComments: CommentInfo[] = await fetchAllComments(daoId, proposalId);

  // Fetch content for each comment in parallel
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
 * React Query hook for fetching paginated comments on a proposal.
 * Returns the first page with cursor for infinite scroll.
 */
export function useCommentsQuery({
  daoId,
  proposalId,
  pageSize,
  enabled = true,
}: UseCommentsQueryOptions) {
  return useQuery({
    queryKey: queryKeys.comments.list(daoId, proposalId),
    queryFn: () => fetchAllCommentsWithContent(daoId, proposalId),
    enabled: enabled && daoId > 0 && proposalId > 0,
    staleTime: 30 * 1000,
    retry: (failureCount, error) => {
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

export function useOptimisticComment() {
  const queryClient = useQueryClient();

  const addOptimisticComment = (
    daoId: number,
    proposalId: number,
    comment: CommentWithContent
  ) => {
    const queryKey = queryKeys.comments.list(daoId, proposalId);

    const previousComments = queryClient.getQueryData<CommentWithContent[]>(queryKey);

    queryClient.setQueryData<CommentWithContent[]>(queryKey, (old) => {
      if (!old) return [comment];
      if (!comment.parentId) {
        return [comment, ...old];
      }
      return old.map((c) => {
        if (c.id === comment.parentId) {
          return { ...c, replies: [...c.replies, comment] };
        }
        return c;
      });
    });

    return () => {
      if (previousComments) {
        queryClient.setQueryData(queryKey, previousComments);
      }
    };
  };

  const clearPendingComment = (daoId: number, proposalId: number) => {
    const queryKey = queryKeys.comments.list(daoId, proposalId);
    queryClient.invalidateQueries({ queryKey });
  };

  return { addOptimisticComment, clearPendingComment };
}
