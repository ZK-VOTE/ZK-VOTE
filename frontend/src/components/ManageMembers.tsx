import { useState, useCallback, useRef, useEffect } from "react";
import { initializeContractClients } from "../lib/contracts";
import { useWallet } from "../hooks/useWallet";
import { useMemberData } from "../hooks/useMemberData";
import type { TreeInfo, Member } from "../hooks/useMemberData";
import { encryptAlias } from "../lib/encryption";
import { Alert, LoadingSpinner, Badge } from "./ui";
import { ConfirmModal } from "./ui/ConfirmModal";
import { truncateAddress, extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";
import { MoreVertical, UserMinus, Shield } from "lucide-react";

// Dropdown menu for member actions (admin only)
interface MemberActionsMenuProps {
  onRemove: () => void;
  onMakeAdmin: () => void;
  disabled?: boolean;
}

function MemberActionsMenu({
  onRemove,
  onMakeAdmin,
  disabled,
}: MemberActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-50"
        title="Member actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50">
          <button
            onClick={() => {
              setIsOpen(false);
              onMakeAdmin();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
          >
            <Shield className="w-4 h-4 text-primary" />
            <span>Make Admin</span>
          </button>
          <button
            onClick={() => {
              setIsOpen(false);
              onRemove();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-destructive hover:bg-destructive/10 transition-colors"
          >
            <UserMinus className="w-4 h-4" />
            <span>Remove Member</span>
          </button>
        </div>
      )}
    </div>
  );
}

interface ManageMembersProps {
  publicKey: string | null;
  daoId: number;
  isAdmin: boolean;
  isInitializing?: boolean;
}

// Re-export types for consumers
export type { TreeInfo, Member };

export default function ManageMembers({
  publicKey,
  daoId,
  isAdmin,
  isInitializing = false,
}: ManageMembersProps) {
  const { kit } = useWallet();

  // Sign message helper - extracts signedMessage from response object if present
  const signMessage = useCallback(
    async (message: string): Promise<string | Uint8Array> => {
      if (!kit?.signMessage) {
        throw new Error("Wallet does not support message signing");
      }
      const res = await kit.signMessage(message);
      // Handle both response formats: { signedMessage: string } or direct string/Uint8Array
      if (typeof res === "object" && res !== null && "signedMessage" in res) {
        return (res as { signedMessage: string }).signedMessage;
      }
      return res as string | Uint8Array;
    },
    [kit],
  );

  // Use the data hook for member management
  const {
    loading,
    error,
    treeInfo,
    members,
    removedMembers,
    encryptionKey,
    memberAliases,
    encryptedAliases,
    refresh: loadTreeInfo,
    setError,
    setRemovedMembers,
    setMembers,
    unlockEncryption,
  } = useMemberData({
    daoId,
    publicKey,
    isInitializing,
    signMessage,
  });

  // Local UI state
  const [mintAddress, setMintAddress] = useState("");
  const [minting, setMinting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [memberAlias, setMemberAlias] = useState<string>("");
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState<string>("");
  const [updatingAlias, setUpdatingAlias] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [aliasesVisible, setAliasesVisible] = useState(false);
  const [aliasInputUnlocked, setAliasInputUnlocked] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<{
    address: string;
  } | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [makeAdminConfirm, setMakeAdminConfirm] = useState<{
    address: string;
  } | null>(null);
  const [transferringAdmin, setTransferringAdmin] = useState(false);

  const handleMintSBT = async () => {
    if (!mintAddress.trim()) {
      setError("Address is required");
      return;
    }

    try {
      setMinting(true);
      setError(null);
      setSuccess(null);

      const clients = initializeContractClients(publicKey || "");

      // Check if address already has an SBT
      const alreadyHas = await clients.membershipSbt.has({
        dao_id: BigInt(daoId),
        of: mintAddress,
      });

      if (alreadyHas.result) {
        setError(
          `Address ${mintAddress.substring(0, 8)}... already has a membership SBT for this DAO`,
        );
        setMinting(false);
        return;
      }

      // Get or derive encryption key and encrypt alias if provided
      let encryptedAliasValue: string | undefined = undefined;
      if (memberAlias.trim()) {
        const key = await unlockEncryption();
        if (!key) {
          setError("Failed to derive encryption key");
          setMinting(false);
          return;
        }

        encryptedAliasValue = encryptAlias(memberAlias, key);
      }

      const tx = await clients.membershipSbt.mint({
        dao_id: BigInt(daoId),
        to: mintAddress,
        admin: publicKey || "",
        encrypted_alias: encryptedAliasValue,
      });

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of member added event
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "member_added", txHash, {
          member: mintAddress,
          alias: memberAlias || undefined,
        });
      }

      setSuccess(
        `Successfully minted SBT to ${mintAddress.substring(0, 8)}...${memberAlias ? ` (${memberAlias})` : ""}`,
      );

      setMintAddress("");
      setMemberAlias("");

      // Reload tree info and members
      await loadTreeInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mint SBT");
      console.error("Failed to mint SBT:", err);
    } finally {
      setMinting(false);
    }
  };

  // Toggle revealing existing member aliases in the list
  const toggleAliasVisibility = async () => {
    if (aliasesVisible) {
      setAliasesVisible(false);
      return;
    }

    try {
      setError(null);
      const key = await unlockEncryption();
      if (key) {
        setAliasesVisible(true);
      } else {
        setError(
          "Failed to unlock aliases - signature was cancelled or failed",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reveal aliases");
    }
  };

  // Toggle unlocking the alias input field for adding new aliases
  const toggleAliasInput = async () => {
    if (aliasInputUnlocked) {
      setAliasInputUnlocked(false);
      setMemberAlias("");
      return;
    }

    try {
      setError(null);
      const key = await unlockEncryption();
      if (key) {
        setAliasInputUnlocked(true);
      } else {
        setError(
          "Failed to unlock alias input - signature was cancelled or failed",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to unlock alias input",
      );
    }
  };

  const handleRemoveMemberClick = (address: string) => {
    if (!isAdmin) {
      setError("Only admins can remove members");
      return;
    }
    setRevokeConfirm({ address });
  };

  const handleRemoveMemberConfirm = async () => {
    if (!revokeConfirm) return;
    const address = revokeConfirm.address;

    try {
      setRevoking(true);
      setError(null);
      setSuccess(null);

      const clients = initializeContractClients(publicKey || "");

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      // Step 1: Revoke the SBT (sets revoked flag)
      if (import.meta.env.DEV)
        console.log("[handleRemoveMember] Step 1: Revoking SBT...");
      const revokeTx = await clients.membershipSbt.revoke({
        dao_id: BigInt(daoId),
        member: address,
        admin: publicKey || "",
      });

      await revokeTx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });
      if (import.meta.env.DEV) console.log("[handleRemoveMember] SBT revoked");

      // Step 2: Remove member from Merkle tree (zeros their leaf)
      if (import.meta.env.DEV)
        console.log(
          "[handleRemoveMember] Step 2: Removing from Merkle tree...",
        );
      const removeTx = await clients.membershipTree.remove_member({
        dao_id: BigInt(daoId),
        member: address,
        admin: publicKey || "",
      });

      const removeResult = await removeTx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });
      if (import.meta.env.DEV)
        console.log("[handleRemoveMember] Member removed from tree");

      // Notify relayer of member revoked event
      const txHash = extractTxHash(removeResult);
      if (txHash) {
        notifyEvent(daoId, "member_revoked", txHash, { member: address });
      }

      // Update local state
      const updatedMembers = members.filter((m) => m.address !== address);
      const updatedRemoved = [...removedMembers, address];

      setMembers(updatedMembers);
      setRemovedMembers(updatedRemoved);
      setSuccess(
        `Successfully removed ${address.substring(0, 8)}... (SBT revoked + tree updated)`,
      );

      // Reload tree info to show updated root
      await loadTreeInfo();
      setRevokeConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
      console.error("Failed to remove member:", err);
    } finally {
      setRevoking(false);
      setRevokeConfirm(null);
    }
  };

  const handleLeaveClick = () => {
    setLeaveConfirm(true);
  };

  const handleLeaveConfirm = async () => {
    try {
      setLeaving(true);
      setError(null);
      setSuccess(null);

      const clients = initializeContractClients(publicKey || "");

      // Call the leave contract function
      const tx = await clients.membershipSbt.leave({
        dao_id: BigInt(daoId),
        member: publicKey || "",
      });

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of member left event
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "member_left", txHash, { member: publicKey || "" });
      }

      setSuccess(`You have left the DAO`);

      // Update local state
      const updatedMembers = members.filter((m) => m.address !== publicKey);
      const updatedRemoved = publicKey
        ? [...removedMembers, publicKey]
        : removedMembers;

      setMembers(updatedMembers);
      setRemovedMembers(updatedRemoved);
      setLeaveConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to leave DAO");
      console.error("Failed to leave DAO:", err);
    } finally {
      setLeaving(false);
      setLeaveConfirm(false);
    }
  };

  const handleUpdateAlias = async (memberAddress: string) => {
    if (!isAdmin) {
      setError("Only admins can update aliases");
      return;
    }

    if (!newAlias.trim()) {
      setError("Alias cannot be empty");
      return;
    }

    try {
      setUpdatingAlias(true);
      setError(null);
      setSuccess(null);

      // Use existing key or unlock encryption
      const key = encryptionKey || (await unlockEncryption());
      if (!key) {
        setError("Failed to derive encryption key");
        setUpdatingAlias(false);
        return;
      }

      // Encrypt the new alias
      const encrypted = encryptAlias(newAlias, key);

      const clients = initializeContractClients(publicKey || "");

      const tx = await clients.membershipSbt.update_alias({
        dao_id: BigInt(daoId),
        member: memberAddress,
        admin: publicKey || "",
        new_encrypted_alias: encrypted,
      });

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      await tx.signAndSend({ signTransaction: kit.signTransaction.bind(kit) });

      setSuccess(
        `Successfully updated alias for ${memberAddress.substring(0, 8)}...`,
      );

      // Reload to get updated aliases
      await loadTreeInfo();

      setEditingAlias(null);
      setNewAlias("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update alias");
    } finally {
      setUpdatingAlias(false);
    }
  };

  const handleMakeAdminClick = (address: string) => {
    if (!isAdmin) {
      setError("Only admins can transfer admin rights");
      return;
    }
    setMakeAdminConfirm({ address });
  };

  const handleMakeAdminConfirm = async () => {
    if (!makeAdminConfirm) return;
    const newAdminAddress = makeAdminConfirm.address;

    try {
      setTransferringAdmin(true);
      setError(null);
      setSuccess(null);

      const clients = initializeContractClients(publicKey || "");

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      // Call transfer_admin on the DAO registry
      const tx = await clients.daoRegistry.transfer_admin({
        dao_id: BigInt(daoId),
        new_admin: newAdminAddress,
      });

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of admin transfer event
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "admin_transfer", txHash, {
          old_admin: publicKey,
          new_admin: newAdminAddress,
        });
      }

      setSuccess(
        `Successfully transferred admin rights to ${newAdminAddress.substring(0, 8)}...`,
      );

      // Update local state - mark new admin
      const updatedMembers = members.map((m) => ({
        ...m,
        isAdmin: m.address === newAdminAddress,
      }));
      setMembers(updatedMembers);

      setMakeAdminConfirm(null);

      // Note: The current user is no longer admin, so the page will reflect that
      // A reload may be needed for full state update
      await loadTreeInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to transfer admin");
      console.error("Failed to transfer admin:", err);
    } finally {
      setTransferringAdmin(false);
      setMakeAdminConfirm(null);
    }
  };

  if (loading && !treeInfo && members.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Statistics Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Merkle Tree Depth
          </h3>
          <p className="text-3xl font-bold text-foreground">
            {treeInfo?.depth || 0}
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Registered Voters
          </h3>
          <p className="text-3xl font-bold text-primary">
            {treeInfo?.leafCount || 0}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Registered in Merkle tree
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Tree Capacity
          </h3>
          <p className="text-3xl font-bold text-foreground">
            {treeInfo?.depth ? Math.pow(2, treeInfo.depth).toLocaleString() : 0}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Maximum members</p>
        </div>

        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Verifying Key Version
          </h3>
          <p className="text-3xl font-bold text-primary">
            {treeInfo?.vkVersion ?? "N/A"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Proofs must match this version
          </p>
        </div>
      </div>

      {/* Merkle Root */}
      <div className="rounded-xl border bg-card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          Current Merkle Root
        </h3>
        <p className="font-mono text-xs text-muted-foreground break-all">
          {treeInfo?.root || "N/A"}
        </p>
      </div>

      {/* Current Members */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">
            Current Members ({members.length})
          </h3>
          {isAdmin && encryptedAliases.size > 0 && (
            <button
              onClick={toggleAliasVisibility}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors"
            >
              {aliasesVisible ? (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
                    />
                  </svg>
                  Hide Aliases
                </>
              ) : (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  Reveal Aliases
                </>
              )}
            </button>
          )}
        </div>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No members yet. {isAdmin ? "Mint an SBT to add members." : ""}
          </p>
        ) : (
          <div className="space-y-2">
            {members.map((member) => (
              <div key={member.address} className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="flex flex-col">
                      {editingAlias === member.address ? (
                        <input
                          type="text"
                          value={newAlias}
                          onChange={(e) => setNewAlias(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !updatingAlias) {
                              e.preventDefault();
                              handleUpdateAlias(member.address);
                            } else if (e.key === "Escape") {
                              setEditingAlias(null);
                              setNewAlias("");
                            }
                          }}
                          placeholder="Enter new alias..."
                          className="text-sm font-medium px-2 py-1 border border-primary/30 rounded bg-background text-primary"
                          autoFocus
                        />
                      ) : (
                        encryptedAliases.has(member.address) && (
                          <div className="min-h-[20px] transition-all duration-200">
                            {aliasesVisible ? (
                              memberAliases.has(member.address) && (
                                <p className="text-sm font-medium text-primary">
                                  {memberAliases.get(member.address)}
                                </p>
                              )
                            ) : (
                              <p className="text-sm font-medium text-muted-foreground truncate max-w-xs">
                                {encryptedAliases.get(member.address)}
                              </p>
                            )}
                          </div>
                        )
                      )}
                      <p className="font-mono text-xs text-muted-foreground">
                        {/* Truncated on mobile, full on md+ */}
                        <span className="md:hidden">
                          {truncateAddress(member.address, 5, 5)}
                        </span>
                        <span className="hidden md:inline">
                          {member.address}
                        </span>
                      </p>
                    </div>
                    {member.isAdmin && <Badge variant="blue">Admin</Badge>}
                    {member.address === publicKey && (
                      <Badge variant="secondary">You</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin &&
                      memberAliases.has(member.address) &&
                      editingAlias !== member.address && (
                        <button
                          onClick={() => {
                            setEditingAlias(member.address);
                            setNewAlias(
                              memberAliases.get(member.address) || "",
                            );
                          }}
                          className="p-1 text-primary hover:bg-primary/10 rounded transition-colors"
                          title="Edit alias"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                            />
                          </svg>
                        </button>
                      )}
                    {editingAlias === member.address && (
                      <>
                        <button
                          onClick={() => handleUpdateAlias(member.address)}
                          disabled={updatingAlias}
                          className="p-1 text-green-600 dark:text-green-400 hover:bg-green-500/10 rounded transition-colors disabled:opacity-50"
                          title="Save alias"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => {
                            setEditingAlias(null);
                            setNewAlias("");
                          }}
                          disabled={updatingAlias}
                          className="p-1 text-muted-foreground hover:bg-muted rounded transition-colors disabled:opacity-50"
                          title="Cancel"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </>
                    )}
                    {isAdmin &&
                      member.address !== publicKey &&
                      !member.isAdmin &&
                      editingAlias !== member.address && (
                        <MemberActionsMenu
                          onRemove={() =>
                            handleRemoveMemberClick(member.address)
                          }
                          onMakeAdmin={() =>
                            handleMakeAdminClick(member.address)
                          }
                        />
                      )}
                    {!isAdmin && member.address === publicKey && (
                      <button
                        onClick={handleLeaveClick}
                        disabled={leaving}
                        className="px-3 py-1 text-sm font-medium text-destructive bg-destructive/10 border border-destructive/20 rounded-md hover:bg-destructive/20 transition-colors disabled:opacity-50"
                        title="Leave DAO"
                      >
                        {leaving ? "Leaving..." : "Leave"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Removed Members */}
      {removedMembers.length > 0 && (
        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">
            Removed Members ({removedMembers.length})
          </h3>
          <div className="space-y-2">
            {removedMembers.map((address) => (
              <div key={address} className="p-3 bg-destructive/10 rounded-lg">
                <p className="font-mono text-sm text-foreground">
                  {/* Truncated on mobile, full on md+ */}
                  <span className="md:hidden">
                    {truncateAddress(address, 5, 5)}
                  </span>
                  <span className="hidden md:inline">{address}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Success Message */}
      {success && <Alert variant="success">{success}</Alert>}

      {/* Error Message */}
      {error && <Alert variant="error">{error}</Alert>}

      {/* Mint SBT Form - Admin Only */}
      {isAdmin && (
        <div className="rounded-xl border bg-card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">
            Mint Membership SBT
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Grant membership by minting a soulbound token to a Stellar address.
            Members can then register for anonymous voting.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Recipient Address
              </label>
              <input
                type="text"
                value={mintAddress}
                onChange={(e) => setMintAddress(e.target.value)}
                placeholder="G... (Stellar address)"
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground placeholder-muted-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-foreground">
                  Member Alias (Optional)
                </label>
                <button
                  onClick={toggleAliasInput}
                  type="button"
                  className="p-1.5 text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors"
                  title={
                    aliasInputUnlocked
                      ? "Lock alias input"
                      : "Unlock alias input"
                  }
                >
                  {aliasInputUnlocked ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="w-4 h-4"
                    >
                      <rect
                        width="12"
                        height="8.571"
                        x="6"
                        y="12.071"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        rx="2"
                      />
                      <path
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M16.286 8.643a4.286 4.286 0 0 0-8.572 0v3.428"
                      />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="w-4 h-4"
                    >
                      <rect
                        width="12.526"
                        height="8.947"
                        x="5.737"
                        y="12.053"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        rx="2"
                      />
                      <path
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M7.526 12.053v-3.58a4.474 4.474 0 0 1 8.948 0v3.58"
                      />
                    </svg>
                  )}
                </button>
              </div>
              <input
                type="text"
                value={memberAlias}
                onChange={(e) => setMemberAlias(e.target.value)}
                disabled={!aliasInputUnlocked}
                placeholder="e.g., Alice, Bob, Team Lead..."
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground placeholder-muted-foreground focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {aliasInputUnlocked
                  ? "Encrypted and stored on-chain. Only you can decrypt it."
                  : "Click the lock icon to unlock and add an alias."}
              </p>
            </div>

            <button
              onClick={handleMintSBT}
              disabled={minting || !mintAddress.trim()}
              className="w-full px-4 py-2 text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
            >
              {minting ? "Minting..." : "Mint SBT"}
            </button>
          </div>
        </div>
      )}

      {/* Revoke membership confirmation modal */}
      <ConfirmModal
        isOpen={!!revokeConfirm}
        onClose={() => setRevokeConfirm(null)}
        onConfirm={handleRemoveMemberConfirm}
        title="Revoke Membership"
        message={
          revokeConfirm
            ? `Revoke membership for ${revokeConfirm.address.substring(0, 8)}...? They will no longer be able to vote.`
            : ""
        }
        confirmText="Revoke"
        variant="danger"
        isLoading={revoking}
      />

      {/* Leave DAO confirmation modal */}
      <ConfirmModal
        isOpen={leaveConfirm}
        onClose={() => setLeaveConfirm(false)}
        onConfirm={handleLeaveConfirm}
        title="Leave DAO"
        message="Leave this DAO? You will no longer be able to vote."
        confirmText="Leave"
        variant="warning"
        isLoading={leaving}
      />

      {/* Make Admin confirmation modal */}
      <ConfirmModal
        isOpen={!!makeAdminConfirm}
        onClose={() => setMakeAdminConfirm(null)}
        onConfirm={handleMakeAdminConfirm}
        title="Transfer Admin Rights"
        message={
          makeAdminConfirm
            ? `Transfer admin rights to ${makeAdminConfirm.address.substring(0, 8)}...? You will no longer be the admin of this DAO.`
            : ""
        }
        confirmText="Transfer"
        variant="warning"
        isLoading={transferringAdmin}
      />
    </div>
  );
}
