// Query hooks - React Query based data fetching
export {
  useDaoInfoQuery,
  useInvalidateDaoInfo,
  useDaoListQuery,
  useInvalidateDaoList,
} from "./daoQueries";
export type { DaoInfo, DAO } from "./daoQueries";

export {
  useProposalListQuery,
  useInvalidateProposals,
} from "./proposalQueries";
export type { Proposal } from "./proposalQueries";

export { useRelayerStatusQuery } from "./relayerQueries";
export type { RelayerStatus } from "./relayerQueries";

export { useCommentsQuery, useInvalidateComments } from "./commentQueries";

// Re-export queryClient and keys for direct access
export { queryClient, queryKeys } from "../lib/queryClient";
