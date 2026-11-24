import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/Button";
import Alert from "./ui/Alert";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { getZkVoteClient } from "../lib/client";
import { relayerFetch } from "../lib/api";
import { resolveCircuitUrls } from "../lib/circuitDepth";
import {
  generateVoteProof,
  formatProofForSoroban,
  calculateNullifier,
  type ProofInput,
} from "../lib/zkproof";
import { assertValidNullifier, assertValidFieldElement } from "../types/index";
import { fetchWithProgress } from "../lib/fetchWithProgress";
import { provingPreflightError } from "../lib/devicePreflight";
import { getMerklePath } from "../lib/merkletree";
import { useOptimisticVote } from "../queries/proposalQueries";
import { isWrongNetwork, type RelayerStatus } from "../queries/relayerQueries";
import { queryKeys } from "../lib/queryClient";
import {
  generateDeterministicZKCredentials,
  generateFakeZKCredentials,
  getZKCredentials,
  storeZKCredentials,
} from "../lib/zk";
import { submissionQueue, type VotePayload } from "../store/submissionQueue";
import {
  networkLabel,
  APP_NETWORK_PASSPHRASE,
  shortAccount,
  walletSession,
  WalletSessionError,
} from "../lib/walletSession";
import { processEntry } from "../lib/queueProcessor";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  X,
  WifiOff,
} from "lucide-react";
import { useReceipts } from "../hooks/useReceipts";
import VoteModeExplainer from "./ui/VoteModeExplainer";
import {
  useProofPhase,
  CANCELABLE_PHASES,
  phaseLabel,
  phaseDescription,
  formatElapsed,
} from "../lib/proofPhase";

interface VoteModalProps {
  proposalId: number;
  eligibleRoot: bigint; // Snapshot of Merkle root when proposal was created
  voteMode: "Fixed" | "Trailing"; // Vote mode: Fixed (snapshot) or Trailing (dynamic)
  vkVersion?: number | null;
  /**
   * The election's declared Merkle depth, as stored on-chain. `0` — the
   * default — means the election uses the default circuit (#93).
   */
  merkleDepth?: number;
  /** When present, use the encrypted-tally path (choice never public). */
  encryption?: {
    publicKey: { x: string; y: string };
    epoch: number;
  };
  /**
   * Candidate count bound into the vote circuit public signals.
   * Must match on-chain `ElectionConfig.num_candidates` (#645).
   *
   * Leave undefined to have this component read the value the contract will
   * verify against (`get_effective_num_candidates`), which is the only way to
   * be sure the two agree. A hardcoded default of 2 silently disagrees with any
   * election that configured a different count. Pass a value only when the
   * caller already knows it.
   */
  numCandidates?: number;
  daoId: number;
  publicKey: string;
  kit: StellarWalletsKit | null;
  onClose: () => void;
  onComplete: () => void;
}

type VoteStep =
  | "select"
  | "generating"
  | "submitting"
  | "success"
  | "queued"
  | "held"
  | "error";

export default function VoteModal({
  proposalId,
  eligibleRoot,
  voteMode,
  vkVersion: _vkVersion,
  merkleDepth = 0,
  encryption,
  numCandidates,
  daoId,
  publicKey,
  kit,
  onClose,
  onComplete,
}: VoteModalProps) {
  const [step, setStep] = useState<VoteStep>("select");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [isOfflineQueued, setIsOfflineQueued] = useState(false);
  const [panicMode, setPanicMode] = useState(false);
  const [heldReason, setHeldReason] = useState<string | null>(null);
  const { addReceipt } = useReceipts();
  const { setOptimisticVote, clearPendingVote } = useOptimisticVote();
  const queryClient = useQueryClient();
  const proofPhase = useProofPhase();
  // Ref used to signal tab-visibility interruptions during proving.
  const provingActiveRef = useRef(false);

  // Escape closes the dialog, the same as clicking the backdrop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Tab-visibility guard (ZV-057): if the tab goes hidden while proving is
  // active the proof worker keeps running in the background (workers are not
  // suspended by visibility changes). We just note the event; the submission
  // queue already holds the proof once provingActiveRef is true, so it will
  // be submitted when the tab comes back or on the next page load.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && provingActiveRef.current) {
        // The proof is already in the queue (proofRetained) or will be
        // enqueued before submitting. Nothing to discard — just leave the
        // in-flight worker running.
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const handleVote = async (choice: boolean) => {
    setStep("generating");
    setError(null);
    proofPhase.advance("preparing");
    provingActiveRef.current = true;

    try {
      // Wallet session (#750): refuse to start unless this account is
      // connected on the app's network, and remember the session so every
      // later step can tell if the wallet changed underneath the proof.
      walletSession.assertCanBuild(publicKey);
      const session = walletSession.snapshot();
      const binding = await walletSession.currentBinding();

      // Fail before the expensive proving step if the relayer is on another network
      const relayer = queryClient.getQueryData<{ status: RelayerStatus }>(
        queryKeys.relayer.status(),
      );
      if (isWrongNetwork(relayer?.status)) {
        throw new Error(
          "The relayer is connected to a different Stellar network than this app, so your vote could not be counted. Voting is blocked until they match.",
        );
      }

      // Initialize contract clients
      const clients = getZkVoteClient(publicKey);

      // ENCRYPTED TALLY (vote-choice privacy): the choice is encrypted
      // client-side and only ciphertext reaches the relayer/ledger. The
      // plaintext path below is retained for legacy proposals created before
      // the encrypted circuit was registered.
      if (encryption && !panicMode) {
        setProgress("Encrypting ballot...");
        setStep("submitting");
        const result = await clients.orchestrateEncryptedVote({
          daoId,
          proposalId,
          choice,
          kit: kit as never,
          voteMode,
          eligibleRoot,
          encryptionPublicKey: {
            x: BigInt(encryption.publicKey.x),
            y: BigInt(encryption.publicKey.y),
          },
          epoch: encryption.epoch,
        });
        setProgress(
          `Encrypted vote submitted (${result.ciphertext.c1.slice(0, 12)}...)`,
        );
        setStep("success");
        onComplete();
        return;
      }

      // Step 1: Load registration data (or regenerate from wallet)
      //
      // COERCION-RESISTANCE (§panic-mode / THREAT_MODEL §coercion):
      // When panicMode is active, we intentionally use randomly-generated
      // "fake" credentials instead of the voter's real credentials.
      // The resulting ZK proof is structurally valid (passes the circuit)
      // but the fake commitment is NOT in the on-chain membership Merkle
      // tree, so the vote will be rejected on-chain. The coercer sees a
      // valid-looking proof being submitted — they cannot distinguish it
      // from a real vote. The real credentials remain usable afterwards.
      setProgress("Loading voting credentials...");
      let secret: string,
        salt: string,
        blindingFactor: string,
        commitment: string,
        leafIndex: number;

      if (panicMode) {
        // PANIC MODE: generate fresh random credentials each time.
        // Never touch or reveal the real credentials.
        setProgress("Loading decoy credentials (coercion-resistant mode)...");
        const fakeCredentials = await generateFakeZKCredentials();
        secret = fakeCredentials.secret;
        salt = fakeCredentials.salt;
        blindingFactor = fakeCredentials.blindingFactor;
        commitment = fakeCredentials.commitment;
        // Use a fake leaf index (0) — the Merkle path won't match anyway
        leafIndex = 0;
        if (import.meta.env.DEV)
          console.log("[Vote] PANIC MODE — using fake credentials");
      } else {
        const cached = getZKCredentials(daoId, publicKey);

        if (!cached) {
          // Try to regenerate from wallet signature
          if (import.meta.env.DEV)
            console.log("[Vote] No cached credentials, regenerating...");

          if (!kit) {
            throw new Error(
              "You must register for voting first. Please click 'Register for Voting' button.",
            );
          }

          // xBull/Albedo send no account events: confirm who will sign.
          await walletSession.verifyLiveAccount(kit);
          walletSession.checkpoint(session);

          setProgress("Regenerating credentials from wallet signature...");
          const credentials = await generateDeterministicZKCredentials(
            kit,
            daoId,
          );

          // Get leaf index from contract
          const leafIndexResult = await clients.membershipTree.get_leaf_index({
            dao_id: BigInt(daoId),
            commitment: BigInt(credentials.commitment),
          });

          leafIndex = Number(leafIndexResult.result);
          secret = credentials.secret;
          salt = credentials.salt;
          blindingFactor = credentials.blindingFactor;
          commitment = credentials.commitment;

          // Cache for next time
          storeZKCredentials(daoId, publicKey, credentials, leafIndex);

          if (import.meta.env.DEV)
            console.log("[Vote] Credentials regenerated");
        } else {
          secret = cached.secret;
          salt = cached.salt;
          blindingFactor = cached.blindingFactor;
          commitment = cached.commitment;
          leafIndex = cached.leafIndex;
        }
      }

      if (import.meta.env.DEV)
        console.log("Using credentials (leaf index:", leafIndex, ")");

      // Step 2: Select root based on vote mode
      // Fixed mode: Use snapshot root from proposal creation
      // Trailing mode: Use current root (allows new members to vote)
      let root: bigint;
      if (voteMode === "Fixed") {
        setProgress("Using proposal snapshot root (Fixed mode)...");
        root = eligibleRoot;
        if (import.meta.env.DEV)
          console.log("Fixed mode - using snapshot root");
      } else {
        setProgress("Fetching current root (Trailing mode)...");
        const currentRootResult = await clients.membershipTree.current_root({
          dao_id: BigInt(daoId),
        });
        root = currentRootResult.result;
        if (import.meta.env.DEV)
          console.log("Trailing mode - using current root");
      }

      // Step 3: Get Merkle path from contract
      setProgress("Fetching Merkle path from tree...");
      const { pathElements, pathIndices } = await getMerklePath(
        leafIndex,
        daoId,
        publicKey,
      );

      if (import.meta.env.DEV) console.log("Merkle path computed");
      walletSession.checkpoint(session);

      // Step 4: Compute nullifier using Poseidon hash
      // nullifier = Poseidon(secret, daoId, proposalId)
      setProgress("Computing nullifier...");
      const nullifier = await calculateNullifier(
        secret,
        daoId.toString(),
        proposalId.toString(),
      );

      // Validate proof inputs using shared field/nullifier helpers (#370)
      // These guards catch malformed values before they reach the circuit,
      // preventing hard-to-diagnose WASM errors at the circuit level.
      assertValidNullifier(nullifier);
      assertValidFieldElement(root.toString(), "root");

      // Step 4: Download circuit artifacts with progress (the proving key
      // is several MB and is the main bottleneck for perceived performance)
      // Merkle depth is fixed at circuit compile time, so a depth-N election
      // needs the artifacts built for Vote(N); the default circuit's are used
      // when the election declares no depth (#93).
      const artifacts = resolveCircuitUrls(merkleDepth);
      const preflightError = provingPreflightError();
      if (preflightError) throw new Error(preflightError);
      const zkey = await fetchWithProgress(
        artifacts.zkeyUrl,
        ({ loadedBytes, totalBytes }) => {
          const pct = totalBytes
            ? Math.round((loadedBytes / totalBytes) * 100)
            : 0;
          // Only real byte-count boundaries produce a percentage (ZV-057).
          if (totalBytes) proofPhase.setDownloadPct(pct);
          setProgress(`Downloading proving key... ${pct}%`);
        },
      );
      const wasm = await fetchWithProgress(artifacts.wasmUrl);
      // Last stop before ~60 s of proving: do not start it for a session
      // that has already ended.
      walletSession.checkpoint(session);

      // Step 4b: Generate ZK proof — advance to 'proving' phase boundary.
      proofPhase.advance("proving");
      setProgress("Generating zero-knowledge proof...");

      // The circuit constrains `voteChoice < numCandidates` against this PUBLIC
      // signal, and the contract verifies the proof with the same value. It
      // cannot be omitted: at 0 the constraint is unsatisfiable and no witness
      // exists.
      //
      // The contract is the source of truth — it knows the configured count and
      // floors at 2 for a binary ballot. A caller-supplied `numCandidates` prop
      // wins when provided, so a caller that already knows the value does not
      // pay for the read.
      let effectiveNumCandidates = numCandidates;
      if (effectiveNumCandidates === undefined) {
        const numCandidatesResult =
          await clients.voting.get_effective_num_candidates({
            dao_id: BigInt(daoId),
            proposal_id: BigInt(proposalId),
          });
        effectiveNumCandidates = numCandidatesResult.result;
      }

      const proofInput: ProofInput = {
        // Public signals
        root: root.toString(),
        nullifier: nullifier.toString(),
        daoId: daoId.toString(),
        proposalId: proposalId.toString(),
        voteChoice: choice ? "1" : "0",
        // Must match on-chain ElectionConfig.num_candidates. The contract is
        // the source of truth; a caller-supplied `numCandidates` prop wins when
        // provided.
        numCandidates: effectiveNumCandidates.toString(),
        commitment: commitment.toString(), // Private input - computed in circuit, not exposed publicly
        // Note: vkVersion is NOT a circuit signal - it's checked on-chain only
        // Private signals
        secret: secret.toString(),
        salt: salt.toString(),
        blindingFactor: blindingFactor.toString(),
        pathElements,
        pathIndices,
      };

      if (import.meta.env.DEV) {
        console.log("Proof input ready, generating proof...");
      }

      const { proof, publicSignals, redundantProof } = await generateVoteProof(
        proofInput,
        wasm,
        zkey,
      );

      // Step 4.5: Verify proof locally before submitting
      setProgress("Verifying proof locally...");
      const { verifyProofLocally } = await import("../lib/zkproof");
      const isValid = await verifyProofLocally(
        proof,
        publicSignals,
        "/circuits/verification_key.json",
      );

      if (import.meta.env.DEV)
        console.log("Local proof verification:", isValid);

      if (!isValid) {
        throw new Error(
          "Local proof verification failed. Circuit artifacts may be missing or mismatched (check /circuits/vote.wasm and verification_key.json), or the witness may be incomplete.",
        );
      }

      // Step 5: Format proof for Soroban — advance to 'packaging' phase boundary.
      proofPhase.advance("packaging");
      setProgress("Formatting proof...");
      const { proof_a, proof_b, proof_c } = formatProofForSoroban(proof);
      const formattedRedundantProof = redundantProof
        ? formatProofForSoroban(redundantProof)
        : null;

      // Step 6: Build the vote payload
      setStep("submitting");
      setProgress("Preparing vote submission...");

      // Convert U256 to big-endian hex (U256 values use big-endian, unlike BN254 curve points which use little-endian)
      const toHexBE = (value: string | bigint): string => {
        const bigInt = typeof value === "string" ? BigInt(value) : value;
        return bigInt.toString(16).padStart(64, "0");
      };

      const votePayload: VotePayload & { redundantProof?: unknown } = {
        daoId: Number(daoId),
        proposalId: Number(proposalId),
        choice: choice,
        nullifier: toHexBE(nullifier),
        root: toHexBE(root),
        proof: {
          a: proof_a,
          b: proof_b,
          c: proof_c,
        },
        ...(formattedRedundantProof
          ? {
              redundantProof: {
                a: formattedRedundantProof.proof_a,
                b: formattedRedundantProof.proof_b,
                c: formattedRedundantProof.proof_c,
              },
            }
          : {}),
        timestamp: Date.now(),
      } as VotePayload & { redundantProof?: unknown };

      // Do not attach voterPublicKey / voterSignature — that links the wallet
      // to the nullifier and ballot in transit and in localStorage (#644).

      // Step 7: Deduplication check — if this nullifier is already in the
      // queue as submitted or conflict, surface that to the user.
      const existingEntry =
        submissionQueue.getState().entries[votePayload.nullifier];
      if (existingEntry) {
        if (existingEntry.status === "submitted") {
          // Already successfully submitted — idempotent success
          setStep("success");
          onComplete();
          return;
        }
        if (existingEntry.status === "conflict") {
          // Already recorded as a conflict
          setStep("error");
          setError(
            existingEntry.conflictDetail ||
              "You have already voted on this proposal.",
          );
          return;
        }
      }

      // The wallet changed while proving (#750). The proof is complete and
      // only valid for the account that built it, so hold it for that
      // account instead of submitting it from this one. It resumes when that
      // account reconnects on the right network; no re-prove needed.
      const change = walletSession.changeSince(session);
      if (change && change !== "reconnected") {
        submissionQueue.enqueue(votePayload, binding);
        setHeldReason(
          change === "network_mismatch"
            ? `Your wallet switched networks while your proof was being generated. Your vote is saved and will be submitted when your wallet is back on ${networkLabel(APP_NETWORK_PASSPHRASE)}.`
            : `Your wallet ${change === "disconnected" ? "disconnected" : "switched accounts"} while your proof was being generated. Your vote is saved and will be submitted when ${shortAccount(publicKey)} reconnects.`,
        );
        setStep("held");
        return;
      }

      // Optimistic tally preview — reverted if submission does not land
      const revertOptimisticUpdate = setOptimisticVote(
        daoId,
        proposalId,
        choice,
      );

      // Step 8: Enqueue the vote (persists to localStorage for offline resilience).
      // Mark proof retained before enqueueing so tab-visibility and cancel
      // both know the proof is durable.
      proofPhase.markProofRetained();
      setProgress("Queuing vote submission...");
      const entry = submissionQueue.enqueue(votePayload, binding);

      // If we're offline, show the queued state and return
      const isCurrentlyOffline = !navigator.onLine;
      if (isCurrentlyOffline) {
        setIsOfflineQueued(true);
        setStep("queued");
        onComplete();
        return;
      }

      // Step 9: Await submission — only show success when the relay accepts (#646).
      proofPhase.advance("submitting");
      setProgress("Submitting anonymous vote through relay...");
      setStep("submitting");

      proofPhase.advance("confirming");
      await processEntry(entry);

      const finalEntry =
        submissionQueue.getState().entries[votePayload.nullifier];

      if (finalEntry?.status === "submitted") {
        if (finalEntry.txHash) {
          addReceipt({
            txHash: finalEntry.txHash,
            nullifier: votePayload.nullifier,
            timestamp: Date.now(),
            daoId: Number(daoId),
            proposalId: Number(proposalId),
          });
        }
        proofPhase.advance("complete");
        provingActiveRef.current = false;
        clearPendingVote(daoId, proposalId);
        setStep("success");
        onComplete();
        return;
      }

      if (finalEntry?.status === "conflict") {
        revertOptimisticUpdate();
        setStep("error");
        setError(
          finalEntry.conflictDetail ||
            "You have already voted on this proposal.",
        );
        return;
      }

      if (finalEntry?.status === "failed") {
        revertOptimisticUpdate();
        setStep("error");
        setError(
          finalEntry.lastError || "Vote submission failed. Please try again.",
        );
        return;
      }

      // pending / retryable — keep optimistic preview, show queued UI
      setIsOfflineQueued(false);
      setStep("queued");
      onComplete();
    } catch (err) {
      provingActiveRef.current = false;
      setStep("error");
      let errorMsg =
        err instanceof Error ? err.message : "Failed to submit vote";

      // Detect Merkle root mismatch (joined after proposal creation)
      if (err instanceof WalletSessionError) {
        // Already a complete, user-facing explanation.
      } else if (
        errorMsg.includes("Assert Failed") ||
        errorMsg.includes("Error in template Vote")
      ) {
        if (voteMode === "Fixed") {
          errorMsg =
            "Cannot vote on this proposal. You joined the DAO after this proposal was created. Only members who were present when the proposal was created can vote on it (snapshot voting).";
        } else {
          errorMsg =
            "Proof generation failed. This may indicate an issue with your voting credentials or the Merkle tree state. Please try registering for voting again.";
        }
      }

      setError(errorMsg);
      proofPhase.fail(errorMsg);
      console.error("Vote submission failed:", err);
    }
  };

  const handleCancel = () => {
    // Only cancels before the proof has been queued. After proofRetained the
    // proof is already durable; the UI shows "Vote Saved, Not Sent" instead.
    proofPhase.reset();
    setStep("select");
    setError(null);
    setProgress("");
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-[100] animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vote-modal-title"
        className="relative w-[calc(100%-2rem)] max-w-lg max-h-[85dvh] flex flex-col overflow-hidden bg-card border border-border rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with inline close button */}
        <div className="flex items-start justify-between p-4 sm:p-6 border-b border-border/60 shrink-0">
          <div>
            <h3
              id="vote-modal-title"
              className="text-xl font-bold tracking-tight text-foreground"
            >
              Cast Anonymous Vote
            </h3>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Your vote will be verified using zero-knowledge proofs to ensure
              anonymity while proving membership.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close voting dialog"
            className="h-10 w-10 min-h-[48px] min-w-[48px] sm:h-8 sm:w-8 sm:min-h-0 sm:min-w-0 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 ms-2"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
          {step === "select" && (
            <>
              <VoteModeExplainer mode={voteMode} />

              {/* ── PANIC MODE TOGGLE (coercion resistance) ─────────────────────
                  THREAT_MODEL §coercion: if a voter is being coerced, they can
                  activate panic mode to submit a structurally-valid ZK proof
                  backed by fake (random) credentials. The proof will be rejected
                  on-chain because the commitment is not in the membership tree,
                  but the coercer cannot distinguish it from a real submission.
                  The real credentials remain usable after the coercive situation
                  ends. ──────────────────────────────────────────────────────── */}
              <div className="border border-yellow-500/40 rounded-lg p-3 bg-yellow-500/5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle
                      className="h-4 w-4 text-yellow-500 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-xs font-semibold text-yellow-700 dark:text-yellow-400">
                      Coercion-resistant mode
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={panicMode}
                    aria-label={
                      panicMode ? "Disable panic mode" : "Enable panic mode"
                    }
                    onClick={() => setPanicMode((prev: boolean) => !prev)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500 ${
                      panicMode ? "bg-yellow-500" : "bg-muted"
                    }`}
                    data-testid="panic-mode-toggle"
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                        panicMode ? "translate-x-4" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                {panicMode && (
                  <div
                    className="mt-2 space-y-1"
                    role="alert"
                    aria-live="assertive"
                    data-testid="panic-mode-warning"
                  >
                    <p className="text-xs font-bold text-yellow-700 dark:text-yellow-400">
                      ⚠ Panic mode is ON — decoy credentials will be used
                    </p>
                    <p className="text-xs text-yellow-600 dark:text-yellow-300">
                      Your vote will appear valid but will NOT be recorded
                      on-chain. Your real credentials are never touched. You can
                      cast your real vote after the coercive situation ends by
                      disabling this mode.
                    </p>
                  </div>
                )}
              </div>

              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2"
                role="group"
                aria-label="Vote options"
              >
                <Button
                  onClick={() => handleVote(true)}
                  variant="outline"
                  aria-label="Vote yes on this proposal"
                  className="min-h-[48px] text-base font-semibold border-green-500/40 text-green-600 dark:text-green-400 hover:bg-green-500/10"
                >
                  Vote Yes
                </Button>
                <Button
                  onClick={() => handleVote(false)}
                  variant="outline"
                  aria-label="Vote no on this proposal"
                  className="min-h-[48px] text-base font-semibold border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                >
                  Vote No
                </Button>
              </div>
            </>
          )}

          {(step === "generating" || step === "submitting") && (
            <div className="py-8 flex flex-col items-center text-center space-y-4">
              <div className="relative">
                {/* Reduced-motion: skip the ping animation when prefers-reduced-motion is set */}
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping motion-reduce:animate-none" />
                <div className="relative bg-background rounded-full p-4 border shadow-sm">
                  <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
                </div>
              </div>
              {/* Phase label — announced to screen readers when it changes */}
              <div
                className="space-y-1"
                aria-live="polite"
                aria-atomic="true"
              >
                <h3 className="font-semibold text-lg">
                  {phaseLabel(proofPhase.state.phase)}
                </h3>
                <p className="text-sm text-muted-foreground max-w-[260px] mx-auto">
                  {phaseDescription(proofPhase.state.phase)}
                </p>
                {/* Elapsed time — only shown for phases that can take a while */}
                {proofPhase.state.elapsedMs >= 2000 && (
                  <p
                    className="text-xs text-muted-foreground tabular-nums"
                    aria-label={`Elapsed: ${formatElapsed(proofPhase.state.elapsedMs)}`}
                  >
                    {formatElapsed(proofPhase.state.elapsedMs)}
                  </p>
                )}
                {/* Real download percentage — only during preparing when byte counts are available */}
                {proofPhase.state.phase === "preparing" &&
                  proofPhase.state.downloadPct !== undefined && (
                    <p className="text-xs text-muted-foreground">
                      Downloading proving key… {proofPhase.state.downloadPct}%
                    </p>
                  )}
              </div>
              <Alert className="mt-4 bg-muted/50 border-none">
                <p className="text-xs text-muted-foreground">
                  This process uses heavy cryptography in your browser. Please
                  don't close this window.
                </p>
              </Alert>
              {/* Cancel — only available before the proof is queued */}
              {CANCELABLE_PHASES.has(proofPhase.state.phase) &&
                !proofPhase.state.proofRetained && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    aria-label="Cancel proof generation and return to vote selection"
                  >
                    Cancel
                  </Button>
                )}
            </div>
          )}

          {step === "success" && (
            <div
              className="py-8 flex flex-col items-center text-center space-y-4"
              aria-live="assertive"
              aria-atomic="true"
            >
              <div className="h-16 w-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-2">
                <CheckCircle
                  className="h-8 w-8 text-green-600 dark:text-green-400"
                  aria-hidden="true"
                />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-xl">Vote Submitted!</h3>
                <p className="text-sm text-muted-foreground">
                  Your anonymous vote has been recorded on the blockchain.
                </p>
              </div>
              <Button onClick={onClose} className="w-full min-h-[48px] mt-4">
                Done
              </Button>
            </div>
          )}

          {step === "queued" && (
            <div
              className="py-8 flex flex-col items-center text-center space-y-4"
              aria-live="assertive"
              aria-atomic="true"
            >
              <div className="h-16 w-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-2">
                <WifiOff
                  className="h-8 w-8 text-blue-600 dark:text-blue-400"
                  aria-hidden="true"
                />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-xl">Vote Queued</h3>
                <p className="text-sm text-muted-foreground">
                  {isOfflineQueued
                    ? "You appear to be offline. Your vote has been saved and will be submitted automatically when you reconnect."
                    : "Your vote has been queued and will be submitted shortly."}
                </p>
              </div>
              <Alert className="text-xs text-start">
                <AlertTriangle
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Do not cast this vote again — it will be submitted
                  automatically. A status notification will appear if any issue
                  occurs.
                </span>
              </Alert>
              <Button onClick={onClose} className="w-full min-h-[48px] mt-4">
                Done
              </Button>
            </div>
          )}

          {step === "held" && (
            <div
              className="py-8 flex flex-col items-center text-center space-y-4"
              aria-live="assertive"
              aria-atomic="true"
              data-testid="vote-held"
            >
              <div className="h-16 w-16 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mb-2">
                <AlertTriangle
                  className="h-8 w-8 text-yellow-600 dark:text-yellow-400"
                  aria-hidden="true"
                />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-xl">Vote Saved, Not Sent</h3>
                <p className="text-sm text-muted-foreground">{heldReason}</p>
              </div>
              <Alert className="text-xs text-start">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Do not vote again from another account. Nothing has been
                  submitted, and this vote will only ever be sent from the
                  account that created it.
                </span>
              </Alert>
              <Button onClick={onClose} className="w-full min-h-[48px] mt-4">
                Done
              </Button>
            </div>
          )}

          {step === "error" && (
            <div
              className="space-y-4"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
            >
              <div className="flex items-center gap-2 text-destructive font-semibold text-lg">
                <XCircle className="h-5 w-5" aria-hidden="true" />
                Error
              </div>
              <Alert variant="error">{error}</Alert>
              {/* If the proof was already queued before the error, tell the user
                  they don't need to re-prove — the proof is retained. */}
              {proofPhase.state.proofRetained && (
                <Alert className="text-xs text-start bg-muted/40 border-muted">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    Your proof has been saved. If you retry, the existing proof
                    will be reused — you don't need to generate it again.
                  </span>
                </Alert>
              )}
              <Button
                variant="secondary"
                size="lg"
                className="w-full min-h-[48px]"
                onClick={onClose}
              >
                Close
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
