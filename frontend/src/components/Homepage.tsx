import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "./ui/Button";
import { useTranslation } from "../i18n/I18nContext";

interface PublicProtocolStats {
  totalDaos: number;
  totalEvents: number;
  lastLedger: number;
  lastUpdated: string;
}

export function Homepage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="animate-fade-in">
      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center min-h-[calc(100dvh-140px)] py-12 px-4">
        <div className="text-center max-w-4xl space-y-6 sm:space-y-8 w-full">
          <div className="space-y-4 sm:space-y-6">
            <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold tracking-tighter leading-[1.15] break-words">
              {t("home.hero.title")}
              <br />
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-foreground to-muted-foreground">
                {t("home.hero.subtitle")}
              </span>
            </h1>
            <p className="text-base sm:text-xl text-muted-foreground max-w-[700px] mx-auto leading-relaxed">
              {t("home.hero.description")}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 pt-2 sm:pt-4 w-full max-w-sm sm:max-w-none mx-auto">
            <Button
              onClick={() => navigate("/daos/")}
              size="lg"
              className="w-full sm:w-auto min-h-[48px] px-8 text-base font-semibold"
            >
              {t("home.hero.startVoting")}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => navigate("/docs/")}
              className="w-full sm:w-auto min-h-[48px] px-8 text-base"
            >
              {t("home.hero.documentation")} <span className="ml-2">→</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Public Protocol Stats */}
      <div className="py-16 border-t border-border/40">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between gap-4 mb-8">
            <div>
              <p className="text-sm text-muted-foreground">Public protocol stats</p>
              <h2 className="text-3xl font-bold tracking-tight mt-2">
                Anonymous network activity
              </h2>
            </div>
            <div className="text-xs text-muted-foreground">
              {protocolStats?.lastUpdated
                ? new Date(protocolStats.lastUpdated).toLocaleString()
                : "Live"}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-border/60 bg-card p-6">
              <p className="text-sm text-muted-foreground">DAOs indexed</p>
              <p className="mt-4 text-4xl font-bold tracking-tight">
                {statsLoading ? "…" : (protocolStats?.totalDaos ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-6">
              <p className="text-sm text-muted-foreground">Events processed</p>
              <p className="mt-4 text-4xl font-bold tracking-tight">
                {statsLoading ? "…" : (protocolStats?.totalEvents ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-6">
              <p className="text-sm text-muted-foreground">Latest ledger</p>
              <p className="mt-4 text-4xl font-bold tracking-tight">
                {statsLoading ? "…" : (protocolStats?.lastLedger ?? 0).toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tech Stack Badges */}
      <div className="py-16 border-t border-border/40">
        <div className="text-center mb-8">
          <p className="text-sm text-muted-foreground">
            {t("home.techStack")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-16 opacity-60">
          <div className="flex items-center gap-2 text-sm font-medium">
            <div className="w-2 h-2 rounded-full bg-zinc-400"></div>
            Groth16 ZK-SNARKs
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <div className="w-2 h-2 rounded-full bg-blue-500"></div>
            BN254 Elliptic Curve
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            Poseidon Hash
          </div>
        </div>
      </div>

      {/* How It Works Section */}
      <div id="how-it-works" className="py-24">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-16 items-start mb-24">
            <div className="space-y-4">
              <p className="text-sm text-zinc-400 font-medium">
                Zero-Knowledge Proofs
              </p>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
                Vote privately,
                <br />
                verify publicly
              </h2>
            </div>
            <div className="space-y-4 text-muted-foreground">
              <p className="text-lg leading-relaxed">
                ZKVote uses Groth16 zero-knowledge proofs to enable truly
                private voting. Your vote choice remains hidden, but anyone can
                verify you're an eligible member and that votes are tallied
                correctly.
              </p>
              <p className="text-sm">
                <span className="text-foreground font-medium">
                  Privacy by design.
                </span>{" "}
                Unlike traditional blockchain voting where all votes are public,
                ZK-SNARKs let you prove membership without revealing identity.
              </p>
            </div>
          </div>

          {/* Feature Cards Grid */}
          <div className="grid md:grid-cols-3 gap-6">
            {/* Card 1: Merkle Tree */}
            <div className="group relative rounded-xl border border-border/50 bg-card/50 p-6 hover:border-border transition-colors overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="relative space-y-4">
                {/* Visual */}
                <div className="h-40 flex items-center justify-center text-muted-foreground/30">
                  <svg
                    width="160"
                    height="120"
                    viewBox="0 0 160 120"
                    fill="none"
                    className="opacity-60"
                  >
                    {/* Merkle Tree visualization */}
                    <circle
                      cx="80"
                      cy="20"
                      r="8"
                      fill="currentColor"
                      className="text-zinc-400/60"
                    />
                    <circle cx="40" cy="60" r="6" fill="currentColor" />
                    <circle cx="120" cy="60" r="6" fill="currentColor" />
                    <circle cx="20" cy="100" r="4" fill="currentColor" />
                    <circle cx="60" cy="100" r="4" fill="currentColor" />
                    <circle cx="100" cy="100" r="4" fill="currentColor" />
                    <circle cx="140" cy="100" r="4" fill="currentColor" />
                    <line
                      x1="80"
                      y1="28"
                      x2="40"
                      y2="54"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <line
                      x1="80"
                      y1="28"
                      x2="120"
                      y2="54"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <line
                      x1="40"
                      y1="66"
                      x2="20"
                      y2="96"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <line
                      x1="40"
                      y1="66"
                      x2="60"
                      y2="96"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <line
                      x1="120"
                      y1="66"
                      x2="100"
                      y2="96"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <line
                      x1="120"
                      y1="66"
                      x2="140"
                      y2="96"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                  </svg>
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center justify-between">
                    Poseidon Merkle Trees
                    <span className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
                      +
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Member commitments stored in on-chain Merkle trees using
                    ZK-friendly Poseidon hashing. Prove membership without
                    revealing which leaf is yours.
                  </p>
                </div>
              </div>
            </div>

            {/* Card 2: BN254 Curve */}
            <div className="group relative rounded-xl border border-border/50 bg-card/50 p-6 hover:border-border transition-colors overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="relative space-y-4">
                {/* Visual */}
                <div className="h-40 flex items-center justify-center text-muted-foreground/30">
                  <svg
                    width="160"
                    height="120"
                    viewBox="0 0 160 120"
                    fill="none"
                    className="opacity-60"
                  >
                    {/* Elliptic curve visualization */}
                    <path
                      d="M20 100 Q40 20, 80 60 Q120 100, 140 20"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      className="text-blue-500/60"
                    />
                    {/* Point P on curve (t≈0.25 of first quadratic) */}
                    <circle
                      cx="38"
                      cy="55"
                      r="4"
                      fill="currentColor"
                      className="text-blue-400"
                    />
                    {/* Point Q on curve (near end of second quadratic) */}
                    <circle
                      cx="136"
                      cy="34"
                      r="4"
                      fill="currentColor"
                      className="text-blue-400"
                    />
                    {/* Line connecting P and Q through curve */}
                    <line
                      x1="38"
                      y1="55"
                      x2="136"
                      y2="34"
                      stroke="currentColor"
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      className="text-blue-400/50"
                    />
                    <text
                      x="85"
                      y="38"
                      fill="currentColor"
                      fontSize="10"
                      className="text-muted-foreground"
                    >
                      P+Q
                    </text>
                  </svg>
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center justify-between">
                    BN254 Pairing Curve
                    <span className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
                      +
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Pairing-friendly elliptic curve enabling efficient bilinear
                    pairings for Groth16 proof verification directly on Soroban.
                  </p>
                </div>
              </div>
            </div>

            {/* Card 3: Groth16 */}
            <div className="group relative rounded-xl border border-border/50 bg-card/50 p-6 hover:border-border transition-colors overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-green-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="relative space-y-4">
                {/* Visual */}
                <div className="h-40 flex items-center justify-center text-muted-foreground/30">
                  <svg
                    width="160"
                    height="120"
                    viewBox="0 0 160 120"
                    fill="none"
                    className="opacity-60"
                  >
                    {/* Proof verification visualization */}
                    <rect
                      x="20"
                      y="30"
                      width="50"
                      height="60"
                      rx="4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                    />
                    <text
                      x="45"
                      y="55"
                      fill="currentColor"
                      fontSize="8"
                      textAnchor="middle"
                      className="text-muted-foreground"
                    >
                      PROOF
                    </text>
                    <text
                      x="45"
                      y="70"
                      fill="currentColor"
                      fontSize="6"
                      textAnchor="middle"
                      className="text-green-500/80"
                    >
                      π = (A,B,C)
                    </text>

                    <path
                      d="M75 60 L95 60"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      markerEnd="url(#arrow)"
                    />

                    <rect
                      x="100"
                      y="40"
                      width="40"
                      height="40"
                      rx="4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      className="text-green-500/60"
                    />
                    <text
                      x="120"
                      y="62"
                      fill="currentColor"
                      fontSize="8"
                      textAnchor="middle"
                      className="text-green-400"
                    >
                      ✓
                    </text>
                    <text
                      x="120"
                      y="95"
                      fill="currentColor"
                      fontSize="7"
                      textAnchor="middle"
                      className="text-muted-foreground"
                    >
                      Verified
                    </text>

                    <defs>
                      <marker
                        id="arrow"
                        markerWidth="6"
                        markerHeight="6"
                        refX="5"
                        refY="3"
                        orient="auto"
                      >
                        <path d="M0,0 L0,6 L6,3 z" fill="currentColor" />
                      </marker>
                    </defs>
                  </svg>
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center justify-between">
                    Groth16 Verification
                    <span className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
                      +
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Constant-size proofs (~200 bytes) verified on-chain in
                    milliseconds. The gold standard for succinct non-interactive
                    arguments of knowledge.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Architecture Section */}
      <div className="py-24 border-t border-border/40">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="space-y-6">
              <p className="text-sm text-zinc-400 font-medium">Architecture</p>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
                Multi-contract design for modularity
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                Five specialized Soroban contracts work together: DAORegistry
                for organization management, MembershipSBT for soulbound tokens,
                MembershipTree for Poseidon Merkle proofs, Voting for Groth16
                verification, and Comments for proposal discussions.
              </p>
              <div className="pt-4">
                <Button variant="outline" onClick={() => navigate("/daos/")}>
                  Explore DAOs
                </Button>
              </div>
            </div>

            {/* Contract Flow Diagram */}
            <div className="relative p-8 rounded-xl border border-border/50 bg-card/30">
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-zinc-400"></div>
                  <div className="flex-1 h-12 rounded-lg border border-border/50 bg-background/50 flex items-center px-4">
                    <span className="text-sm font-mono">DAORegistry</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      create_dao()
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 pl-6">
                  <div className="w-px h-8 bg-border"></div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                  <div className="flex-1 h-12 rounded-lg border border-border/50 bg-background/50 flex items-center px-4">
                    <span className="text-sm font-mono">MembershipSBT</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      mint()
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 pl-6">
                  <div className="w-px h-8 bg-border"></div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  <div className="flex-1 h-12 rounded-lg border border-border/50 bg-background/50 flex items-center px-4">
                    <span className="text-sm font-mono">MembershipTree</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      register()
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 pl-6">
                  <div className="w-px h-8 bg-border"></div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-orange-500"></div>
                  <div className="flex-1 h-12 rounded-lg border border-border/50 bg-background/50 flex items-center px-4">
                    <span className="text-sm font-mono">Voting</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      vote(proof)
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 pl-6">
                  <div className="w-px h-8 bg-border"></div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                  <div className="flex-1 h-12 rounded-lg border border-border/50 bg-background/50 flex items-center px-4">
                    <span className="text-sm font-mono">Comments</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      add_comment()
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Privacy Section */}
      <div className="py-24 border-t border-border/40">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-sm text-zinc-400 font-medium mb-4">
              Privacy Guarantees
            </p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
              What stays private, what's public
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Understanding exactly what information is revealed and what
              remains hidden.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Private */}
            <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-green-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-green-400">
                  Stays Private
                </h3>
              </div>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-green-500 mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Your vote choice (yes/no/abstain)
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-green-500 mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Your identity as a voter
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-green-500 mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Which Merkle leaf belongs to you
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-green-500 mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Your secret key and nullifier secret
                  </span>
                </li>
              </ul>
            </div>

            {/* Public */}
            <div className="rounded-xl border border-border/50 bg-card/30 p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold">Publicly Visible</h3>
              </div>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Aggregate vote tallies
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Nullifier hash (prevents double voting)
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Merkle root (membership set)
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-muted-foreground">
                    Proof validity (verified on-chain)
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="py-24 border-t border-border/40">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
            Ready to get started?
          </h2>
          <p className="text-lg text-muted-foreground">
            Join a DAO or create your own. All votes are protected by
            zero-knowledge proofs.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Button
              onClick={() => navigate("/daos/")}
              size="lg"
              className="h-12 px-8"
            >
              Browse DAOs
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() =>
                window.open("https://github.com/ZK-VOTE/ZK-VOTE", "_blank")
              }
              className="h-12 px-8"
            >
              View on GitHub
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Homepage;
