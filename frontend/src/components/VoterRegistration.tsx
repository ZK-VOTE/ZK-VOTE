import React, { useState, useEffect } from "react";
import {
  Key,
  ShieldCheck,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  Download,
  FileText,
  AlertTriangle,
  ChevronRight,
  Lock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/Card";
import { LoadingSpinner } from "./ui";
import {
  deriveElectionSecret,
  generateMnemonic,
  mnemonicToMasterSecret,
  masterSecretToMnemonic,
  DerivedElectionKeys,
} from "../lib/crypto";

interface VoterRegistrationProps {
  electionId?: string | number;
  onCredentialsDerived?: (keys: DerivedElectionKeys) => void;
  className?: string;
}

const STORAGE_MASTER_SECRET_KEY = "zkvote_hd_master_secret";

export default function VoterRegistration({
  electionId = "default-election",
  onCredentialsDerived,
  className = "",
}: VoterRegistrationProps) {
  const [mnemonic, setMnemonic] = useState<string>("");
  const [masterSecret, setMasterSecret] = useState<string>("");
  const [customInput, setCustomInput] = useState<string>("");
  const [showMnemonic, setShowMnemonic] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isDeriving, setIsDeriving] = useState<boolean>(false);
  const [derivedKeys, setDerivedKeys] = useState<DerivedElectionKeys | null>(null);
  const [activeTab, setActiveTab] = useState<"generate" | "import">("generate");
  const [error, setError] = useState<string | null>(null);

  // Initialize or restore master secret from storage
  useEffect(() => {
    const savedSecret = localStorage.getItem(STORAGE_MASTER_SECRET_KEY);
    if (savedSecret) {
      try {
        setMasterSecret(savedSecret);
        const restoredMnemonic = masterSecretToMnemonic(savedSecret);
        setMnemonic(restoredMnemonic);
      } catch (err) {
        console.error("Failed to restore saved master secret:", err);
      }
    } else {
      handleGenerateNewMasterSecret();
    }
  }, []);

  // Automatically derive election secret when masterSecret or electionId changes
  useEffect(() => {
    if (masterSecret && electionId) {
      deriveKeys(masterSecret, electionId);
    }
  }, [masterSecret, electionId]);

  const handleGenerateNewMasterSecret = () => {
    try {
      setError(null);
      const newMnemonic = generateMnemonic(12);
      const newSecret = mnemonicToMasterSecret(newMnemonic).toString();
      setMnemonic(newMnemonic);
      setMasterSecret(newSecret);
      localStorage.setItem(STORAGE_MASTER_SECRET_KEY, newSecret);
    } catch (err: any) {
      setError("Failed to generate master secret: " + err.message);
    }
  };

  const handleImportMnemonic = () => {
    try {
      setError(null);
      const trimmed = customInput.trim();
      if (!trimmed) {
        setError("Please enter a valid 12-word mnemonic phrase or master secret");
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
      setCustomInput("");
      setActiveTab("generate");
    } catch (err: any) {
      setError("Invalid seed phrase or master secret format: " + err.message);
    }
  };

  const deriveKeys = async (secret: string, electId: string | number) => {
    setIsDeriving(true);
    try {
      const keys = await deriveElectionSecret(secret, electId);
      setDerivedKeys(keys);
      if (onCredentialsDerived) {
        onCredentialsDerived(keys);
      }
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

  return (
    <Card className={`w-full border shadow-lg bg-card text-card-foreground ${className}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">HD Multi-Election Identity</CardTitle>
              <CardDescription>
                Single Master Secret for all elections with zero-knowledge domain separation
              </CardDescription>
            </div>
          </div>
          <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
            Hierarchical Deterministic
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
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
                  <Lock className="w-3.5 h-3.5" /> BIP-39 Seed Mnemonic (12 Words)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowMnemonic(!showMnemonic)}
                    className="p-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center gap-1"
                  >
                    {showMnemonic ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    {showMnemonic ? "Hide" : "Reveal"}
                  </button>
                  <button
                    onClick={handleCopyMnemonic}
                    className="p-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center gap-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
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
                    <span className="text-muted-foreground select-none">{idx + 1}.</span>
                    <span className="font-semibold text-foreground">
                      {showMnemonic ? word : "•••••"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground border-t border-border/50">
                <span>Backup this phrase to recover voting rights across all elections</span>
                <button
                  onClick={handleGenerateNewMasterSecret}
                  className="text-primary hover:underline flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Regenerate
                </button>
              </div>
            </div>
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
              <p className="text-xs text-muted-foreground mt-2">Deriving circuit-compatible election secret...</p>
            </div>
          ) : derivedKeys ? (
            <div className="space-y-2 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-muted/40 border">
                <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                  Election Secret (Derived via Poseidon KDF)
                </span>
                <span className="text-foreground truncate block font-bold">
                  {derivedKeys.electionSecret.slice(0, 16)}...{derivedKeys.electionSecret.slice(-16)}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2.5 rounded-lg bg-muted/40 border">
                  <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                    Identity Commitment (Poseidon)
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400 truncate block font-semibold">
                    {derivedKeys.commitment.slice(0, 12)}...{derivedKeys.commitment.slice(-12)}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40 border">
                  <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-sans">
                    Nullifier Hash (Poseidon)
                  </span>
                  <span className="text-blue-600 dark:text-blue-400 truncate block font-semibold">
                    {derivedKeys.nullifier.slice(0, 12)}...{derivedKeys.nullifier.slice(-12)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
