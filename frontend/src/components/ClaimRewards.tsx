import { useState } from "react";
import { Button } from "./ui/Button";
import Alert from "./ui/Alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { getZkVoteClient } from "../lib/client";
import { relayerFetch } from "../lib/api";
import {
  generateClaimProof,
  formatProofForSoroban,
  calculateNullifier,
  calculateClaimNullifier,
} from "../lib/zkproof";
import { getMerklePath } from "../lib/merkletree";
import {
  generateDeterministicZKCredentials,
  getZKCredentials,
  storeZKCredentials,
} from "../lib/zk";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  X,
  Gift,
} from "lucide-react";

interface ClaimRewardsProps {
  daoId: number;
  proposalId: number;
  eligibleRoot: bigint;
  voteMode: "Fixed" | "Trailing";
  publicKey: string;
  kit: StellarWalletsKit | null;
  onClose: () => void;
  onComplete: () => void;
}

type ClaimStep = "select" | "generating" | "submitting" | "success" | "error";

export default function ClaimRewards({
  daoId,
  proposalId,
  eligibleRoot,
  voteMode,
  publicKey,
  kit,
  onClose,
  onComplete,
}: ClaimRewardsProps) {
  const [step, setStep] = useState<ClaimStep>("select");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");

  const handleClaim = async () => {
    setStep("generating");
    setError(null);
    try {
      const clients = getZkVoteClient(publicKey);

      setProgress("Loading voting credentials...");
      let secret: string, salt: string, leafIndex: number;
      const cached = getZKCredentials(daoId, publicKey);
      if (!cached) {
        if (!kit)
          throw new Error(
            "You must register for voting first. Please click 'Register for Voting'.",
          );
        setProgress("Regenerating credentials from wallet signature...");
        const credentials = await generateDeterministicZKCredentials(
          kit,
          daoId,
        );
        const leafIndexResult = await clients.membershipTree.get_leaf_index({
          dao_id: BigInt(daoId),
          commitment: BigInt(credentials.commitment),
        });
        leafIndex = Number(leafIndexResult.result);
        secret = credentials.secret;
        salt = credentials.salt;
        storeZKCredentials(daoId, publicKey, credentials, leafIndex);
      } else {
        secret = cached.secret;
        salt = cached.salt;
        leafIndex = cached.leafIndex;
      }

      // Check that user has voted (gate: only voters can claim)
      setProgress("Checking vote status...");
      const voteNullifierPre = await calculateNullifier(
        secret,
        daoId.toString(),
        proposalId.toString(),
      );
      const isVotedResult = await clients.voting.is_nullifier_used({
        dao_id: BigInt(daoId),
        proposal_id: BigInt(proposalId),
        nullifier: BigInt(voteNullifierPre),
      });
      if (!isVotedResult.result) {
        throw new Error(
          "You must vote on this proposal before claiming rewards. Only voters can claim.",
        );
      }

      // Select root
      let root: bigint;
      if (voteMode === "Fixed") {
        setProgress("Using proposal snapshot root (Fixed mode)...");
        root = eligibleRoot;
      } else {
        setProgress("Fetching current root (Trailing mode)...");
        const currentRootResult = await clients.membershipTree.current_root({
          dao_id: BigInt(daoId),
        });
        root = currentRootResult.result;
      }

      setProgress("Fetching Merkle path...");
      const { pathElements, pathIndices } = await getMerklePath(
        leafIndex,
        daoId,
        publicKey,
      );

      setProgress("Computing nullifiers (vote + claim)...");
      const voteNullifier = await calculateNullifier(
        secret,
        daoId.toString(),
        proposalId.toString(),
      );
      const claimNullifier = await calculateClaimNullifier(
        secret,
        daoId.toString(),
        proposalId.toString(),
      );

      setProgress("Generating zero-knowledge claim proof...");
      const wasmPath = "/circuits/claim.wasm";
      const zkeyPath = "/circuits/claim_final.zkey";

      const { proof, publicSignals } = await generateClaimProof(
        {
          secret: secret.toString(),
          salt: salt.toString(),
          root: root.toString(),
          voteNullifier: voteNullifier.toString(),
          claimNullifier: claimNullifier.toString(),
          daoId: daoId.toString(),
          proposalId: proposalId.toString(),
          pathElements,
          pathIndices,
        },
        wasmPath,
        zkeyPath,
      );

      setProgress("Verifying proof locally...");
      const { verifyProofLocally } = await import("../lib/zkproof");
      const isValid = await verifyProofLocally(
        proof,
        publicSignals,
        "/circuits/claim_verification_key.json",
      );
      // If local verification fails but we are in production, still submit — local VK may be missing
      if (!isValid && import.meta.env.DEV) {
        console.warn(
          "Local claim proof verification: false (may be missing VK)",
        );
      }

      setProgress("Formatting proof...");
      const { proof_a, proof_b, proof_c } = formatProofForSoroban(proof);

      setStep("submitting");
      setProgress("Submitting anonymous claim through relayer...");

      const toHexBE = (value: string | bigint): string => {
        const bigInt = typeof value === "string" ? BigInt(value) : value;
        return bigInt.toString(16).padStart(64, "0");
      };

      const response = await relayerFetch("/api/v1/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId: Number(daoId),
          proposalId: Number(proposalId),
          voteNullifier: toHexBE(voteNullifier),
          claimNullifier: toHexBE(claimNullifier),
          root: toHexBE(root),
          proof: { a: proof_a, b: proof_b, c: proof_c },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errorMsg =
          errorData.error || "Failed to submit claim through relay";
        if (
          errorMsg.includes("already claimed") ||
          errorMsg.includes("ClaimNullifierUsed")
        ) {
          throw new Error(
            "Reward already claimed for this vote. Each vote can only claim once.",
          );
        }
        if (
          errorMsg.includes("Vote not found") ||
          errorMsg.includes("NotVoted")
        ) {
          throw new Error(
            "Vote not found — only voters can claim. Please vote first.",
          );
        }
        throw new Error(errorMsg);
      }

      const result = await response.json();
      if (import.meta.env.DEV)
        console.log("Claim submitted successfully:", result);
      setStep("success");
      setTimeout(() => onComplete(), 2000);
    } catch (err) {
      setStep("error");
      let errorMsg =
        err instanceof Error ? err.message : "Failed to submit claim";
      if (
        errorMsg.includes("Assert Failed") ||
        errorMsg.includes("Error in template Claim")
      ) {
        errorMsg =
          "Proof generation failed. Check your voting credentials and Merkle path. If you joined after the proposal in Fixed mode, you cannot claim.";
      }
      setError(errorMsg);
      console.error("Claim submission failed:", err);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-[100] animate-fade-in"
      onClick={onClose}
      data-testid="claim-rewards-modal"
    >
      <div
        className="relative w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="absolute -top-10 right-0 h-8 w-8 rounded-full text-white hover:bg-white/20"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
        <Card className="w-full shadow-xl border-none">
          {step === "select" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Gift className="h-5 w-5" /> Claim Vote-to-Earn Reward
                </CardTitle>
                <CardDescription>
                  Anonymous claim for voters. Your vote nullifier proves
                  eligibility, claim nullifier prevents double-claim. Relayer
                  preserves anonymity.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert variant="warning" className="text-xs">
                  <AlertTriangle className="h-4 w-4" />
                  Only voters (is_nullifier_used) can claim. Each vote can claim
                  once; replay of claim-nullifier will be rejected.
                </Alert>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>Proposal: #{proposalId}</div>
                  <div>Mode: {voteMode}</div>
                  <div className="truncate">DAO: {daoId}</div>
                </div>
                <Button
                  onClick={handleClaim}
                  variant="outline"
                  className="w-full h-12 text-lg"
                  data-testid="claim-button"
                >
                  Claim Reward
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Sybil bounds: SBT-age / QV / funding caps enforced per
                  THREAT_MODEL.md
                </p>
              </CardContent>
            </>
          )}

          {(step === "generating" || step === "submitting") && (
            <CardContent className="py-12 flex flex-col items-center text-center space-y-4">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                <div className="relative bg-background rounded-full p-4 border shadow-sm">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold text-lg">
                  {step === "generating"
                    ? "Generating Proof"
                    : "Submitting Claim"}
                </h3>
                <p className="text-sm text-muted-foreground max-w-[260px] mx-auto">
                  {progress}
                </p>
              </div>
              <Alert className="mt-4 bg-muted/50 border-none">
                <p className="text-xs text-muted-foreground">
                  This uses heavy cryptography in your browser. Don&apos;t close
                  this window.
                </p>
              </Alert>
            </CardContent>
          )}

          {step === "success" && (
            <CardContent
              className="py-12 flex flex-col items-center text-center space-y-4"
              data-testid="claim-success"
            >
              <div className="h-16 w-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-2">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-xl">Reward Claimed!</h3>
                <p className="text-muted-foreground">
                  Your anonymous claim has been recorded on-chain.
                </p>
              </div>
            </CardContent>
          )}

          {step === "error" && (
            <>
              <CardHeader>
                <CardTitle className="text-destructive flex items-center gap-2">
                  <XCircle className="h-5 w-5" />
                  Claim Error
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div data-testid="claim-error">
                  <Alert variant="error">{error}</Alert>
                </div>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  onClick={onClose}
                  data-testid="claim-error-close"
                >
                  Close
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
