import { useState, useEffect } from "react";
import {
  Key,
  ShieldCheck,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  Download,
  AlertTriangle,
  Lock,
  Info,
  ShieldQuestion,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import { LoadingSpinner } from "./ui";
import {
  deriveElectionSecret,
  generateMnemonic,
  mnemonicToMasterSecret,
  masterSecretToMnemonic,
  type DerivedElectionKeys,
} from "../lib/crypto";
import {
  generateVerificationChallenge,
  verifyWordAtPosition,
  markBackupVerified,
  isBackupVerified,
} from "../lib/backupVerification";
import { trackOnboardingStep } from "../lib/onboardingFunnel";

interface VoterRegistrationProps {
  electionId?: string | number;
  onCredentialsDerived?: (keys: DerivedElectionKeys) => void;
  className?: string;
}

const STORAGE_MASTER_SECRET_KEY = "zkvote_hd_master_secret";
/**
 * Stores the exact backup phrase shown to the user, not just the derived
 * secret: `mnemonicToMasterSecret`/`masterSecretToMnemonic` aren't a
 * faithful round trip (the secret is reduced modulo the BN254 field), so
 * regenerating a phrase from the stored secret alone could show a
 * *different* phrase than the one the user actually backed up.
 */
const STORAGE_MNEMONIC_KEY = "zkvote_hd_mnemonic";

/**
 * Progressive onboarding: a first-time visitor sees this choice before any
 * secret is generated. "explore" never calls key-derivation code (ZV-108
 * acceptance criterion: read-only mode performs no proof or key generation).
 */
type ViewMode = "choice" | "explore" | "setup";

export default function VoterRegistration({
  electionId = "default-election",
  onCredentialsDerived,
  className = "",
}: VoterRegistrationProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("choice");
  const [mnemonic, setMnemonic] = useState<string>("");
  const [masterSecret, setMasterSecret] = useState<string>("");
  const [customInput, setCustomInput] = useState<string>("");
  const [showMnemonic, setShowMnemonic] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isDeriving, setIsDeriving] = useState<boolean>(false);
  const [derivedKeys, setDerivedKeys] = useState<DerivedElectionKeys | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<"generate" | "import">("generate");
  const [error, setError] = useState<string | null>(null);

  const [backupVerified, setBackupVerified] = useState<boolean>(false);
  const [challengePosition, setChallengePosition] = useState<number | null>(
    null,
  );
  const [challengeInput, setChallengeInput] = useState("");
  const [challengeResult, setChallengeResult] = useState<
    "idle" | "correct" | "incorrect"
  >("idle");

  // Restore an existing secret on mount; otherwise stay on the "choice"
  // screen rather than generating one automatically (progressive onboarding).
  useEffect(() => {
    trackOnboardingStep("registration_started");

    const savedSecret = localStorage.getItem(STORAGE_MASTER_SECRET_KEY);
    if (savedSecret) {
      try {
        setMasterSecret(savedSecret);
        const savedMnemonic = localStorage.getItem(STORAGE_MNEMONIC_KEY);
        setMnemonic(savedMnemonic ?? masterSecretToMnemonic(savedSecret));
        setBackupVerified(isBackupVerified(savedSecret));
        setViewMode("setup");
      } catch (err) {
        console.error("Failed to restore saved master secret:", err);
      }
    }
  }, []);

  // Automatically derive election secret when masterSecret or electionId changes
  useEffect(() => {
    if (masterSecret && electionId) {
      deriveKeys(masterSecret, electionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterSecret, electionId]);

  // Onboarding can only "finish" (hand credentials to the caller) once the
  // backup has been confirmed (ZV-108 acceptance criterion).
  useEffect(() => {
    if (derivedKeys && backupVerified) {
      onCredentialsDerived?.(derivedKeys);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedKeys, backupVerified]);

  const handleChooseExplore = () => {
    trackOnboardingStep("explore_readonly_selected");
    setViewMode("explore");
  };

  const handleChooseCreate = () => {
    setViewMode("setup");
    setActiveTab("generate");
    handleGenerateNewMasterSecret();
  };

  const handleChooseImport = () => {
    setViewMode("setup");
    setActiveTab("import");
  };

  const resetVerificationState = () => {
    setBackupVerified(false);
    setChallengePosition(null);
    setChallengeInput("");
    setChallengeResult("idle");
  };

  const handleGenerateNewMasterSecret = () => {
    try {
      setError(null);
      const newMnemonic = generateMnemonic(12);
      const newSecret = mnemonicToMasterSecret(newMnemonic).toString();
      setMnemonic(newMnemonic);
      setMasterSecret(newSecret);
      localStorage.setItem(STORAGE_MASTER_SECRET_KEY, newSecret);
      localStorage.setItem(STORAGE_MNEMONIC_KEY, newMnemonic);
      resetVerificationState();
      trackOnboardingStep("secret_created");
    } catch (err: any) {
      setError("Failed to generate master secret: " + err.message);
    }
  };

  const handleImportMnemonic = () => {
    try {
      setError(null);
      const trimmed = customInput.trim();
      if (!trimmed) {
        setError(
          "Please enter a valid 12-word mnemonic phrase or master secret",
        );
        return;
      }

      let secretStr: string;
      let phraseStr: string;

      if (trimmed.includes(" ")) {
        secretStr = mnemonicToMasterSecret(trimmed).toString();
        phraseStr = trimmed;
      } else {
        secretStr = trimmed;
        phraseStr = masterSecretToMnemonic(trimmed);
      }

      setMasterSecret(secretStr);
      setMnemonic(phraseStr);
      localStorage.setItem(STORAGE_MASTER_SECRET_KEY, secretStr);
      localStorage.setItem(STORAGE_MNEMONIC_KEY, phraseStr);
      setBackupVerified(isBackupVerified(secretStr));
      setChallengePosition(null);
      setChallengeInput("");
      setChallengeResult("idle");
      setCustomInput("");
      setActiveTab("generate");
      trackOnboardingStep("secret_created");
    } catch (err: any) {
      setError("Invalid seed phrase or master secret format: " + err.message);
    }
  };

  const deriveKeys = async (secret: string, electId: string | number) => {
    setIsDeriving(true);
    try {
      const keys = await deriveElectionSecret(secret, electId);
      setDerivedKeys(keys);
    } catch (err: any) {
      setError("Key derivation failed: " + err.message);
    } finally {
      setIsDeriving(false);
    }
  };

  const handleCopyMnemonic = () => {
    navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleMnemonicVisibility = () => {
    const next = !showMnemonic;
    setShowMnemonic(next);
    if (next) trackOnboardingStep("backup_viewed");
  };

  const handleDownloadBackup = () => {
    const backupContent = `ZKVOTE HD MASTER SECRET BACKUP
=================================
Mnemonic Phrase (12 Words):
${mnemonic}

Master Secret:
${masterSecret}

IMPORTANT SECURITY NOTICE:
Keep this seed phrase offline in a safe place.
Anyone with this phrase can derive all your election voting keys.
=================================`;
    const blob = new Blob([backupContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zkvote-master-secret-backup.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStartVerification = () => {
    setChallengePosition(generateVerificationChallenge());
    setChallengeInput("");
    setChallengeResult("idle");
    trackOnboardingStep("backup_verification_started");
  };

  const handleSubmitChallenge = () => {
    if (challengePosition === null) return;
    const ok = verifyWordAtPosition(
      mnemonic,
      challengePosition,
      challengeInput,
    );
    if (ok) {
      markBackupVerified(masterSecret);
      setBackupVerified(true);
      setChallengeResult("correct");
      trackOnboardingStep("backup_verification_passed");
      trackOnboardingStep("registration_completed");
    } else {
      setChallengeResult("incorrect");
    }
  };

  if (viewMode === "choice") {
    return (
      <Card
        className={`w-full border shadow-lg bg-card text-card-foreground ${className}`}
      >
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">
                Set Up Your Voting Identity
              </CardTitle>
              <CardDescription>
                You can look around first — creating a voting identity is
                optional until you're ready to vote.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <button
            onClick={handleChooseExplore}
            className="w-full flex items-center gap-3 p-4 rounded-xl border bg-muted/30 hover:bg-muted/50 text-start transition-colors"
          >
            <Eye className="w-5 h-5 text-muted-foreground shrink-0" />
            <div>
              <p className="font-medium text-sm">Browse read-only</p>
              <p className="text-xs text-muted-foreground">
                No secret is created. You can set up voting later.
              </p>
            </div>
          </button>
          <button
            onClick={handleChooseCreate}
            className="w-full flex items-center gap-3 p-4 rounded-xl border bg-primary/5 hover:bg-primary/10 border-primary/30 text-start transition-colors"
          >
            <Key className="w-5 h-5 text-primary shrink-0" />
            <div>
              <p className="font-medium text-sm">Create a voting identity</p>
              <p className="text-xs text-muted-foreground">
                Generates a 12-word backup phrase you'll need to confirm.
              </p>
            </div>
          </button>
          <button
            onClick={handleChooseImport}
            className="w-full flex items-center gap-3 p-4 rounded-xl border bg-muted/30 hover:bg-muted/50 text-start transition-colors"
          >
            <RefreshCw className="w-5 h-5 text-muted-foreground shrink-0" />
            <div>
              <p className="font-medium text-sm">
                Import an existing phrase
              </p>
              <p className="text-xs text-muted-foreground">
                Already have a backup phrase or master secret? Enter it here.
              </p>
            </div>
          </button>
        </CardContent>
      </Card>
    );
  }

  if (viewMode === "explore") {
    return (
      <Card
        className={`w-full border shadow-lg bg-card text-card-foreground ${className}`}
      >
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">
                Browsing Read-Only
              </CardTitle>
              <CardDescription>
                No voting secret has been created on this device, and none
                is required to browse.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <button
            onClick={handleChooseCreate}
            className="w-full py-2 px-4 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            Create a Voting Identity
          </button>
          <button
            onClick={handleChooseImport}
            className="w-full py-2 px-4 border rounded-lg text-sm hover:bg-muted/50 transition-colors"
          >
            Import an Existing Phrase
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={`w-full border shadow-lg bg-card text-card-foreground ${className}`}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">
                HD Multi-Election Identity
              </CardTitle>
              <CardDescription>
                Single Master Secret for all elections with zero-knowledge
                domain separation
              </CardDescription>
            </div>
          </div>
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
            Hierarchical Deterministic
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Dual-secret model explainer */}
        <div className="p-3 rounded-lg border bg-muted/20 flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            This is one of two credential systems ZKVote uses. This HD
            mnemonic is self-custodied — you back it up here, and it's the
            only way to recover these keys. Some elections instead derive a
            key from a signature your connected wallet makes on demand; that
            kind never needs a separate backup phrase. Only follow the steps
            below if this election uses the HD mnemonic system.
          </span>
        </div>

        {/* Unverified backup reminder */}
        {mnemonic && !backupVerified && challengeResult !== "correct" && (
          <div className="p-3 rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 text-xs">
              <p className="text-amber-800 dark:text-amber-300 font-medium">
                Your backup hasn't been confirmed yet.
              </p>
              <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                Confirm you've saved your phrase to finish setting up voting.
                We'll only ask for a single word — never the full phrase.
              </p>
              {challengePosition === null && (
                <button
                  onClick={handleStartVerification}
                  className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300 underline"
                >
                  Verify my backup
                </button>
              )}
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab("generate")}
            className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "generate"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Master Key Backup
          </button>
          <button
            onClick={() => setActiveTab("import")}
            className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "import"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Import Key Phrase
          </button>
        </div>

        {error && (
          <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {activeTab === "generate" ? (
          <div className="space-y-4">
            {/* BIP-39 Seed Phrase Card */}
            <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5" /> BIP-39 Seed Mnemonic (12
                  Words)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleToggleMnemonicVisibility}
                    className="p-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center gap-1"
                  >
                    {showMnemonic ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                    {showMnemonic ? "Hide" : "Reveal"}
                  </button>
                  <button
                    onClick={handleCopyMnemonic}
                    className="p-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center gap-1"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={handleDownloadBackup}
                    className="p-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center gap-1"
                    title="Download Backup"
                  >
                    <Download className="w-3.5 h-3.5" /> Backup
                  </button>
                </div>
              </div>

              {/* Mnemonic Grid */}
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {mnemonic.split(" ").map((word, idx) => (
                  <div
                    key={idx}
                    className="px-2.5 py-1.5 rounded-lg bg-background border text-xs flex items-center justify-between font-mono"
                  >
                    <span className="text-muted-foreground select-none">
                      {idx + 1}.
                    </span>
                    <span className="font-semibold text-foreground">
                      {showMnemonic ? word : "•••••"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground border-t border-border/50">
                <span>
                  Backup this phrase to recover voting rights across all
                  elections
                </span>
                <button
                  onClick={handleGenerateNewMasterSecret}
                  className="text-primary hover:underline flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Regenerate
                </button>
              </div>
            </div>

            {/* Word-challenge backup verification */}
            {challengePosition !== null && challengeResult !== "correct" && (
              <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ShieldQuestion className="w-4 h-4 text-primary" />
                  Confirm word #{challengePosition + 1} of your backup phrase
                </div>
                <input
                  type="text"
                  value={challengeInput}
                  onChange={(e) => setChallengeInput(e.target.value)}
                  placeholder={`Word ${challengePosition + 1}`}
                  aria-label={`Backup word ${challengePosition + 1}`}
                  className="w-full p-2.5 rounded-lg border bg-background text-sm font-mono focus:ring-2 focus:ring-primary focus:outline-none"
                />
                {challengeResult === "incorrect" && (
                  <p className="text-xs text-destructive">
                    That doesn't match. Check your saved phrase and try
                    again.
                  </p>
                )}
                <button
                  onClick={handleSubmitChallenge}
                  className="w-full py-2 px-4 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 transition-opacity"
                >
                  Confirm Backup
                </button>
              </div>
            )}

            {challengeResult === "correct" && (
              <div className="p-3 rounded-lg border border-emerald-300/50 bg-emerald-50 dark:bg-emerald-950 dark:border-emerald-800 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                Backup confirmed. Your voting identity is ready to use.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1">
                Enter Mnemonic Phrase (12 Words) or Secret
              </label>
              <textarea
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="e.g. abandon ability able about above absent absorb abstract absurd abuse access accident"
                className="w-full h-24 p-3 rounded-lg border bg-background text-sm font-mono focus:ring-2 focus:ring-primary focus:outline-none"
              />
            </div>
            <button
              onClick={handleImportMnemonic}
              className="w-full py-2 px-4 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 transition-opacity"
            >
              Import Master Key
            </button>
          </div>
        )}

        {/* Derived Election Keys Section */}
        <div className="pt-4 border-t border-border space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              Derived Election Identity
            </h4>
            <span className="text-xs text-muted-foreground font-mono">
              ID: {String(electionId)}
            </span>
          </div>

          {isDeriving ? (
            <div className="p-4 text-center">
              <LoadingSpinner size="sm" color="blue" />
              <p className="text-xs text-muted-foreground mt-2">
                Deriving circuit-compatible election secret...
              </p>
            </div>
          ) : derivedKeys ? (
            <div className="space-y-2 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-muted/40 border">
                <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                  Election Secret (Derived via Poseidon KDF)
                </span>
                <span className="text-foreground truncate block font-bold">
                  {derivedKeys.electionSecret.slice(0, 16)}...
                  {derivedKeys.electionSecret.slice(-16)}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2.5 rounded-lg bg-muted/40 border">
                  <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                    Identity Commitment (Poseidon)
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400 truncate block font-semibold">
                    {derivedKeys.commitment.slice(0, 12)}...
                    {derivedKeys.commitment.slice(-12)}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40 border">
                  <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                    Nullifier Hash (Poseidon)
                  </span>
                  <span className="text-blue-600 dark:text-blue-400 truncate block font-semibold">
                    {derivedKeys.nullifier.slice(0, 12)}...
                    {derivedKeys.nullifier.slice(-12)}
                  </span>
                </div>
              </div>
              {!backupVerified && (
                <p className="text-xs text-muted-foreground italic">
                  These keys are derived locally, but won't be handed to the
                  app until your backup is confirmed above.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
