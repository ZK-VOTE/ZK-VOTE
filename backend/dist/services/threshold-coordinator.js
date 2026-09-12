// @ts-nocheck
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
/**
 * In-memory protocol state for active elections.
 * In production, this would be persisted to a database.
 */
class ProtocolState {
    rounds = new Map();
    encryptedVotes = new Map();
    decryptionShares = new Map();
    tallyResults = new Map();
    getRoundKey(daoId, proposalId) {
        return `${daoId}:${proposalId}`;
    }
    getOrCreateRound(daoId, proposalId, thresholdN, thresholdT) {
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
        return this.rounds.get(key);
    }
    getRound(daoId, proposalId) {
        return this.rounds.get(this.getRoundKey(daoId, proposalId));
    }
    addAuthority(daoId, proposalId, authority) {
        const round = this.getOrCreateRound(daoId, proposalId, 0, 0);
        round.authorities.push(authority);
    }
    addEncryptedVote(daoId, proposalId, vote) {
        const key = this.getRoundKey(daoId, proposalId);
        if (!this.encryptedVotes.has(key)) {
            this.encryptedVotes.set(key, []);
        }
        this.encryptedVotes.get(key).push(vote);
    }
    getEncryptedVotes(daoId, proposalId) {
        return this.encryptedVotes.get(this.getRoundKey(daoId, proposalId)) || [];
    }
    addDecryptionShare(daoId, proposalId, authorityIndex, shareHex) {
        const key = this.getRoundKey(daoId, proposalId);
        if (!this.decryptionShares.has(key)) {
            this.decryptionShares.set(key, new Map());
        }
        this.decryptionShares.get(key).set(authorityIndex, shareHex);
    }
    getDecryptionShares(daoId, proposalId) {
        const map = this.decryptionShares.get(this.getRoundKey(daoId, proposalId));
        if (!map)
            return [];
        return Array.from(map.entries()).map(([idx, hex]) => ({
            authorityIndex: idx,
            shareHex: hex,
        }));
    }
    setTallyResult(daoId, proposalId, tally, proof) {
        const key = this.getRoundKey(daoId, proposalId);
        this.tallyResults.set(key, { tally, proof });
    }
    getTallyResult(daoId, proposalId) {
        return this.tallyResults.get(this.getRoundKey(daoId, proposalId));
    }
}
// Singleton state
const state = new ProtocolState();
const eventHandlers = new Set();
export function onEvent(handler) {
    eventHandlers.add(handler);
}
function emitEvent(event) {
    for (const handler of eventHandlers) {
        try {
            handler(event);
        }
        catch (e) {
            log("error", "protocol_event_handler_failed", {
                event: event.type,
                error: e.message,
            });
        }
    }
}
export async function registerRelayNode(daoId, proposalId, node) {
    state.addRelayNode(daoId, proposalId, { ...node, healthy: true });
    emitEvent({ type: "relay_registered", relay: node.address });
}
export async function submitVoteViaRelayQuorum(daoId, proposalId, encryptedVote, relayPath) {
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
export function startCoverTrafficScheduler(daoId, proposalId, config) {
    if (state.getCoverTrafficTimer())
        return;
    const tick = () => {
        if (!config.enabled)
            return;
        const round = state.getRound(daoId, proposalId);
        if (!round || !round.jointPublicKey)
            return;
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
    state.setCoverTrafficTimer(setInterval(tick, Math.max(config.minIntervalMs, 1)));
}
export function stopCoverTrafficScheduler() {
    const timer = state.getCoverTrafficTimer();
    if (timer) {
        clearInterval(timer);
        state.setCoverTrafficTimer(null);
    }
}
export async function monitorMissingVotes(daoId, proposalId, expectedNullifiers) {
    const submitted = new Set(state.getEncryptedVotes(daoId, proposalId).map((vote) => vote.voterNullifier));
    const missing = expectedNullifiers.filter((nullifier) => !submitted.has(nullifier));
    const alerts = missing.map((nullifier) => ({
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
export async function initializeDKG(daoId, proposalId, thresholdN, thresholdT, creatorAddress) {
    log("info", "dkg_initializing", {
        daoId,
        proposalId,
        thresholdN,
        thresholdT,
    });
    const round = state.getOrCreateRound(daoId, proposalId, thresholdN, thresholdT);
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
export async function registerAuthority(daoId, proposalId, authorityAddress, authorityName, verifierId) {
    const round = state.getOrCreateRound(daoId, proposalId, 0, 0);
    const authorityIndex = round.authorities.length;
    // Generate this authority's DKG contribution
    const { shares, commitments } = tc.generateDKGShares(authorityIndex, round.thresholdT, round.thresholdN);
    // Generate keypair from the authority's secret
    const keypair = tc.generateElGamalKeypair();
    const authority = {
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
export async function finalizeDKG(daoId, proposalId) {
    const round = state.getRound(daoId, proposalId);
    if (!round)
        throw new Error("DKG round not found");
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
export async function encryptAndSubmitVote(daoId, proposalId, voteChoice, voterNullifier, relayPath = []) {
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
export async function computeEncryptedTally(daoId, proposalId) {
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
export async function generateAuthorityDecryptionShare(daoId, proposalId, authorityAddress, privateKeyShare, encryptedTally) {
    const shareHex = tc.generateDecryptionShare(encryptedTally, privateKeyShare);
    const round = state.getRound(daoId, proposalId);
    if (!round)
        throw new Error("Round not found");
    const authority = round.authorities.find((a) => a.address === authorityAddress);
    if (!authority)
        throw new Error("Authority not found");
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
export async function computeFinalTally(daoId, proposalId, encryptedTally) {
    const shares = state.getDecryptionShares(daoId, proposalId);
    const round = state.getRound(daoId, proposalId);
    if (!round)
        throw new Error("Round not found");
    if (shares.length < round.thresholdT) {
        throw new Error(`Insufficient decryption shares: have ${shares.length}, need ${round.thresholdT}`);
    }
    // Combine the shares using Lagrange interpolation
    const combinedShare = tc.combineDecryptionShares(shares);
    // Decrypt the tally
    const tally = tc.decryptTally(encryptedTally, combinedShare);
    // Generate a zero-knowledge proof of tally correctness
    const proof = tc.generateTallyProof(encryptedTally, combinedShare, tally, 0n);
    log("info", "tally_decrypted", {
        daoId,
        proposalId,
        tally: tally.toString(),
    });
    state.setTallyResult(daoId, proposalId, tally, proof);
    emitEvent({ type: "tally_decrypted", tally: tally.toString() });
    return { tally, proof, combinedShare };
}
// ── State Queries ─────────────────────────────────────────────────────
export function getProtocolState(daoId, proposalId) {
    const round = state.getRound(daoId, proposalId);
    const shares = state.getDecryptionShares(daoId, proposalId);
    const tallyResult = state.getTallyResult(daoId, proposalId);
    return {
        dkgRound: round,
        encryptedVoteCount: state.getEncryptedVotes(daoId, proposalId).length,
        decryptionShareCount: shares.length,
        isTallyDecrypted: !!tallyResult,
        decryptedTally: tallyResult ? tallyResult.tally.toString() : null,
    };
}
//# sourceMappingURL=threshold-coordinator.js.map