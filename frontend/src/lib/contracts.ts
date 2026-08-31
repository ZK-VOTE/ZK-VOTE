import { getZkVoteClient } from "./client";

export function initializeContractClients(publicKey: string | null) {
  return getZkVoteClient(publicKey);
}
