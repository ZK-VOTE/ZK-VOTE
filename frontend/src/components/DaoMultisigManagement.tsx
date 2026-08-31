/**
 * DaoMultisigManagement Component
 *
 * Provides UI for DAO multisig administration:
 * - Initialize multisig with signers and threshold
 * - View multisig configuration
 * - Create multisig proposals
 * - Sign and execute proposals
 */

import React, { useState } from "react";

export type MultisigActionType =
  | "TransferAdmin"
  | "SetRole"
  | "UpdateMultisig"
  | "RevokeRole"
  | "Other";

interface MultisigConfig {
  daoId: number;
  signers: string[];
  threshold: number;
  createdAt?: number;
}

interface MultisigProposal {
  proposalId: number;
  title: string;
  description: string;
  actionType: MultisigActionType;
  proposer: string;
  createdAt?: number;
  expiresAt?: number;
  signatures: string[];
  executed: boolean;
}

interface DaoMultisigManagementProps {
  daoId: number;
  onInitMultisig: (signers: string[], threshold: number) => Promise<void>;
  onCreateProposal: (
    title: string,
    description: string,
    actionType: MultisigActionType,
    actionData: string
  ) => Promise<MultisigProposal>;
  onSignProposal: (proposalId: number) => Promise<void>;
  onExecuteProposal: (proposalId: number) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}

export const DaoMultisigManagement: React.FC<DaoMultisigManagementProps> = ({
  daoId,
  onInitMultisig,
  onCreateProposal,
  onSignProposal,
  onExecuteProposal,
  loading = false,
  error = null,
}) => {
  const [tab, setTab] = useState<"config" | "proposals">("config");
  const [multisigConfig, setMultisigConfig] = useState<MultisigConfig | null>(
    null
  );
  const [proposals, setProposals] = useState<MultisigProposal[]>([]);

  // Config form state
  const [signerInput, setSignerInput] = useState("");
  const [signers, setSigners] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(1);

  // Proposal form state
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalDescription, setProposalDescription] = useState("");
  const [proposalActionType, setProposalActionType] =
    useState<MultisigActionType>("TransferAdmin");

  const addSigner = () => {
    if (signerInput.trim() && !signers.includes(signerInput)) {
      setSigners([...signers, signerInput]);
      setSignerInput("");
    }
  };

  const removeSigner = (signer: string) => {
    setSigners(signers.filter((s) => s !== signer));
    if (threshold > signers.length - 1) {
      setThreshold(Math.max(1, signers.length - 1));
    }
  };

  const handleInitMultisig = async (e: React.FormEvent) => {
    e.preventDefault();

    if (signers.length === 0) {
      alert("Add at least one signer");
      return;
    }

    if (threshold < 1 || threshold > signers.length) {
      alert(
        `Threshold must be between 1 and ${signers.length}`
      );
      return;
    }

    try {
      await onInitMultisig(signers, threshold);
      setMultisigConfig({
        daoId,
        signers,
        threshold,
        createdAt: Math.floor(Date.now() / 1000),
      });
      setSigners([]);
      setThreshold(1);
    } catch (err) {
      console.error("Failed to initialize multisig:", err);
    }
  };

  const handleCreateProposal = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!proposalTitle.trim()) {
      alert("Enter a proposal title");
      return;
    }

    try {
      const proposal = await onCreateProposal(
        proposalTitle,
        proposalDescription,
        proposalActionType,
        "" // actionData would be serialized form data
      );
      setProposals([...proposals, proposal]);
      setProposalTitle("");
      setProposalDescription("");
    } catch (err) {
      console.error("Failed to create proposal:", err);
    }
  };

  const handleSignProposal = async (proposalId: number) => {
    try {
      await onSignProposal(proposalId);
      setProposals(
        proposals.map((p) =>
          p.proposalId === proposalId
            ? {
                ...p,
                signatures: [
                  ...p.signatures,
                  "CURRENT_USER", // Would be replaced with actual user
                ],
              }
            : p
        )
      );
    } catch (err) {
      console.error("Failed to sign proposal:", err);
    }
  };

  const handleExecuteProposal = async (proposalId: number) => {
    if (
      !window.confirm(
        "Execute this proposal? This action cannot be undone."
      )
    ) {
      return;
    }

    try {
      await onExecuteProposal(proposalId);
      setProposals(
        proposals.map((p) =>
          p.proposalId === proposalId ? { ...p, executed: true } : p
        )
      );
    } catch (err) {
      console.error("Failed to execute proposal:", err);
    }
  };

  const canExecuteProposal = (proposal: MultisigProposal) => {
    return (
      multisigConfig &&
      !proposal.executed &&
      proposal.signatures.length >= multisigConfig.threshold
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold mb-6">DAO Multisig Management</h2>

      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-4 mb-6 border-b">
        <button
          onClick={() => setTab("config")}
          className={`px-4 py-2 font-medium ${
            tab === "config"
              ? "border-b-2 border-blue-600 text-blue-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Configuration
        </button>
        <button
          onClick={() => setTab("proposals")}
          className={`px-4 py-2 font-medium ${
            tab === "proposals"
              ? "border-b-2 border-blue-600 text-blue-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Proposals
        </button>
      </div>

      {/* Configuration Tab */}
      {tab === "config" && (
        <div>
          {multisigConfig ? (
            <div>
              <h3 className="text-lg font-semibold mb-4">
                Current Configuration
              </h3>
              <div className="bg-gray-50 p-4 rounded-md mb-6">
                <p className="text-sm text-gray-600 mb-2">
                  <strong>Threshold:</strong> {multisigConfig.threshold} of{" "}
                  {multisigConfig.signers.length}
                </p>
                <p className="text-sm text-gray-600 mb-3">
                  <strong>Created:</strong>{" "}
                  {multisigConfig.createdAt
                    ? new Date(
                        multisigConfig.createdAt * 1000
                      ).toLocaleDateString()
                    : "Unknown"}
                </p>
                <div>
                  <strong className="block text-sm text-gray-600 mb-2">
                    Signers:
                  </strong>
                  <div className="space-y-1">
                    {multisigConfig.signers.map((signer, idx) => (
                      <div
                        key={idx}
                        className="text-xs font-mono bg-white p-2 rounded border border-gray-200"
                      >
                        {signer}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleInitMultisig}>
              <h3 className="text-lg font-semibold mb-4">
                Initialize Multisig
              </h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Add Signers
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={signerInput}
                    onChange={(e) => setSignerInput(e.target.value)}
                    placeholder="Signer address"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addSigner}
                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
                  >
                    Add
                  </button>
                </div>
              </div>

              {signers.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Signers ({signers.length})
                  </h4>
                  <div className="space-y-2">
                    {signers.map((signer, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
                      >
                        <span className="text-xs font-mono">{signer}</span>
                        <button
                          type="button"
                          onClick={() => removeSigner(signer)}
                          className="text-red-600 hover:text-red-700 text-sm"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Signature Threshold
                </label>
                <input
                  type="number"
                  min="1"
                  max={signers.length}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  disabled={signers.length === 0}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {threshold > 0 && threshold <= signers.length
                    ? `${threshold} of ${signers.length} signatures required`
                    : "Invalid threshold"}
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || signers.length === 0}
                className="w-full bg-blue-600 text-white py-2 rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition"
              >
                {loading ? "Initializing..." : "Initialize Multisig"}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Proposals Tab */}
      {tab === "proposals" && (
        <div>
          <form onSubmit={handleCreateProposal} className="mb-8">
            <h3 className="text-lg font-semibold mb-4">Create Proposal</h3>

            <div className="grid grid-cols-1 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Title
                </label>
                <input
                  type="text"
                  value={proposalTitle}
                  onChange={(e) => setProposalTitle(e.target.value)}
                  placeholder="Proposal title"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description
                </label>
                <textarea
                  value={proposalDescription}
                  onChange={(e) => setProposalDescription(e.target.value)}
                  placeholder="Proposal description"
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Action Type
                </label>
                <select
                  value={proposalActionType}
                  onChange={(e) =>
                    setProposalActionType(e.target.value as MultisigActionType)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                >
                  <option value="TransferAdmin">Transfer Admin</option>
                  <option value="SetRole">Set Role</option>
                  <option value="UpdateMultisig">Update Multisig</option>
                  <option value="RevokeRole">Revoke Role</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !proposalTitle.trim()}
              className="w-full bg-green-600 text-white py-2 rounded-md hover:bg-green-700 disabled:bg-gray-400 transition"
            >
              {loading ? "Creating..." : "Create Proposal"}
            </button>
          </form>

          {/* Proposals List */}
          <div>
            <h3 className="text-lg font-semibold mb-4">
              Proposals ({proposals.length})
            </h3>
            {proposals.length === 0 ? (
              <p className="text-gray-500">No proposals yet</p>
            ) : (
              <div className="space-y-4">
                {proposals.map((proposal) => (
                  <div
                    key={proposal.proposalId}
                    className={`p-4 rounded-md border ${
                      proposal.executed
                        ? "bg-green-50 border-green-200"
                        : "bg-gray-50 border-gray-200"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h4 className="font-semibold">{proposal.title}</h4>
                        <p className="text-sm text-gray-600">
                          {proposal.description}
                        </p>
                      </div>
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-medium ${
                          proposal.executed
                            ? "bg-green-200 text-green-800"
                            : "bg-blue-200 text-blue-800"
                        }`}
                      >
                        {proposal.executed ? "Executed" : "Pending"}
                      </span>
                    </div>

                    <div className="text-xs text-gray-500 mb-3">
                      <p>
                        Action: {proposal.actionType} | Signatures:{" "}
                        {proposal.signatures.length}
                        {multisigConfig && `/${multisigConfig.threshold}`}
                      </p>
                    </div>

                    {!proposal.executed && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleSignProposal(proposal.proposalId)}
                          disabled={loading}
                          className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:bg-gray-400"
                        >
                          Sign
                        </button>
                        {canExecuteProposal(proposal) && (
                          <button
                            onClick={() =>
                              handleExecuteProposal(proposal.proposalId)
                            }
                            disabled={loading}
                            className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:bg-gray-400"
                          >
                            Execute
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DaoMultisigManagement;
