import { useState } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import { extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";
import { Button } from "./ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
// LoadingSpinner is imported but currently unused (may be used for future loading states)
import { ConfirmModal } from "./ui/ConfirmModal";
import DAOProfileEditor from "./DAOProfileEditor";
import { Settings, Users, FileText, Loader2 } from "lucide-react";

interface DAOSettingsProps {
  daoId: number;
  daoName: string;
  publicKey: string;
  kit: StellarWalletsKit;
  membershipOpen: boolean;
  membersCanPropose: boolean;
  metadataCid: string | null;
  onSettingsChanged: () => void;
}

export default function DAOSettings({
  daoId,
  daoName,
  publicKey,
  kit,
  membershipOpen,
  membersCanPropose,
  metadataCid,
  onSettingsChanged,
}: DAOSettingsProps) {
  const [isTogglingMembership, setIsTogglingMembership] = useState(false);
  const [isTogglingProposals, setIsTogglingProposals] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    type: "membership" | "proposals";
    newValue: boolean;
  } | null>(null);

  const handleToggleMembership = async () => {
    if (!confirmModal) return;

    setIsTogglingMembership(true);
    setConfirmModal(null);

    try {
      const clients = initializeContractClients(publicKey);
      const newValue = !membershipOpen;

      const tx = await clients.daoRegistry.set_membership_open({
        dao_id: BigInt(daoId),
        membership_open: newValue,
        admin: publicKey,
      });

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of membership mode change
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "membership_mode_changed", txHash, {
          membershipOpen: newValue,
        });
      }

      onSettingsChanged();
    } catch (err) {
      console.error("Failed to toggle membership mode:", err);
    } finally {
      setIsTogglingMembership(false);
    }
  };

  const handleToggleProposals = async () => {
    if (!confirmModal) return;

    setIsTogglingProposals(true);
    setConfirmModal(null);

    try {
      const clients = initializeContractClients(publicKey);
      const newValue = !membersCanPropose;

      const tx = await clients.daoRegistry.set_proposal_mode({
        dao_id: BigInt(daoId),
        members_can_propose: newValue,
        admin: publicKey,
      });

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of proposal mode change
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "proposal_mode_changed", txHash, {
          membersCanPropose: newValue,
        });
      }

      onSettingsChanged();
    } catch (err) {
      console.error("Failed to toggle proposal mode:", err);
    } finally {
      setIsTogglingProposals(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            DAO Settings
          </CardTitle>
          <CardDescription>
            Configure membership and proposal settings for your DAO.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Membership Mode */}
          <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-background">
                <Users className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h4 className="font-medium">
                  {membershipOpen ? "Open Membership" : "Closed Membership"}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {membershipOpen
                    ? "Anyone can join the DAO"
                    : "Only admin can add members"}
                </p>
              </div>
            </div>
            <Button
              variant={membershipOpen ? "destructive" : "default"}
              size="sm"
              onClick={() =>
                setConfirmModal({
                  type: "membership",
                  newValue: !membershipOpen,
                })
              }
              disabled={isTogglingMembership}
            >
              {isTogglingMembership ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : membershipOpen ? (
                "Close Membership"
              ) : (
                "Open Membership"
              )}
            </Button>
          </div>

          {/* Proposal Mode */}
          <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-background">
                <FileText className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h4 className="font-medium">Member Proposals</h4>
                <p className="text-sm text-muted-foreground">
                  {membersCanPropose
                    ? "Any member can create proposals"
                    : "Only admin can create proposals"}
                </p>
              </div>
            </div>
            <Button
              variant={membersCanPropose ? "destructive" : "default"}
              size="sm"
              onClick={() =>
                setConfirmModal({
                  type: "proposals",
                  newValue: !membersCanPropose,
                })
              }
              disabled={isTogglingProposals}
            >
              {isTogglingProposals ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : membersCanPropose ? (
                "Restrict to Admin"
              ) : (
                "Allow Members"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Profile Editor */}
      <DAOProfileEditor
        daoId={daoId}
        daoName={daoName}
        publicKey={publicKey}
        kit={kit}
        metadataCid={metadataCid}
        onSaved={onSettingsChanged}
      />

      {/* Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmModal(null)}
          onConfirm={
            confirmModal.type === "membership"
              ? handleToggleMembership
              : handleToggleProposals
          }
          title={
            confirmModal.type === "membership"
              ? "Change Membership Mode"
              : "Change Proposal Mode"
          }
          message={
            confirmModal.type === "membership"
              ? confirmModal.newValue
                ? "This will allow anyone to join the DAO. Are you sure?"
                : "This will close membership. Only you (admin) will be able to add new members. Are you sure?"
              : confirmModal.newValue
                ? "This will allow any member to create proposals. Are you sure?"
                : "This will restrict proposal creation to admin only. Are you sure?"
          }
          confirmText="Confirm"
          variant="warning"
          isLoading={isTogglingMembership || isTogglingProposals}
        />
      )}
    </div>
  );
}
