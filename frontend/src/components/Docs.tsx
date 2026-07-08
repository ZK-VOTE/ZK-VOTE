import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

type Section =
  | "getting-started"
  | "how-it-works"
  | "creating-dao"
  | "creating-proposal"
  | "voting"
  | "comments"
  | "privacy"
  | "technical";

export function Docs() {
  const [activeSection, setActiveSection] =
    useState<Section>("getting-started");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const sections = [
    { id: "getting-started" as Section, title: "Getting Started" },
    { id: "how-it-works" as Section, title: "How It Works" },
    { id: "creating-dao" as Section, title: "Creating a DAO" },
    { id: "creating-proposal" as Section, title: "Creating a Proposal" },
    { id: "voting" as Section, title: "Casting a Vote" },
    { id: "comments" as Section, title: "Commenting" },
    { id: "privacy" as Section, title: "Privacy Model" },
    { id: "technical" as Section, title: "Tech" },
  ];

  const activeTitle =
    sections.find((s) => s.id === activeSection)?.title || "Getting Started";

  return (
    <div className="animate-fade-in">
      <div className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-4">
          Documentation
        </h1>
        <p className="text-lg text-muted-foreground">
          Learn how to use ZKVote for private, verifiable DAO governance.
        </p>
      </div>

      <div className="grid lg:grid-cols-[250px_1fr] gap-8">
        {/* Mobile Dropdown Navigation */}
        <div className="lg:hidden relative">
          <button
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg border bg-background text-sm font-medium"
          >
            <span>{activeTitle}</span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${mobileNavOpen ? "rotate-180" : ""}`}
            />
          </button>
          {mobileNavOpen && (
            <div className="absolute top-full left-0 right-0 mt-2 rounded-lg border bg-background shadow-lg z-10">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => {
                    setActiveSection(section.id);
                    setMobileNavOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-4 py-3 text-left text-sm transition-colors first:rounded-t-lg last:rounded-b-lg ${
                    activeSection === section.id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/50 text-muted-foreground"
                  }`}
                >
                  <span>{section.title}</span>
                  {activeSection === section.id && (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Desktop Sidebar Navigation */}
        <nav className="hidden lg:block space-y-1">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-left text-sm transition-colors ${
                activeSection === section.id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              <span>{section.title}</span>
              {activeSection === section.id && (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          ))}
        </nav>

        {/* Content Area */}
        <div className="min-h-[600px]">
          {activeSection === "getting-started" && <GettingStarted />}
          {activeSection === "how-it-works" && <HowItWorks />}
          {activeSection === "creating-dao" && <CreatingDAO />}
          {activeSection === "creating-proposal" && <CreatingProposal />}
          {activeSection === "voting" && <Voting />}
          {activeSection === "comments" && <Commenting />}
          {activeSection === "privacy" && <PrivacyModel />}
          {activeSection === "technical" && <TechnicalDeepDive />}
        </div>
      </div>
    </div>
  );
}

function GettingStarted() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Getting Started with ZKVote
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          ZKVote is a private voting system for DAOs built on Stellar's Soroban
          smart contracts. It uses zero-knowledge proofs to ensure your vote
          remains private while still being verifiable.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Prerequisites</h3>
        <ul className="space-y-2 text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>A Stellar wallet (Freighter recommended)</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Some XLM for transaction fees (testnet XLM for testing)</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>A modern web browser</span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Quick Start</h3>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              1
            </div>
            <div>
              <p className="font-medium">Connect your wallet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Click "Connect Wallet" in the top right corner and approve the
                connection in your wallet extension.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              2
            </div>
            <div>
              <p className="font-medium">Browse DAOs</p>
              <p className="text-sm text-muted-foreground mt-1">
                Navigate to the Browse DAOs page to see existing organizations
                you can join.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              3
            </div>
            <div>
              <p className="font-medium">Join or create a DAO</p>
              <p className="text-sm text-muted-foreground mt-1">
                If a DAO has open membership, you can join directly. For closed
                DAOs, the admin must add you as a member. You can also create
                your own DAO.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              4
            </div>
            <div>
              <p className="font-medium">Register for voting</p>
              <p className="text-sm text-muted-foreground mt-1">
                After joining, you'll need to register your cryptographic
                commitment to enable private voting.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              5
            </div>
            <div>
              <p className="font-medium">Cast your vote</p>
              <p className="text-sm text-muted-foreground mt-1">
                When a proposal is active, generate a ZK proof and submit your
                vote privately.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-5 rounded-lg border bg-card">
        <h4 className="font-semibold mb-2">Important Note</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your voting credentials (secret and salt) are generated
          deterministically from your wallet. Keep your wallet secure - anyone
          with access to your wallet can vote on your behalf.
        </p>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          How ZKVote Works
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          ZKVote combines several cryptographic primitives to enable private
          voting while preventing fraud. Here's the high-level flow:
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">The Voting Flow</h3>
        <div className="space-y-4">
          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              1
            </div>
            <div>
              <h4 className="font-medium">Membership Registration</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                When you join a DAO, you generate a cryptographic commitment
                from your secret key. This commitment is added to a Merkle tree
                on-chain, proving you're a member without revealing your
                identity.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              2
            </div>
            <div>
              <h4 className="font-medium">Proof Generation</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                When voting, your browser generates a zero-knowledge proof that
                demonstrates: (a) you know a secret and salt that hash to a
                commitment in the Merkle tree, (b) you haven't voted before on
                this proposal (via the nullifier), and (c) your vote is valid
                (Yes or No).
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              3
            </div>
            <div>
              <h4 className="font-medium">Anonymous Submission</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                Your proof is submitted through a relayer service, which pays
                the transaction fee. This breaks the link between your wallet
                address and your vote.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              4
            </div>
            <div>
              <h4 className="font-medium">On-Chain Verification</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                The Soroban smart contract verifies your Groth16 proof using
                BN254 pairing operations. If valid, your vote is counted and
                your nullifier is recorded to prevent double-voting.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Key Concepts</h3>
        <div className="space-y-6">
          <div>
            <h4 className="font-medium mb-2">Commitment</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A commitment is a cryptographic hash of your secret and a random
              salt: Poseidon(secret, salt). It's like a sealed envelope - it
              proves you have a secret without revealing what it is. Commitments
              are stored in a Merkle tree on-chain.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Nullifier</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A nullifier is a unique value derived from your secret, the DAO
              ID, and the proposal ID: Poseidon(secret, daoId, proposalId). This
              domain separation ensures you can't be linked across different
              DAOs. It prevents double-voting: if you try to vote twice, you'd
              produce the same nullifier, which the contract would reject.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Merkle Tree</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A Merkle tree is a data structure that lets you prove membership
              in a set efficiently. Instead of checking every member, you only
              need to provide a "path" from your commitment to the tree's root.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreatingDAO() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Creating a DAO
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Anyone can create a DAO on ZKVote. As the creator, you become the
          admin with special privileges to manage members and create proposals.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Step-by-Step Guide</h3>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              1
            </div>
            <div>
              <p className="font-medium">Connect your wallet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Navigate to the Browse DAOs page.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              2
            </div>
            <div>
              <p className="font-medium">Click "Create DAO"</p>
              <p className="text-sm text-muted-foreground mt-1">
                This opens the creation form.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              3
            </div>
            <div>
              <p className="font-medium">Enter a name</p>
              <p className="text-sm text-muted-foreground mt-1">
                Choose something descriptive and unique for your DAO.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              4
            </div>
            <div>
              <p className="font-medium">Choose membership type</p>
              <p className="text-sm text-muted-foreground mt-1">
                <span className="font-medium text-foreground">
                  Open membership
                </span>{" "}
                - Anyone can join without approval
                <br />
                <span className="font-medium text-foreground">
                  Closed membership
                </span>{" "}
                - Admin must add new members
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              5
            </div>
            <div>
              <p className="font-medium">Confirm the transaction</p>
              <p className="text-sm text-muted-foreground mt-1">
                Approve in your wallet to deploy the DAO configuration on-chain.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">What Happens On-Chain</h3>
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          When you create a DAO, several things happen in a single atomic
          transaction:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>A new DAO entry is created in the DAORegistry contract</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>A Merkle tree is initialized for member commitments</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>The verification key for ZK proofs is set</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>You receive an admin SBT (Soulbound Token) for the DAO</span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Admin Capabilities</h3>
        <p className="text-sm text-muted-foreground mb-4">
          As a DAO admin, you can:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Add and remove members (for closed DAOs)</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Create new proposals</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>View member list and voting status</span>
          </li>
        </ul>
      </div>

      <div className="p-5 rounded-lg border bg-card">
        <h4 className="font-semibold mb-2">Admin Responsibility</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Admin privileges are tied to your wallet address. If you lose access
          to your wallet, you lose admin access to your DAO. You can transfer
          admin rights to another member using the "Make Admin" option in the
          member actions menu (3-dot icon next to each member).
        </p>
      </div>
    </div>
  );
}

function CreatingProposal() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Creating a Proposal
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Any DAO member can create proposals for the community to vote on.
          Proposals define what decisions the DAO will make through its
          anonymous voting system.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Who Can Create Proposals</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Only DAO members with an SBT (Soulbound Token) can create proposals.
          The DAO's settings control whether all members can propose or only the
          admin.
        </p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border">
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
            <div>
              <span className="font-medium">Members can propose (default)</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Any member with an SBT can create proposals
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border">
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
            <div>
              <span className="font-medium">Admin-only proposals</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Only the DAO admin can create proposals
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Step-by-Step Guide</h3>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              1
            </div>
            <div>
              <p className="font-medium">Navigate to your DAO</p>
              <p className="text-sm text-muted-foreground mt-1">
                Go to the DAO dashboard where you want to create the proposal.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              2
            </div>
            <div>
              <p className="font-medium">Click "Create Proposal"</p>
              <p className="text-sm text-muted-foreground mt-1">
                This opens the proposal creation form.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              3
            </div>
            <div>
              <p className="font-medium">Enter proposal details</p>
              <p className="text-sm text-muted-foreground mt-1">
                <span className="font-medium text-foreground">Title</span> - A
                short summary (max 100 characters)
                <br />
                <span className="font-medium text-foreground">
                  Description
                </span>{" "}
                - Full proposal text (stored on IPFS)
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              4
            </div>
            <div>
              <p className="font-medium">Set the voting deadline</p>
              <p className="text-sm text-muted-foreground mt-1">
                Choose when voting ends. Must be in the future. Set to 0 for no
                deadline (voting never closes).
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              5
            </div>
            <div>
              <p className="font-medium">Choose vote mode</p>
              <p className="text-sm text-muted-foreground mt-1">
                <span className="font-medium text-foreground">Fixed</span> -
                Only members at proposal creation can vote (snapshot-based)
                <br />
                <span className="font-medium text-foreground">Trailing</span> -
                Members who join after creation can also vote
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
              6
            </div>
            <div>
              <p className="font-medium">Confirm the transaction</p>
              <p className="text-sm text-muted-foreground mt-1">
                Approve in your wallet to publish the proposal on-chain.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">What Happens On-Chain</h3>
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          When you create a proposal, several important snapshots are taken:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">
                Merkle root snapshot
              </span>{" "}
              - The current member tree root is recorded. For Fixed mode, only
              these members can vote.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">
                VK hash snapshot
              </span>{" "}
              - The verification key hash is recorded to prevent mid-vote
              circuit changes.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">VK version</span> -
              The VK version number is pinned to ensure proof compatibility.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">
                Creation timestamp
              </span>{" "}
              - Used for revocation checks during voting.
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Vote Modes Explained</h3>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2 flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-xs font-medium">
                Fixed
              </span>
              Snapshot-Based Eligibility
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Only members who were registered when the proposal was created can
              vote. This prevents last-minute membership additions to sway a
              vote. The Merkle root is checked exactly against the snapshot.
              Most secure for governance decisions.
            </p>
          </div>

          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2 flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 text-xs font-medium">
                Trailing
              </span>
              Inclusive Eligibility
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Members who join after proposal creation can also vote, as long as
              they use a valid Merkle root from after the proposal was created.
              Good for growing communities where you want new members to
              participate immediately.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Proposal Data Model</h3>
        <div className="p-6 rounded-lg border bg-card font-mono text-sm">
          <p className="text-muted-foreground mb-2">// On-chain ProposalInfo</p>
          <p>{"{"}</p>
          <p className="ml-4">id: u64,</p>
          <p className="ml-4">dao_id: u64,</p>
          <p className="ml-4">
            title: String,{" "}
            <span className="text-muted-foreground">// Max 100 bytes</span>
          </p>
          <p className="ml-4">
            content_cid: String,{" "}
            <span className="text-muted-foreground">
              // IPFS CID for full content
            </span>
          </p>
          <p className="ml-4">yes_votes: u64,</p>
          <p className="ml-4">no_votes: u64,</p>
          <p className="ml-4">
            end_time: u64,{" "}
            <span className="text-muted-foreground">
              // Unix timestamp, 0 = no deadline
            </span>
          </p>
          <p className="ml-4">created_by: Address,</p>
          <p className="ml-4">created_at: u64,</p>
          <p className="ml-4">state: ProposalState,</p>
          <p className="ml-4">vk_hash: BytesN&lt;32&gt;,</p>
          <p className="ml-4">vk_version: u32,</p>
          <p className="ml-4">
            eligible_root: U256,{" "}
            <span className="text-muted-foreground">
              // Merkle root snapshot
            </span>
          </p>
          <p className="ml-4">
            vote_mode: VoteMode,{" "}
            <span className="text-muted-foreground">// Fixed or Trailing</span>
          </p>
          <p className="ml-4">
            earliest_root_index: u32,{" "}
            <span className="text-muted-foreground">// For Trailing mode</span>
          </p>
          <p>{"}"}</p>
        </div>
      </div>

      <div className="p-5 rounded-lg border bg-card">
        <h4 className="font-semibold mb-2">Important Notes</h4>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Proposals cannot be edited or deleted once created</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>The deadline cannot be extended after creation</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Voting starts immediately when the proposal is created</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              Content is stored on IPFS; only the CID is stored on-chain
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Voting() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Casting a Vote
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Voting on ZKVote is a multi-step process that ensures your vote is
          private yet verifiable.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Before You Vote</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Make sure you have:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Joined the DAO and registered your commitment</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Your wallet connected (for credential derivation)</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>An active proposal to vote on</span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Voting Process</h3>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2">1. Select Your Vote</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Choose Yes or No on the proposal. Your choice will be encoded in
              the ZK proof.
            </p>
          </div>

          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2">2. Generate Proof</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Click "Generate Proof" to create your zero-knowledge proof. This
              happens entirely in your browser and may take 10-30 seconds
              depending on your device. The proof demonstrates membership and
              vote validity without revealing your identity.
            </p>
          </div>

          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2">3. Submit via Relayer</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Your proof is sent to a relayer service that submits it to the
              blockchain. This breaks the link between your wallet and your
              vote, as the relayer pays the transaction fee.
            </p>
          </div>

          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2">4. Verification</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The smart contract verifies your Groth16 proof on-chain. If valid,
              your vote is counted and your nullifier is recorded to prevent
              double-voting.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Vote Options</h3>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">Yes</span> - Support
              the proposal
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">No</span> - Oppose
              the proposal
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">After Voting</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Once you've voted, you can verify your vote was counted by checking
          the Public Votes page. You'll see the nullifier hash associated with
          your vote (only you can link it to yourself).
        </p>
      </div>

      <div className="p-5 rounded-lg border bg-card">
        <h4 className="font-semibold mb-2">No Take-Backs</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Once submitted, votes cannot be changed or withdrawn. The nullifier
          mechanism prevents any modification after the fact. Make sure you're
          certain before submitting.
        </p>
      </div>
    </div>
  );
}

function PrivacyModel() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Privacy Model
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Understanding what's private and what's public is crucial for using
          ZKVote effectively.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">What Stays Private</h3>
        <div className="space-y-3">
          {[
            {
              title: "Your identity as a voter",
              desc: "No one can link a specific vote to your wallet address",
            },
            {
              title: "Which Merkle leaf is yours",
              desc: "Your position in the membership tree remains hidden",
            },
            {
              title: "Your secret and salt",
              desc: "The cryptographic credentials used to generate proofs never leave your browser",
            },
          ].map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20"
            >
              <svg
                className="w-5 h-5 text-green-500 mt-0.5 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <span className="font-medium">{item.title}</span>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {item.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">What's Publicly Visible</h3>
        <div className="space-y-3">
          {[
            {
              title: "Individual vote choices",
              desc: "Each vote (Yes/No) is public, but not who cast it",
            },
            {
              title: "Aggregate vote tallies",
              desc: "Total Yes/No counts are public",
            },
            {
              title: "Nullifier hashes",
              desc: "Used to prevent double-voting, but can't be linked to identity",
            },
            {
              title: "Merkle root",
              desc: "The root hash of the membership tree",
            },
            {
              title: "Membership commitments",
              desc: "The commitments in the Merkle tree (but not who owns them)",
            },
            {
              title: "Proof validity",
              desc: "Whether a submitted proof was valid",
            },
          ].map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border"
            >
              <svg
                className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                <path
                  fillRule="evenodd"
                  d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <span className="font-medium">{item.title}</span>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {item.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Privacy Considerations</h3>
        <div className="space-y-6">
          <div>
            <h4 className="font-medium mb-2">Relayer Trust</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The relayer sees your proof before submitting it, but cannot
              extract your vote choice or identity from it.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Timing Analysis</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you're the only person voting at a specific time, an observer
              might correlate your vote with your on-chain activity. For better
              privacy, vote when others are also voting.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Credential Security</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Your voting credentials are derived from your wallet. Anyone with
              access to your wallet can compute your credentials and vote on
              your behalf. Keep your wallet secure.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TechnicalDeepDive() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">Tech</h2>
        <p className="text-muted-foreground leading-relaxed">
          This section covers the cryptographic primitives and smart contract
          architecture powering ZKVote.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Cryptographic Primitives</h3>
        <div className="space-y-6">
          <div>
            <h4 className="font-medium mb-2">Groth16 ZK-SNARKs</h4>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              ZKVote uses Groth16, a zero-knowledge proof system that produces
              constant-size proofs (~200 bytes) regardless of the computation's
              complexity. Key properties:
            </p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>
                  <span className="font-medium text-foreground">
                    Succinctness
                  </span>{" "}
                  - Proofs are tiny and fast to verify
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>
                  <span className="font-medium text-foreground">
                    Non-interactive
                  </span>{" "}
                  - No back-and-forth between prover and verifier
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>
                  <span className="font-medium text-foreground">
                    Zero-knowledge
                  </span>{" "}
                  - Reveals nothing beyond the statement's validity
                </span>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-medium mb-2">BN254 Elliptic Curve</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              BN254 (also known as alt_bn128) is a pairing-friendly elliptic
              curve used for Groth16 verification. It enables efficient bilinear
              pairings required for proof verification. Stellar Protocol 25 adds
              native support for BN254 operations.
            </p>
          </div>

          <div>
            <h4 className="font-medium mb-2">Poseidon Hash Function</h4>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              Poseidon is a ZK-friendly hash function optimized for arithmetic
              circuits. It's used for:
            </p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>Computing member commitments</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>Building the Merkle tree</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
                <span>Deriving nullifiers</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">
          Smart Contract Architecture
        </h3>
        <div className="p-6 rounded-lg border bg-card font-mono text-sm">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-zinc-400"></div>
              <span className="font-semibold">DAORegistry</span>
              <span className="text-muted-foreground ml-auto">
                create_dao(), get_admin()
              </span>
            </div>
            <div className="border-l-2 border-border ml-1.5 pl-6 py-2">
              <p className="text-muted-foreground text-xs">
                Manages DAO creation and admin verification
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-blue-500"></div>
              <span className="font-semibold">MembershipSBT</span>
              <span className="text-muted-foreground ml-auto">
                mint(), has()
              </span>
            </div>
            <div className="border-l-2 border-border ml-1.5 pl-6 py-2">
              <p className="text-muted-foreground text-xs">
                Issues soulbound tokens for DAO membership
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span className="font-semibold">MembershipTree</span>
              <span className="text-muted-foreground ml-auto">
                self_register(), get_root()
              </span>
            </div>
            <div className="border-l-2 border-border ml-1.5 pl-6 py-2">
              <p className="text-muted-foreground text-xs">
                On-chain Poseidon Merkle tree for commitments
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-orange-500"></div>
              <span className="font-semibold">Voting</span>
              <span className="text-muted-foreground ml-auto">
                vote(), create_proposal()
              </span>
            </div>
            <div className="border-l-2 border-border ml-1.5 pl-6 py-2">
              <p className="text-muted-foreground text-xs">
                Groth16 proof verification and vote tallying
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-purple-500"></div>
              <span className="font-semibold">Comments</span>
              <span className="text-muted-foreground ml-auto">
                add_comment(), add_anonymous_comment()
              </span>
            </div>
            <div className="border-l-2 border-border ml-1.5 pl-6 py-2">
              <p className="text-muted-foreground text-xs">
                Public and anonymous comments with ZK proof verification
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">The ZK Circuit</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          The vote circuit (written in Circom) proves the following statement:
        </p>
        <div className="p-6 rounded-lg border bg-card font-mono text-sm">
          <p className="text-muted-foreground mb-2">
            // Public inputs (5 signals)
          </p>
          <p>root, nullifier, daoId, proposalId, voteChoice</p>
          <p className="text-muted-foreground mt-4 mb-2">// Private inputs</p>
          <p>secret, salt, commitment, pathElements[], pathIndices[]</p>
          <p className="text-muted-foreground mt-4 mb-2">// Constraints</p>
          <p>1. commitment == Poseidon(secret, salt)</p>
          <p>2. MerkleProof(commitment, pathElements) == root</p>
          <p>3. nullifier == Poseidon(secret, daoId, proposalId)</p>
          <p>4. voteChoice ∈ {"{0, 1}"} // No, Yes</p>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Security Properties</h3>
        <div className="space-y-6">
          <div>
            <h4 className="font-medium mb-2">Soundness</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              An invalid proof will be rejected with overwhelming probability.
              You cannot vote without being a member or vote twice on the same
              proposal.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Zero-Knowledge</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The proof reveals nothing about your identity beyond what's
              explicitly public. Your vote choice is public, but your identity
              remains hidden behind your commitment.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Trusted Setup</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Groth16 requires a trusted setup ceremony to generate the proving
              and verification keys. If the setup is compromised, fake proofs
              could be generated. By default, ZKVote uses the{" "}
              <a
                href="https://github.com/iden3/snarkjs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-2 hover:text-primary"
              >
                snarkjs
              </a>{" "}
              powersOfTau28_hez_final_18.ptau ceremony file, which had 54
              participants. DAO admins can set their own verification key at any
              time if they prefer a different trusted setup.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Comments Contract</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          The Comments contract enables on-chain discussions with both public
          and anonymous modes:
        </p>
        <div className="p-6 rounded-lg border bg-card font-mono text-sm">
          <p className="text-muted-foreground mb-2">
            // Public comment (signed by author)
          </p>
          <p>
            add_comment(dao_id, proposal_id, content_cid, parent_id, author)
          </p>
          <p className="text-muted-foreground mt-4 mb-2">
            // Anonymous comment (ZK proof verified)
          </p>
          <p>
            add_anonymous_comment(dao_id, proposal_id, content_cid, parent_id,
            proof, public_signals)
          </p>
          <p className="text-muted-foreground mt-4 mb-2">
            // Comment management
          </p>
          <p>edit_comment(dao_id, proposal_id, comment_id, new_cid, author)</p>
          <p>delete_comment(dao_id, proposal_id, comment_id, caller)</p>
          <p>get_comments(dao_id, proposal_id) -&gt; Vec&lt;CommentInfo&gt;</p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed mt-4">
          Anonymous comments use the same vote circuit and nullifier formula as
          votes. The key difference is that the Comments contract doesn't
          enforce nullifier uniqueness, allowing multiple anonymous comments per
          member per proposal. All anonymous comments by the same member on the
          same proposal will have the same nullifier value.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">IPFS Integration</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          Comment and proposal content is stored off-chain on IPFS. The contract
          stores only the CID (Content Identifier), a cryptographic hash that
          uniquely identifies the content.
        </p>
        <div className="p-6 rounded-lg border bg-card font-mono text-sm">
          <p className="text-muted-foreground mb-2">
            // Comment metadata format
          </p>
          <p>{"{"}</p>
          <p className="ml-4">"version": 1,</p>
          <p className="ml-4">"body": "Comment text...",</p>
          <p className="ml-4">"createdAt": "2024-01-15T10:30:00Z"</p>
          <p>{"}"}</p>
          <p className="text-muted-foreground mt-4">
            -&gt; IPFS CID: bafybeig...
          </p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed mt-4">
          The relayer provides an IPFS pinning endpoint that stores content via
          Pinata. Content is immutable - edits create new CIDs that are added to
          the revision history.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Relayer Architecture</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          The relayer is a backend service that enables anonymous operations by
          breaking the link between user wallets and on-chain actions.
        </p>
        <div className="space-y-3">
          {[
            {
              endpoint: "POST /vote",
              desc: "Submit anonymous vote with ZK proof",
            },
            {
              endpoint: "POST /comment/anonymous",
              desc: "Submit anonymous comment with ZK proof",
            },
            { endpoint: "POST /ipfs/metadata", desc: "Upload content to IPFS" },
            { endpoint: "GET /ipfs/:cid", desc: "Retrieve content from IPFS" },
            {
              endpoint: "GET /comments/:daoId/:proposalId",
              desc: "Fetch comments for a proposal",
            },
            { endpoint: "GET /health", desc: "Check relayer status" },
          ].map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border font-mono text-sm"
            >
              <span className="text-muted-foreground shrink-0 w-48">
                {item.endpoint}
              </span>
              <span className="text-xs text-muted-foreground">{item.desc}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed mt-4">
          The frontend uses exponential backoff (1s, 2s, 4s... up to 30s) when
          the relayer is unreachable, preventing request flooding and showing a
          status banner to users.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Costs</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          Groth16 verification on Soroban requires 4 pairing operations and 6
          scalar multiplications. Typical costs:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>DAO creation: ~1 XLM</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Member registration: ~0.04 XLM</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Vote/anonymous comment submission: paid by relayer</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>Public comment: ~0.01 XLM (paid by author)</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Commenting() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          Commenting on Proposals
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          ZKVote supports both public and anonymous comments on proposals.
          Public comments are tied to your wallet address, while anonymous
          comments use ZK proofs to verify membership without revealing
          identity.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Comment Types</h3>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2 flex items-center gap-2">
              <svg
                className="w-5 h-5 text-blue-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z"
                  clipRule="evenodd"
                />
              </svg>
              Public Comments
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Signed with your wallet and tied to your address. Other members
              can see who posted the comment. Use this when you want to be
              accountable for your opinion or build reputation.
            </p>
          </div>

          <div className="p-4 rounded-lg border bg-card">
            <h4 className="font-medium mb-2 flex items-center gap-2">
              <svg
                className="w-5 h-5 text-purple-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z"
                  clipRule="evenodd"
                />
                <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
              </svg>
              Anonymous Comments
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Use ZK proofs to verify you're a DAO member without revealing your
              identity. Perfect for sensitive feedback, whistleblowing, or
              honest opinions without social pressure.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">
          How Anonymous Comments Work
        </h3>
        <div className="space-y-4">
          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              1
            </div>
            <div>
              <h4 className="font-medium">Generate ZK Proof</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                When you submit an anonymous comment, your browser generates a
                zero-knowledge proof that you're a DAO member. This uses the
                same circuit as voting - proving Merkle tree membership.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              2
            </div>
            <div>
              <h4 className="font-medium">Submit via Relayer</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                The comment is sent through the relayer service, which submits
                it to the Comments contract. This breaks the link between your
                wallet and the comment.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start p-4 rounded-lg border bg-card">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
              3
            </div>
            <div>
              <h4 className="font-medium">Multiple Comments Allowed</h4>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                Unlike voting, you can post multiple anonymous comments on the
                same proposal. Anonymous comments use the same nullifier formula
                as votes (Poseidon(secret, daoId, proposalId)), but the Comments
                contract doesn't enforce nullifier uniqueness for comments.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Comment Features</h3>
        <ul className="space-y-2 text-muted-foreground">
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">
                Threaded replies
              </span>{" "}
              - Reply to any comment to create discussion threads
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">IPFS storage</span>{" "}
              - Comment content stored on IPFS for decentralization
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">Edit history</span>{" "}
              - Revisions tracked on-chain with IPFS CIDs
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 mt-2 shrink-0"></span>
            <span>
              <span className="font-medium text-foreground">Moderation</span> -
              Authors can delete their own comments; admins can moderate
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">
          Content Storage with IPFS
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          Comment content is stored on IPFS (InterPlanetary File System) rather
          than directly on-chain. This provides several benefits:
        </p>
        <div className="space-y-3">
          {[
            {
              title: "Cost efficiency",
              desc: "IPFS storage is cheaper than on-chain storage",
            },
            {
              title: "Decentralization",
              desc: "Content persists across multiple nodes",
            },
            {
              title: "Immutability",
              desc: "Content-addressed storage ensures data integrity",
            },
            {
              title: "Privacy",
              desc: "Content can be stored before on-chain reference is created",
            },
          ].map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border"
            >
              <svg
                className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <span className="font-medium">{item.title}</span>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {item.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="p-5 rounded-lg border bg-card">
        <h4 className="font-semibold mb-2">Relayer Dependency</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Anonymous comments require the relayer service to be online. If the
          relayer is unavailable, you'll see a warning banner and can only post
          public comments. Public comments are submitted directly through your
          wallet without needing the relayer.
        </p>
      </div>
    </div>
  );
}

export default Docs;
