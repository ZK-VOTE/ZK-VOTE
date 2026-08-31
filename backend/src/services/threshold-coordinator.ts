/**
 * Threshold Decryption Coordinator
 *
 * Manages the off-chain coordination protocol for threshold decryption:
 * - DKG ceremony lifecycle
 * - Encrypted vote submission
 * - Decryption share collection
 * - Tally decryption and verification
 *
 * This service interacts with the ThresholdCrypto Soroban contract
 * for on-chain state management and the off-chain crypto primitives
 * for actual cryptographic operations.
 */

import { log } from "./logger.js";
import * as tc from "./threshold-crypto.js";

// Types for protocol messages
export interface AuthorityInfo {
  index: number;
  address: string;
  name: string;
  verifierId: string;
  publicKeyShare: string;
  dkgCommitment: string;
  vssCommitments: string[];
}

export interface DkgRound {
  electionId: string; // `${daoId}:${proposalId}`
  thresholdN: number;
  thresholdT: number;
  authorities: AuthorityInfo[];
  jointPublicKey: string;
  phase: "registration" | "commitment" | "completed";
}

export interface EncryptedVote {
  voterNullifier: string;
  ciphertext: tc.Ciphertext;
  voteProof?: string;
}

export interface RelayNode {
  id: string;
  address: string;
  publicKey: string;
  weight: number;
  healthy: boolean;
}

export interface RelaySubmission {
  electionId: string;
  encryptedVote: EncryptedVote;
  receivedAt: number;
  viaRelay: string[];
}

export interface CoverTrafficConfig {
  enabled: boolean;
  minIntervalMs: number;
  maxIntervalMs: number;
  paddingVotesPerInterval: number;
}

export interface MissingVoteAlert {
  electionId: string;
  nullifier: string;
  detectedAt: number;
  reason: string;
}

export type ProtocolEvent =
  | { type: "authority_registered"; authority: string }
  | { type: "dkg_commitment"; authority: string; commitment: string }
  | { type: "joint_key_set"; key: string }
  | { type: "vote_encrypted"; count: number }
  | { type: "decryption_share"; authority: string }
  | { type: "tally_decrypted"; tally: string }
  | { type: "relay_registered"; relay: string }
  | { type: "relay_quorum_reached"; relayPath: string[] }
  | { type: "cover_traffic_sent"; count: number }
  | { type: "missing_vote_detected"; nullifier: string };

type EventHandler = (event: ProtocolEvent) => void;

/**
 * In-memory protocol state for active elections.
 * In production, this would be persisted to a database.
 */
class ProtocolState {
  private rounds: Map<string, DkgRound> = new Map();
  private encryptedVotes: Map<string, EncryptedVote[]> = new Map();
  private decryptionShares: Map<string, Map<number, string>> = new Map();
  private relayNodes: Map<string, RelayNode[]> = new Map();
  private relaySubmissions: Map<string, RelaySubmission[]> = new Map();
  private missingVoteAlerts: Map<string, MissingVoteAlert[]> = new Map();
  private coverTrafficTimer: ReturnType<typeof setInterval> | null = null;

  getRoundKey(daoId: number, proposalId: number): string {
    return `${daoId}:${proposalId}`;
  }

  getOrCreateRound(
    daoId: number,
    proposalId: number,
    thresholdN: number,
    thresholdT: number,
  ): DkgRound {
    const key = this.getRoundKey(daoId, proposalId);
    if (!this.rounds.has(key)) {
      this.rounds.set(key, {
        electionId: key,
        thresholdN,
        thresholdT,
        authorities: [],
        jointPublicKey: "",
        phase: "registration",
      });
    }
    return this.rounds.get(key)!;
  }

  getRound(daoId: number, proposalId: number): DkgRound | undefined {
    return this.rounds.get(this.getRoundKey(daoId, proposalId));
  }

  addAuthority(
    daoId: number,
    proposalId: number,
    authority: AuthorityInfo,
  ): void {
    const round = this.getOrCreateRound(daoId, proposalId, 0, 0);
    round.authorities.push(authority);
  }

  addEncryptedVote(
    daoId: number,
    proposalId: number,
    vote: EncryptedVote,
  ): void {
    const key = this.getRoundKey(daoId, proposalId);
    if (!this.encryptedVotes.has(key)) {
      this.encryptedVotes.set(key, []);
    }
    this.encryptedVotes.get(key)!.push(vote);
  }

  getEncryptedVotes(daoId: number, proposalId: number): EncryptedVote[] {
    return this.encryptedVotes.get(this.getRoundKey(daoId, proposalId)) || [];
  }

  addDecryptionShare(
    daoId: number,
    proposalId: number,
    authorityIndex: number,
    shareHex: string,
  ): void {
    const key = this.getRoundKey(daoId, proposalId);
    if (!this.decryptionShares.has(key)) {
      this.decryptionShares.set(key, new Map());
    }
    this.decryptionShares.get(key)!.set(authorityIndex, shareHex);
  }

  getDecryptionShares(
    daoId: number,
    proposalId: number,
  ): Array<{ authorityIndex: number; shareHex: string }> {
    const map = this.decryptionShares.get(this.getRoundKey(daoId, proposalId));
    if (!map) return [];
    return Array.from(map.entries()).map(([idx, hex]) => ({
      authorityIndex: idx,
      shareHex: hex,
    }));
  }

  getRelayNodes(daoId: number, proposalId: number): RelayNode[] {
    return this.relayNodes.get(this.getRoundKey(daoId, proposalId)) || [];
  }

  addRelayNode(daoId: number, proposalId: number, node: RelayNode): void {
    const key = this.getRoundKey(daoId, proposalId);
    if (!this.relayNodes.has(key)) {
      this.relayNodes.set(key, []);
    }
    this.relayNodes.get(key)!.push(node);
  }

  addRelaySubmission(
    daoId: number,
    proposalId: number,
    submission: RelaySubmission,
  ): void {
    const key = this.getRoundKey(daoId, proposalId);
    if (!this.relaySubmissions.has(key)) {
      this.relaySubmissions.set(key, []);
    }
    this.relaySubmissions.get(key)!.push(submission);
  }

  recordMissingVote(alert: MissingVoteAlert): void {
    if (!this.missingVoteAlerts.has(alert.electionId)) {
      this.missingVoteAlerts.set(alert.electionId, []);
    }
    this.missingVoteAlerts.get(alert.electionId)!.push(alert);
  }

  getMissingVoteAlerts(daoId: number, proposalId: number): MissingVoteAlert[] {
    return this.missingVoteAlerts.get(this.getRoundKey(daoId, proposalId)) || [];
  }

  setCoverTrafficTimer(
    timer: ReturnType<typeof setInterval> | null,
  ): void {
    this.coverTrafficTimer = timer;
  }

  getCoverTrafficTimer(): ReturnType<typeof setInterval> | null {
    return this.coverTrafficTimer;
  }

}

// Singleton state
const state = new ProtocolState();
const eventHandlers: Set<EventHandler> = new Set();

export function onEvent(handler: EventHandler): void {
  eventHandlers.add(handler);
}

function emitEvent(event: ProtocolEvent): void {
  for (const handler of eventHandlers) {
    try {
      handler(event);
    } catch (e) {
      log("error", "protocol_event_handler_failed", {
        event: event.type,
        error: (e as Error).message,
      });
    }
  }
}

export async function registerRelayNode(
  daoId: number,
  proposalId: number,
  node: Omit<RelayNode, "healthy">,
): Promise<void> {
  state.addRelayNode(daoId, proposalId, { ...node, healthy: true });
  emitEvent({ type: "relay_registered", relay: node.address });
}

export async function submitVoteViaRelayQuorum(
  daoId: number,
  proposalId: number,
  encryptedVote: EncryptedVote,
  relayPath: string[],
): Promise<void> {
  const round = state.getRound(daoId, proposalId);
  if (!round || !round.jointPublicKey) {
    throw new Error("DKG not completed for this election");
  }

  const healthyRelays = state
    .getRelayNodes(daoId, proposalId)
    .filter((relay) => relayPath.includes(relay.id) && relay.healthy);

  if (healthyRelays.length < round.thresholdT) {
    throw new Error("Relay quorum not reached");
  }

  state.addEncryptedVote(daoId, proposalId, encryptedVote);
  state.addRelaySubmission(daoId, proposalId, {
    electionId: state.getRoundKey(daoId, proposalId),
    encryptedVote,
    receivedAt: Date.now(),
    viaRelay: relayPath,
  });

  emitEvent({ type: "relay_quorum_reached", relayPath });
  emitEvent({
    type: "vote_encrypted",
    count: state.getEncryptedVotes(daoId, proposalId).length,
  });
}

export function startCoverTrafficScheduler(
  daoId: number,
  proposalId: number,
  config: CoverTrafficConfig,
): void {
  if (state.getCoverTrafficTimer()) return;

  const tick = () => {
    if (!config.enabled) return;
    const round = state.getRound(daoId, proposalId);
    if (!round || !round.jointPublicKey) return;

    for (let i = 0; i < config.paddingVotesPerInterval; i++) {
      // Padding ciphertexts are intentionally discarded so they never
      // enter the encrypted tally.
      tc.encryptVote(round.jointPublicKey, 0n);
    }

    emitEvent({
      type: "cover_traffic_sent",
      count: config.paddingVotesPerInterval,
    });
  };

  state.setCoverTrafficTimer(
    setInterval(tick, Math.max(config.minIntervalMs, 1)),
  );
}

export function stopCoverTrafficScheduler(): void {
  const timer = state.getCoverTrafficTimer();
  if (timer) {
    clearInterval(timer);
    state.setCoverTrafficTimer(null);
  }
}

export async function monitorMissingVotes(
  daoId: number,
  proposalId: number,
  expectedNullifiers: string[],
): Promise<MissingVoteAlert[]> {
  const submitted = new Set(
    state.getEncryptedVotes(daoId, proposalId).map((vote) => vote.voterNullifier),
  );
  const missing = expectedNullifiers.filter(
    (nullifier) => !submitted.has(nullifier),
  );
  const alerts: MissingVoteAlert[] = missing.map((nullifier) => ({
    electionId: state.getRoundKey(daoId, proposalId),
    nullifier,
    detectedAt: Date.now(),
    reason: "vote_not_received_by_relay_quorum",
  }));

  for (const alert of alerts) {
    state.recordMissingVote(alert);
    emitEvent({ type: "missing_vote_detected", nullifier: alert.nullifier });
  }

  return alerts;
}

// ── DKG Ceremony ──────────────────────────────────────────────────────

/**
 * Initialize a DKG ceremony for a new election.
 */
export async function initializeDKG(
  daoId: number,
  proposalId: number,
  thresholdN: number,
  thresholdT: number,
  creatorAddress: string,
): Promise<DkgRound> {
  log("info", "dkg_initializing", {
    daoId,
    proposalId,
    thresholdN,
    thresholdT,
  });

  const round = state.getOrCreateRound(
    daoId,
    proposalId,
    thresholdN,
    thresholdT,
  );

  emitEvent({
    type: "authority_registered",
    authority: creatorAddress,
  });

  return round;
}

/**
 * Register an authority and generate their DKG contribution.
 * Returns the shares to distribute to other authorities.
 */
export async function registerAuthority(
  daoId: number,
  proposalId: number,
  authorityAddress: string,
  authorityName: string,
  verifierId: string,
): Promise<{
  shares: Array<{ toIndex: number; value: bigint }>;
  commitments: string[];
}> {
  const round = state.getOrCreateRound(daoId, proposalId, 0, 0);
  const authorityIndex = round.authorities.length;

  // Generate this authority's DKG contribution
  const { shares, commitments } = tc.generateDKGShares(
    authorityIndex,
    round.thresholdT,
    round.thresholdN,
  );

  // Generate keypair from the authority's secret
  const keypair = tc.generateElGamalKeypair();

  const authority: AuthorityInfo = {
    index: authorityIndex,
    address: authorityAddress,
    name: authorityName,
    verifierId,
    publicKeyShare: keypair.publicKey,
    dkgCommitment: tc.g1ToHex(tc.G1_GENERATOR.multiply(keypair.privateKey)),
    vssCommitments: commitments,
  };

  state.addAuthority(daoId, proposalId, authority);

  emitEvent({
    type: "authority_registered",
    authority: authorityAddress,
  });

  return { shares, commitments };
}

/**
 * Finalize DKG: compute the joint public key from all authorities' commitments.
 */
export async function finalizeDKG(
  daoId: number,
  proposalId: number,
): Promise<{ jointPublicKey: string; authorities: AuthorityInfo[] }> {
  const round = state.getRound(daoId, proposalId);
  if (!round) throw new Error("DKG round not found");

  const allCommitments = round.authorities.map((a) => a.vssCommitments);
  const jointPublicKey = tc.computeJointPublicKey(allCommitments);

  round.jointPublicKey = jointPublicKey;
  round.phase = "completed";

  log("info", "dkg_completed", {
    daoId,
    proposalId,
    jointPublicKey: jointPublicKey.slice(0, 16) + "...",
  });

  emitEvent({ type: "joint_key_set", key: jointPublicKey });

  return { jointPublicKey, authorities: round.authorities };
}

// ── Vote Encryption ───────────────────────────────────────────────────

/**
 * Encrypt a vote using the joint public key.
 */
export async function encryptAndSubmitVote(
  daoId: number,
  proposalId: number,
  voteChoice: number,
  voterNullifier: string,
  relayPath: string[] = [],
): Promise<tc.Ciphertext> {
  const round = state.getRound(daoId, proposalId);
  if (!round || !round.jointPublicKey) {
    throw new Error("DKG not completed for this election");
  }

  const vote = BigInt(voteChoice);
  const ciphertext = tc.encryptVote(round.jointPublicKey, vote);

  if (relayPath.length > 0) {
    await submitVoteViaRelayQuorum(daoId, proposalId, {
      voterNullifier,
      ciphertext,
    }, relayPath);
    return ciphertext;
  }

  state.addEncryptedVote(daoId, proposalId, {
    voterNullifier,
    ciphertext,
  });

  emitEvent({
    type: "vote_encrypted",
    count: state.getEncryptedVotes(daoId, proposalId).length,
  });

  return ciphertext;
}

// ── Tally Computation ─────────────────────────────────────────────────

/**
 * Compute the encrypted tally from all encrypted votes.
 */
export async function computeEncryptedTally(
  daoId: number,
  proposalId: number,
): Promise<tc.Ciphertext> {
  const votes = state.getEncryptedVotes(daoId, proposalId);
  if (votes.length === 0) {
    throw new Error("No votes to tally");
  }

  const ciphertexts = votes.map((v) => v.ciphertext);
  return tc.aggregateTally(ciphertexts);
}

// ── Decryption ────────────────────────────────────────────────────────

/**
 * Generate a decryption share for an authority.
 */
export async function generateAuthorityDecryptionShare(
  daoId: number,
  proposalId: number,
  authorityAddress: string,
  privateKeyShare: bigint,
  encryptedTally: tc.Ciphertext,
): Promise<string> {
  const shareHex = tc.generateDecryptionShare(encryptedTally, privateKeyShare);

  const round = state.getRound(daoId, proposalId);
  if (!round) throw new Error("Round not found");

  const authority = round.authorities.find(
    (a) => a.address === authorityAddress,
  );
  if (!authority) throw new Error("Authority not found");

  state.addDecryptionShare(daoId, proposalId, authority.index, shareHex);

  emitEvent({
    type: "decryption_share",
    authority: authorityAddress,
  });

  return shareHex;
}

/**
 * Combine decryption shares and compute the final tally.
 */
export async function computeFinalTally(
  daoId: number,
  proposalId: number,
  encryptedTally: tc.Ciphertext,
): Promise<{ tally: bigint; proof: string; combinedShare: string }> {
  const shares = state.getDecryptionShares(daoId, proposalId);
  const round = state.getRound(daoId, proposalId);
  if (!round) throw new Error("Round not found");

  if (shares.length < round.thresholdT) {
    throw new Error(
      `Insufficient decryption shares: have ${shares.length}, need ${round.thresholdT}`,
    );
  }

  // Combine the shares using Lagrange interpolation
  const combinedShare = tc.combineDecryptionShares(shares);

  // Decrypt the tally
  const tally = tc.decryptTally(encryptedTally, combinedShare);

  // Generate a zero-knowledge proof of tally correctness
  const proof = tc.generateTallyProof(
    encryptedTally,
    combinedShare,
    tally,
    0n, // In threshold setting, full private key is reconstructed from shares
  );

  log("info", "tally_decrypted", {
    daoId,
    proposalId,
    tally: tally.toString(),
  });

  emitEvent({ type: "tally_decrypted", tally: tally.toString() });

  return { tally, proof, combinedShare };
}

// ── State Queries ─────────────────────────────────────────────────────

export function getProtocolState(
  daoId: number,
  proposalId: number,
): {
  dkgRound: DkgRound | undefined;
  encryptedVoteCount: number;
  decryptionShareCount: number;
  isTallyDecrypted: boolean;
  relayNodeCount: number;
  missingVoteCount: number;
} {
  const round = state.getRound(daoId, proposalId);
  const shares = state.getDecryptionShares(daoId, proposalId);
  const isDecrypted = round?.jointPublicKey ? true : false;

  return {
    dkgRound: round,
    encryptedVoteCount: state.getEncryptedVotes(daoId, proposalId).length,
    decryptionShareCount: shares.length,
    isTallyDecrypted: isDecrypted,
    relayNodeCount: state.getRelayNodes(daoId, proposalId).length,
    missingVoteCount: state.getMissingVoteAlerts(daoId, proposalId).length,
  };
}
