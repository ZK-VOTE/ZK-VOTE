import { useState, useEffect, useCallback } from "react";
import { relayerFetch, parseApiError } from "../lib/api";

interface ThresholdPanelProps {
  daoId: number;
  proposalId: number;
  isConnected: boolean;
  publicKey: string | null;
}

interface DkgState {
  phase: "idle" | "registration" | "commitment" | "completed";
  thresholdN: number;
  thresholdT: number;
  jointPublicKey: string | null;
  authorityCount: number;
}

interface AuthorityRegistration {
  address: string;
  name: string;
  verifierId: string;
}

interface ProtocolState {
  dkgRound?: DkgState;
  encryptedVoteCount: number;
  decryptionShareCount: number;
  isTallyDecrypted: boolean;
  decryptedTally: string | null;
}

interface EncryptedTally {
  c1: { x: string; y: string };
  c2: { x: string; y: string };
}

const BN254_VERIFIER_PREFIX = "did:stellar:";

const STEP_ORDER = [
  "idle",
  "registration",
  "commitment",
  "completed",
  "tally_computed",
  "share_submitted",
  "decrypted",
] as const;

type Step = (typeof STEP_ORDER)[number];

function getStepIndex(step: Step): number {
  return STEP_ORDER.indexOf(step);
}

export function ThresholdPanel({
  daoId,
  proposalId,
  isConnected,
  publicKey,
}: ThresholdPanelProps) {
  const [dkgState, setDkgState] = useState<DkgState>({
    phase: "idle",
    thresholdN: 3,
    thresholdT: 2,
    jointPublicKey: null,
    authorityCount: 0,
  });
  const [authorityName, setAuthorityName] = useState("");
  const [authorities, setAuthorities] = useState<AuthorityRegistration[]>([]);
  const [protocolState, setProtocolState] = useState<ProtocolState | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"setup" | "status" | "decrypt">(
    "setup",
  );
  const [encryptedTally, setEncryptedTally] = useState<EncryptedTally | null>(
    null,
  );
  const [decryptedTally, setDecryptedTally] = useState<string | null>(null);
  const [decryptionProof, setDecryptionProof] = useState<string | null>(null);

  const currentStep: Step = (() => {
    if (protocolState?.isTallyDecrypted) return "decrypted";
    if (encryptedTally) return "share_submitted";
    if (dkgState.phase === "completed" && protocolState && protocolState.encryptedVoteCount > 0 && protocolState.decryptionShareCount > 0)
      return "share_submitted";
    if (dkgState.phase === "completed" && protocolState && protocolState.encryptedVoteCount > 0)
      return "tally_computed";
    if (dkgState.phase === "completed") return "completed";
    if (dkgState.phase === "commitment") return "commitment";
    if (dkgState.phase === "registration") return "registration";
    return "idle";
  })();

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const showError = (msg: string) => {
    setError(msg);
    setSuccess(null);
  };

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setError(null);
  };

  const withLoading = useCallback(
    async (action: string, fn: () => Promise<void>) => {
      clearMessages();
      setLoading(true);
      setLoadingAction(action);
      try {
        await fn();
      } finally {
        setLoading(false);
        setLoadingAction(null);
      }
    },
    [],
  );

  const handleInitElection = useCallback(async () => {
    if (!publicKey) return;
    await withLoading("init", async () => {
      const response = await relayerFetch("/threshold/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId,
          proposalId,
          thresholdN: dkgState.thresholdN,
          thresholdT: dkgState.thresholdT,
          creator: publicKey,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      setDkgState((prev) => ({ ...prev, phase: "registration" }));
      showSuccess("Threshold decryption initialized successfully");
    });
  }, [
    daoId,
    proposalId,
    dkgState.thresholdN,
    dkgState.thresholdT,
    publicKey,
    withLoading,
  ]);

  const handleRegisterAuthority = useCallback(async () => {
    if (!publicKey || !authorityName.trim()) return;
    const verifierId = `${BN254_VERIFIER_PREFIX}${publicKey.slice(0, 16)}`;
    await withLoading("register", async () => {
      const response = await relayerFetch("/threshold/authority/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId,
          proposalId,
          authorityAddress: publicKey,
          authorityName: authorityName.trim(),
          verifierId,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      setAuthorities((prev) => [
        ...prev,
        { address: publicKey, name: authorityName.trim(), verifierId },
      ]);
      setAuthorityName("");
      showSuccess("Registered as tally authority");
    });
  }, [daoId, proposalId, publicKey, authorityName, withLoading]);

  const handleFinalizeDKG = useCallback(async () => {
    await withLoading("finalize", async () => {
      const response = await relayerFetch("/threshold/dkg/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daoId, proposalId }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      setDkgState((prev) => ({
        ...prev,
        phase: "completed",
        jointPublicKey: data.jointPublicKey,
        authorityCount: data.authoritiesCount,
      }));
      showSuccess("DKG completed. Joint public key established.");
    });
  }, [daoId, proposalId, withLoading]);

  const handleComputeTally = useCallback(async () => {
    await withLoading("compute_tally", async () => {
      const response = await relayerFetch("/threshold/tally/compute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daoId, proposalId }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      setEncryptedTally(data.encryptedTally);
      showSuccess("Encrypted tally computed successfully");
    });
  }, [daoId, proposalId, withLoading]);

  const handleSubmitDecryptionShare = useCallback(async () => {
    if (!publicKey || !encryptedTally) return;
    await withLoading("submit_share", async () => {
      const response = await relayerFetch("/threshold/decrypt/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId,
          proposalId,
          authorityAddress: publicKey,
          privateKeyShare: "0x0",
          encryptedTally,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      showSuccess("Decryption share submitted successfully");
    });
  }, [daoId, proposalId, publicKey, encryptedTally, withLoading]);

  const handleDecryptTally = useCallback(async () => {
    if (!encryptedTally) return;
    await withLoading("decrypt_tally", async () => {
      const response = await relayerFetch("/threshold/tally/decrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daoId, proposalId, encryptedTally }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(parseApiError(data));

      setDecryptedTally(data.tally);
      setDecryptionProof(data.proof);
      showSuccess(`Tally decrypted: ${data.tally} votes`);
    });
  }, [daoId, proposalId, encryptedTally, withLoading]);

  const refreshState = useCallback(async () => {
    try {
      const response = await relayerFetch(
        `/threshold/state/${daoId}/${proposalId}`,
        { method: "GET" },
      );
      const data = await response.json();
      if (data.success) {
        setProtocolState(data.state);
        if (data.state.decryptedTally) {
          setDecryptedTally(data.state.decryptedTally);
        }
      }
    } catch {
      // Silent fail for polling
    }
  }, [daoId, proposalId]);

  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(refreshState, 5000);
    return () => clearInterval(interval);
  }, [isConnected, refreshState]);

  if (!isConnected) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Connect your wallet to manage threshold decryption.
      </div>
    );
  }

  const votingOpen = protocolState ? protocolState.encryptedVoteCount > 0 : false;
  const shareCount = protocolState?.decryptionShareCount ?? 0;
  const tallyComputed = encryptedTally !== null || (protocolState?.encryptedVoteCount ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Threshold Decryption</h3>
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${
            dkgState.phase === "completed"
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : dkgState.phase === "registration" ||
                  dkgState.phase === "commitment"
                ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {dkgState.phase === "completed"
            ? "Active"
            : dkgState.phase === "registration"
              ? "Registering"
              : dkgState.phase === "commitment"
                ? "DKG in Progress"
                : "Not Initialized"}
        </span>
      </div>

      {/* Progress Steps */}
      {dkgState.phase !== "idle" && (
        <div className="flex items-center gap-1 text-xs">
          {[
            { key: "registration", label: "Register" },
            { key: "completed", label: "DKG" },
            { key: "tally_computed", label: "Tally" },
            { key: "share_submitted", label: "Shares" },
            { key: "decrypted", label: "Decrypt" },
          ].map(({ key, label }, i) => {
            const stepIdx = getStepIndex(key as Step);
            const currentIdx = getStepIndex(currentStep);
            const isComplete = currentIdx > stepIdx;
            const isCurrent = currentIdx === stepIdx;
            return (
              <div key={key} className="flex items-center">
                {i > 0 && (
                  <div
                    className={`w-4 h-px ${isComplete ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
                  />
                )}
                <div
                  className={`flex items-center gap-1 px-2 py-1 rounded ${
                    isComplete
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : isCurrent
                        ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 font-medium"
                        : "text-muted-foreground"
                  }`}
                >
                  {isComplete && (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                  {label}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-border/40 pb-2">
        {(["setup", "status", "decrypt"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab
                ? "bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400 border-b-2 border-purple-500"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "setup"
              ? "Setup"
              : tab === "status"
                ? "Status"
                : "Decrypt"}
          </button>
        ))}
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg text-sm flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <span>{success}</span>
        </div>
      )}

      {/* Setup Tab */}
      {activeTab === "setup" && (
        <div className="space-y-6">
          {dkgState.phase === "idle" && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Initialize Threshold Decryption</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Total Authorities (n)
                  </label>
                  <input
                    type="number"
                    min={2}
                    max={32}
                    value={dkgState.thresholdN}
                    onChange={(e) =>
                      setDkgState((prev) => ({
                        ...prev,
                        thresholdN: parseInt(e.target.value) || 3,
                      }))
                    }
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Threshold (t)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={dkgState.thresholdN}
                    value={dkgState.thresholdT}
                    onChange={(e) =>
                      setDkgState((prev) => ({
                        ...prev,
                        thresholdT: Math.min(
                          parseInt(e.target.value) || 2,
                          prev.thresholdN,
                        ),
                      }))
                    }
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                (t, n) = ({dkgState.thresholdT}, {dkgState.thresholdN}): Any{" "}
                {dkgState.thresholdT} of {dkgState.thresholdN} authorities can
                decrypt the tally.
              </p>
              <button
                onClick={handleInitElection}
                disabled={loading}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
              >
                {loading && loadingAction === "init"
                  ? "Initializing..."
                  : "Initialize Election"}
              </button>
            </div>
          )}

          {(dkgState.phase === "registration" ||
            dkgState.phase === "commitment") && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Register as Tally Authority</h4>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  Authority Name
                </label>
                <input
                  type="text"
                  value={authorityName}
                  onChange={(e) => setAuthorityName(e.target.value)}
                  placeholder="e.g., Tally Authority 1"
                  className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  maxLength={64}
                />
              </div>
              <button
                onClick={handleRegisterAuthority}
                disabled={loading || !authorityName.trim()}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
              >
                {loading && loadingAction === "register"
                  ? "Registering..."
                  : "Register"}
              </button>

              {authorities.length > 0 && (
                <div>
                  <h5 className="text-sm font-medium mt-4 mb-2">
                    Registered Authorities ({authorities.length})
                  </h5>
                  <div className="space-y-2">
                    {authorities.map((auth, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800/50 rounded text-sm"
                      >
                        <span className="font-medium">{auth.name}</span>
                        <span className="text-muted-foreground text-xs font-mono">
                          {auth.address.slice(0, 12)}...
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {authorities.length >= dkgState.thresholdN && (
                <button
                  onClick={handleFinalizeDKG}
                  disabled={loading}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm"
                >
                  {loading && loadingAction === "finalize"
                    ? "Finalizing..."
                    : "Finalize DKG"}
                </button>
              )}
            </div>
          )}

          {dkgState.phase === "completed" && (
            <div className="p-4 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 rounded-lg">
              <h4 className="font-medium text-green-700 dark:text-green-400">
                DKG Completed
              </h4>
              <p className="text-sm mt-1 text-muted-foreground">
                Joint public key established with {dkgState.authorityCount}{" "}
                authorities.
              </p>
              {dkgState.jointPublicKey && (
                <p className="text-xs font-mono mt-2 text-muted-foreground break-all">
                  Public Key: 0x{dkgState.jointPublicKey.slice(0, 32)}...
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Status Tab */}
      {activeTab === "status" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 border border-border/40 rounded-lg">
              <div className="text-2xl font-bold">
                {protocolState?.encryptedVoteCount ?? 0}
              </div>
              <div className="text-sm text-muted-foreground">
                Encrypted Votes
              </div>
            </div>
            <div className="p-4 border border-border/40 rounded-lg">
              <div className="text-2xl font-bold">
                {protocolState?.decryptionShareCount ?? 0}
              </div>
              <div className="text-sm text-muted-foreground">
                Decryption Shares
              </div>
            </div>
          </div>

          <div className="p-4 border border-border/40 rounded-lg">
            <h4 className="font-medium mb-2">DKG Configuration</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phase</span>
                <span>{dkgState.phase}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Threshold</span>
                <span>
                  ({dkgState.thresholdT}, {dkgState.thresholdN})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tally Decrypted</span>
                <span>{protocolState?.isTallyDecrypted ? "Yes" : "No"}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Decrypt Tab */}
      {activeTab === "decrypt" && (
        <div className="space-y-4">
          <div className="p-4 border border-border/40 rounded-lg">
            <h4 className="font-medium mb-2">Decryption Participation</h4>
            <p className="text-sm text-muted-foreground mb-4">
              As a tally authority, you can submit your decryption share once
              voting has ended and the encrypted tally has been computed.
            </p>

            {dkgState.phase === "completed" ? (
              <div className="space-y-4">
                {/* Step 1: Compute Tally */}
                <div
                  className={`p-3 rounded text-sm ${
                    encryptedTally
                      ? "bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800"
                      : "bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800"
                  }`}
                >
                  <p
                    className={`font-medium ${encryptedTally ? "text-green-700 dark:text-green-400" : "text-blue-700 dark:text-blue-400"}`}
                  >
                    {encryptedTally
                      ? "Encrypted Tally Computed"
                      : "Step 1: Compute Encrypted Tally"}
                  </p>
                  <p className="text-muted-foreground mt-1">
                    {encryptedTally
                      ? "The encrypted tally is ready for decryption share submission."
                      : "Compute the homomorphic encrypted tally from all encrypted votes."}
                  </p>
                </div>

                {!encryptedTally && (
                  <button
                    onClick={handleComputeTally}
                    disabled={loading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
                  >
                    {loading && loadingAction === "compute_tally"
                      ? "Computing..."
                      : "Compute Encrypted Tally"}
                  </button>
                )}

                {/* Step 2: Submit Decryption Share */}
                {encryptedTally && !protocolState?.isTallyDecrypted && (
                  <>
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/10 border border-purple-200 dark:border-purple-800 rounded text-sm">
                      <p className="font-medium text-purple-700 dark:text-purple-400">
                        Step 2: Submit Decryption Share
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Submit your authority's decryption share. At least{" "}
                        {dkgState.thresholdT} shares are needed to decrypt.
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Shares submitted: {shareCount} / {dkgState.thresholdN}
                      </p>
                    </div>

                    <button
                      onClick={handleSubmitDecryptionShare}
                      disabled={loading}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
                    >
                      {loading && loadingAction === "submit_share"
                        ? "Submitting..."
                        : "Submit Decryption Share"}
                    </button>
                  </>
                )}

                {/* Step 3: Decrypt Tally */}
                {encryptedTally &&
                  !protocolState?.isTallyDecrypted &&
                  shareCount >= dkgState.thresholdT && (
                    <>
                      <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded text-sm">
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                          Step 3: Decrypt Final Tally
                        </p>
                        <p className="text-muted-foreground mt-1">
                          Sufficient shares have been submitted. You can now
                          combine shares and decrypt the tally.
                        </p>
                      </div>

                      <button
                        onClick={handleDecryptTally}
                        disabled={loading}
                        className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 text-sm"
                      >
                        {loading && loadingAction === "decrypt_tally"
                          ? "Decrypting..."
                          : "Decrypt Final Tally"}
                      </button>
                    </>
                  )}

                {/* Final Result */}
                {protocolState?.isTallyDecrypted && decryptedTally && (
                  <div className="p-4 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg">
                    <h5 className="font-medium text-green-700 dark:text-green-400">
                      Tally Decrypted
                    </h5>
                    <div className="mt-2 text-3xl font-bold text-green-800 dark:text-green-300">
                      {decryptedTally} votes
                    </div>
                    {decryptionProof && (
                      <p className="text-xs font-mono mt-2 text-muted-foreground break-all">
                        ZK Proof: {decryptionProof.slice(0, 48)}...
                      </p>
                    )}
                  </div>
                )}

                {/* Waiting for votes */}
                {!encryptedTally &&
                  protocolState &&
                  protocolState.encryptedVoteCount === 0 && (
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 rounded text-sm">
                      <p className="text-yellow-700 dark:text-yellow-400">
                        Waiting for encrypted votes before tally can be
                        computed.
                      </p>
                    </div>
                  )}
              </div>
            ) : (
              <div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 rounded text-sm">
                <p className="text-yellow-700 dark:text-yellow-400">
                  DKG must be completed before decryption can begin.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
