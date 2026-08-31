/**
 * Privacy-Preserving Analytics Panel (issue #306)
 *
 * Lets a DAO admin view the *encrypted* aggregate participation tally and the
 * DAO's privacy-budget accounting, initialize the aggregate, fold encrypted
 * contributions into it, and request threshold decryption of the aggregate
 * only. Per-voter participation is never displayed or transmitted.
 */

import { useState } from "react";
import {
  useAnalyticsStateQuery,
  usePrivacyBudgetQuery,
  useAccumulateContribution,
  useDecryptAggregate,
  initializeAnalytics,
} from "../queries/analyticsQueries";
import { encryptVoteDemo, GX, GY } from "./analyticsCrypto";
import { Button } from "./ui/Button";

// Serialized G1 generator (x=1, y=2) — used only as a demo joint public key.
const JOINT_DEMO_HEX =
  GX.toString(16).padStart(64, "0") + GY.toString(16).padStart(64, "0");

interface AnalyticsPanelProps {
  daoId: number;
  isAdmin: boolean;
}

export function AnalyticsPanel({ daoId, isAdmin }: AnalyticsPanelProps) {
  const [jointPublicKey, setJointPublicKey] = useState("");
  const [thresholdT, setThresholdT] = useState(2);
  const [thresholdN, setThresholdN] = useState(3);
  const [minCohort, setMinCohort] = useState(5);
  const [sharesInput, setSharesInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stateQuery = useAnalyticsStateQuery(daoId);
  const budgetQuery = usePrivacyBudgetQuery(daoId);
  const accumulate = useAccumulateContribution();
  const decrypt = useDecryptAggregate();

  const state = stateQuery.data?.state;
  const budget = budgetQuery.data?.budget;

  const setNotice = (msg: string) => {
    setMessage(msg);
    setError(null);
  };
  const setErr = (msg: string) => {
    setError(msg);
    setMessage(null);
  };

  const handleInit = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await initializeAnalytics({
        daoId,
        jointPublicKey,
        thresholdT,
        thresholdN,
        minCohort,
      });
      setNotice("Analytics aggregate initialized.");
      stateQuery.refetch();
      budgetQuery.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Fold one encrypted participation contribution of "1" into the aggregate
  // using a deterministic client-side encryption under the DAO joint key. In
  // production the relayer folds contributions produced during voting; this is
  // a demonstration of the homomorphic accumulation surface.
  const handleAccumulate = async () => {
    if (!state?.jointPublicKey) {
      setErr("Initialize the aggregate and provide a joint public key first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { c1, c2 } = encryptVoteDemo(state.jointPublicKey);
      const result = await accumulate.mutateAsync({ daoId, c1, c2 });
      setNotice(`Contribution folded in (cohort now ${result.state.contributionCount}).`);
      stateQuery.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateDemoKey = () => {
    setJointPublicKey(JOINT_DEMO_HEX);
    setNotice("Set a demo joint public key (the G1 generator). In production this comes from the DKG ceremony.");
  };

  const handleDecrypt = async () => {
    let shares: Array<{ authorityIndex: number; shareHex: string }>;
    try {
      shares = JSON.parse(sharesInput || "[]");
    } catch {
      setErr("Shares must be valid JSON: [{authorityIndex, shareHex}, ...]");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await decrypt.mutateAsync({ daoId, shares });
      setNotice(`Decrypted aggregate tally: ${result.result.tallyStr}`);
      stateQuery.refetch();
      budgetQuery.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="p-4 border border-border/40 rounded-lg bg-muted/30">
        <h4 className="font-medium mb-1">What this is</h4>
        <p className="text-sm text-muted-foreground">
          Participation contributions are encrypted under the DAO's DKG joint
          public key and summed <em>homomorphically</em> — only the aggregate
          tally is ever threshold-decrypted, and only after passing the
          k-anonymity floor and privacy-budget guards. Per-voter participation
          is never revealed.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">
          {error}
        </div>
      )}
      {message && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg text-sm">
          {message}
        </div>
      )}

      {/* Aggregate state */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 border border-border/40 rounded-lg">
          <div className="text-2xl font-bold">
            {state?.contributionCount ?? "—"}
          </div>
          <div className="text-sm text-muted-foreground">Participants (cohort)</div>
        </div>
        <div className="p-4 border border-border/40 rounded-lg">
          <div className="text-2xl font-bold">
            {state?.decrypted ? "Yes" : "No"}
          </div>
          <div className="text-sm text-muted-foreground">Aggregate decrypted</div>
        </div>
        <div className="p-4 border border-border/40 rounded-lg">
          <div className="text-2xl font-bold">
            {budget?.remaining !== undefined ? budget.remaining.toFixed(2) : "—"}
          </div>
          <div className="text-sm text-muted-foreground">ε budget remaining</div>
        </div>
      </div>

      {state?.decrypted && state.lastDecryptedTally && (
        <div className="p-4 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 rounded-lg">
          <div className="text-sm text-muted-foreground">
            Aggregate participation tally:
          </div>
          <div className="text-3xl font-bold">{state.lastDecryptedTally}</div>
        </div>
      )}

      {isAdmin && (
        <>
          {/* Initialize */}
          {!state && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Initialize Aggregate</h4>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  DKG joint public key (hex, no 0x)
                </label>
                <div className="flex gap-2">
                  <input
                    value={jointPublicKey}
                    onChange={(e) => setJointPublicKey(e.target.value)}
                    placeholder="e.g. G1 point as 128 hex chars"
                    className="flex-1 px-3 py-2 border border-border/40 rounded-lg bg-background font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerateDemoKey}
                  >
                    Demo key
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Threshold (t)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={thresholdT}
                    onChange={(e) => setThresholdT(parseInt(e.target.value) || 2)}
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Authorities (n)
                  </label>
                  <input
                    type="number"
                    min={2}
                    max={32}
                    value={thresholdN}
                    onChange={(e) => setThresholdN(parseInt(e.target.value) || 3)}
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Min cohort (k)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={minCohort}
                    onChange={(e) => setMinCohort(parseInt(e.target.value) || 5)}
                    className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background"
                  />
                </div>
              </div>
              <Button
                onClick={handleInit}
                disabled={busy || !jointPublicKey}
              >
                {busy ? "Initializing..." : "Initialize Aggregate"}
              </Button>
            </div>
          )}

          {/* Accumulate */}
          {state && !state.decrypted && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Accumulate Participation</h4>
              <p className="text-sm text-muted-foreground">
                Fold one encrypted participation contribution into the aggregate
                (homomorphic addition).
              </p>
              <Button
                onClick={handleAccumulate}
                disabled={accumulate.isPending}
              >
                {accumulate.isPending ? "Accumulating..." : "Add Encrypted Contribution"}
              </Button>
            </div>
          )}

          {/* Decrypt */}
          {state && !state.decrypted && (
            <div className="p-4 border border-border/40 rounded-lg space-y-4">
              <h4 className="font-medium">Threshold-Decrypt Aggregate</h4>
              <p className="text-sm text-muted-foreground">
                Paste decryption shares from at least {state.thresholdT}{" "}
                authorities as JSON: [{"{authorityIndex, shareHex}"}, ...]. The
                cohort must exceed the k-anonymity floor and the privacy budget
                must have headroom.
              </p>
              <textarea
                value={sharesInput}
                onChange={(e) => setSharesInput(e.target.value)}
                rows={4}
                placeholder={'[{"authorityIndex":0,"shareHex":"..."}]'}
                className="w-full px-3 py-2 border border-border/40 rounded-lg bg-background font-mono text-xs"
              />
              <Button
                onClick={handleDecrypt}
                disabled={decrypt.isPending || !sharesInput}
              >
                {decrypt.isPending ? "Decrypting..." : "Decrypt Aggregate"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}