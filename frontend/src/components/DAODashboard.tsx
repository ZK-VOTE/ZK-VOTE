import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { initializeContractClients } from "../lib/contracts";
import {
  getReadOnlyDaoRegistry,
  getReadOnlyMembershipSbt,
  getReadOnlyMembershipTree,
} from "../lib/readOnlyContracts";
import { useWallet } from "../hooks/useWallet";
import { useRegistration } from "../hooks/useRegistration";
import { isUserRejection, extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";
import { type DAOMetadata, fetchDAOMetadata } from "../lib/daoMetadata";
import { Alert, LoadingSpinner, CreateProposalForm } from "./ui";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import ProposalList from "./ProposalList";
import ManageMembers from "./ManageMembers";
import DAOInfoPanel from "./DAOInfoPanel";
import DAOSettings from "./DAOSettings";
import DAOHeader, { type DAOTab, type DAOInfo } from "./DAOHeader";
import RegistrationFlow from "./RegistrationFlow";

interface DAODashboardProps {
  publicKey: string | null;
  daoId: number;
  isInitializing?: boolean;
  initialTab?: DAOTab;
}

export default function DAODashboard({
  publicKey,
  daoId,
  isInitializing = false,
  initialTab = "proposals",
}: DAODashboardProps) {
  const { kit } = useWallet();
  const navigate = useNavigate();

  const [dao, setDao] = useState<DAOInfo | null>(() => {
    const cacheKey = `dao_info_${daoId}`;
    const cached = localStorage.getItem(cacheKey);
    return cached ? JSON.parse(cached) : null;
  });
  const [loading, setLoading] = useState(() => {
    const cacheKey = `dao_info_${daoId}`;
    const cached = localStorage.getItem(cacheKey);
    return !cached;
  });
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [creatingProposal, setCreatingProposal] = useState(false);
  const [proposalKey, setProposalKey] = useState(0);
  const [pendingProposal, setPendingProposal] = useState<{
    title: string;
  } | null>(null);
  const activeTab = initialTab;
  const [metadata, setMetadata] = useState<DAOMetadata | null>(null);

  // Registration hook
  const registration = useRegistration({ daoId, publicKey, kit });

  // Merge registration errors into component error state
  useEffect(() => {
    if (registration.error) {
      setError(registration.error);
      registration.clearError();
    }
  }, [registration.error]);

  // Helper to get URL path for a tab
  const getTabPath = (tab: DAOTab) => {
    const daoSlug = dao?.name
      ? `${daoId}-${dao.name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")}`
      : String(daoId);
    if (tab === "proposals") return `/daos/${daoSlug}`;
    return `/daos/${daoSlug}/${tab}`;
  };

  const navigateToTab = (tab: DAOTab) => {
    navigate(getTabPath(tab));
  };

  useEffect(() => {
    if (isInitializing) return;
    Promise.all([loadDAOInfo(), registration.checkRegistrationStatus()]);
  }, [daoId, publicKey, isInitializing]);

  // Update page title and meta description based on active tab
  useEffect(() => {
    const daoName = dao?.name || "DAO";
    const tabMeta: Record<DAOTab, { title: string; description: string }> = {
      proposals: {
        title: `${daoName} - Proposals | ZKVote`,
        description: `View and vote on proposals for ${daoName}. Participate in decentralized governance with zero-knowledge privacy.`,
      },
      info: {
        title: `${daoName} - Info | ZKVote`,
        description: `Learn about ${daoName} DAO - membership status, voting setup, and governance details.`,
      },
      members: {
        title: `${daoName} - Members | ZKVote`,
        description: `View members of ${daoName} DAO. See who's participating in this decentralized community.`,
      },
      settings: {
        title: `${daoName} - Settings | ZKVote`,
        description: `Manage settings for ${daoName} DAO. Configure membership and proposal permissions.`,
      },
      "create-proposal": {
        title: `${daoName} - New Proposal | ZKVote`,
        description: `Create a new proposal for ${daoName} DAO. Start a vote for the community.`,
      },
    };

    const { title, description } = tabMeta[activeTab];
    document.title = title;

    let metaDescription = document.querySelector('meta[name="description"]');
    if (!metaDescription) {
      metaDescription = document.createElement("meta");
      metaDescription.setAttribute("name", "description");
      document.head.appendChild(metaDescription);
    }
    metaDescription.setAttribute("content", description);
  }, [activeTab, dao?.name]);

  const loadDAOInfo = async () => {
    const cacheKey = `dao_info_${daoId}`;

    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const cachedDao = JSON.parse(cached);
        setDao(cachedDao);
        setLoading(false);

        if (cachedDao.metadataCid) {
          const metadataCacheKey = `dao_metadata_${cachedDao.metadataCid}`;
          const cachedMetadata = localStorage.getItem(metadataCacheKey);
          if (cachedMetadata) {
            setMetadata(JSON.parse(cachedMetadata));
          }
        }
      }

      setError(null);

      let useReadOnly = !publicKey;
      let daoResult;

      if (publicKey && !useReadOnly) {
        try {
          const clients = initializeContractClients(publicKey);
          daoResult = await clients.daoRegistry.get_dao({
            dao_id: BigInt(daoId),
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (
            errorMessage.includes("Account not found") ||
            errorMessage.includes("does not exist")
          ) {
            console.warn(
              "Connected wallet account not found on network, using read-only mode",
            );
            useReadOnly = true;
          } else {
            throw err;
          }
        }
      }

      if (useReadOnly || !daoResult) {
        const registry = getReadOnlyDaoRegistry();
        daoResult = await registry.get_dao({
          dao_id: BigInt(daoId),
        });
      }

      const [hasSBT, treeInitialized] = await Promise.all([
        !useReadOnly && publicKey ? checkMembership() : Promise.resolve(false),
        checkTreeInitialized(),
      ]);
      const vkSet = await checkVKSet();
      const isAdmin =
        !useReadOnly && publicKey
          ? daoResult.result.admin === publicKey
          : false;

      const metadataCid = daoResult.result.metadata_cid || null;

      const daoInfo: DAOInfo = {
        id: daoId,
        name: daoResult.result.name,
        creator: daoResult.result.admin,
        hasMembership: hasSBT,
        isAdmin,
        treeInitialized,
        vkSet,
        membershipOpen: daoResult.result.membership_open,
        membersCanPropose: daoResult.result.members_can_propose ?? true,
        metadataCid,
      };

      setDao(daoInfo);
      localStorage.setItem(cacheKey, JSON.stringify(daoInfo));

      if (metadataCid) {
        fetchDAOMetadata(metadataCid).then((meta) => {
          if (meta) {
            setMetadata(meta);
            const metadataCacheKey = `dao_metadata_${metadataCid}`;
            localStorage.setItem(metadataCacheKey, JSON.stringify(meta));
          }
        });
      } else {
        setMetadata(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load DAO");
      console.error("Failed to load DAO:", err);
    } finally {
      setLoading(false);
    }
  };

  const checkMembership = async (): Promise<boolean> => {
    if (!publicKey) return false;
    try {
      try {
        const clients = initializeContractClients(publicKey);
        const result = await clients.membershipSbt.has({
          dao_id: BigInt(daoId),
          of: publicKey,
        });
        return result.result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (
          errorMessage.includes("Account not found") ||
          errorMessage.includes("does not exist")
        ) {
          const sbtClient = getReadOnlyMembershipSbt();
          const result = await sbtClient.has({
            dao_id: BigInt(daoId),
            of: publicKey,
          });
          return result.result;
        }
        throw err;
      }
    } catch (err) {
      console.error("Failed to check membership:", err);
      return false;
    }
  };

  const checkTreeInitialized = async (): Promise<boolean> => {
    try {
      const treeClient = getReadOnlyMembershipTree();
      const result = await treeClient.get_tree_info({
        dao_id: BigInt(daoId),
      });
      const depth = Number(result.result[0]);
      return depth > 0;
    } catch (err) {
      console.error("Failed to check tree initialization:", err);
      return false;
    }
  };

  const checkVKSet = async (): Promise<boolean> => {
    return true;
  };

  const handleJoinDao = async () => {
    try {
      setJoining(true);
      setError(null);

      const clients = initializeContractClients(publicKey || "");

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      const tx = await clients.membershipSbt.self_join({
        dao_id: BigInt(daoId),
        member: publicKey || "",
        encrypted_alias: undefined,
      });

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "member_added", txHash, { member: publicKey });
      }

      setDao((prev) => (prev ? { ...prev, hasMembership: true } : prev));

      const cacheKey = `dao_info_${daoId}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const cachedDao = JSON.parse(cached);
        cachedDao.hasMembership = true;
        localStorage.setItem(cacheKey, JSON.stringify(cachedDao));
      }

      await loadDAOInfo();

      if (import.meta.env.DEV)
        console.log(
          "Successfully joined DAO! Click 'Register for Voting' to set up voting credentials.",
        );
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : "Failed to join DAO");
        console.error("Join DAO failed:", err);
      }
    } finally {
      setJoining(false);
    }
  };

  const handleCreateProposal = async (data: {
    title: string;
    contentCid: string;
    voteMode: "fixed" | "trailing";
    deadlineSeconds: number;
  }) => {
    try {
      setCreatingProposal(true);
      setError(null);

      const clients = initializeContractClients(publicKey || "");

      let endTime: bigint;
      if (data.deadlineSeconds === 0) {
        endTime = BigInt(0);
      } else {
        endTime = BigInt(Math.floor(Date.now() / 1000) + data.deadlineSeconds);
      }

      const tx = await clients.voting.create_proposal({
        dao_id: BigInt(daoId),
        title: data.title,
        content_cid: data.contentCid,
        end_time: endTime,
        creator: publicKey || "",
        vote_mode: {
          tag: data.voteMode === "fixed" ? "Fixed" : "Trailing",
          values: void 0,
        },
      });

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      const result = await tx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(daoId, "proposal_created", txHash, {
          title: data.title,
          contentCid: data.contentCid,
        });
      }

      setPendingProposal({ title: data.title });
      navigateToTab("proposals");

      setTimeout(() => {
        setPendingProposal(null);
        setProposalKey((prev) => prev + 1);
      }, 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create proposal",
      );
      console.error("Failed to create proposal:", err);
    } finally {
      setCreatingProposal(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size="lg" color="blue" />
      </div>
    );
  }

  if (error && !dao) {
    return <Alert variant="error">{error}</Alert>;
  }

  if (!dao) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">DAO not found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <DAOHeader
        dao={dao}
        metadata={metadata}
        activeTab={activeTab}
        publicKey={publicKey}
        hasKit={!!kit}
        joining={joining}
        onJoin={handleJoinDao}
        isRegistered={registration.isRegistered}
        hasUnregisteredCredentials={registration.hasUnregisteredCredentials}
        isRegistering={registration.isRegistering}
        registrationStatus={registration.registrationStatus}
        onRegister={registration.register}
        navigateToTab={navigateToTab}
      />

      <RegistrationFlow
        registrationStatus={registration.registrationStatus}
        isRegistering={registration.isRegistering}
      />

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {activeTab === "info" && (
        <DAOInfoPanel
          key={`info-${dao.hasMembership}`}
          daoId={daoId}
          publicKey={publicKey}
          kit={kit}
        />
      )}

      {activeTab === "proposals" && (
        <ProposalList
          key={`proposals-${proposalKey}-${dao.hasMembership}`}
          publicKey={publicKey}
          daoId={daoId}
          daoName={dao.name}
          kit={kit}
          hasMembership={dao.hasMembership}
          vkSet={dao.vkSet}
          isInitializing={isInitializing}
          pendingProposal={pendingProposal}
        />
      )}

      {activeTab === "members" && (
        <ManageMembers
          key={`members-${dao.hasMembership}-${dao.isAdmin}`}
          daoId={daoId}
          publicKey={publicKey}
          isAdmin={dao.isAdmin}
        />
      )}

      {activeTab === "create-proposal" && (
        <Card>
          <CardHeader>
            <CardTitle>New Proposal</CardTitle>
            <CardDescription>
              Create a new proposal for the community to vote on.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateProposalForm
              onSubmit={handleCreateProposal}
              onCancel={() => {
                navigateToTab("proposals");
                setError(null);
              }}
              isSubmitting={creatingProposal}
            />
          </CardContent>
        </Card>
      )}

      {activeTab === "settings" && dao.isAdmin && publicKey && kit && (
        <DAOSettings
          daoId={daoId}
          daoName={dao.name}
          publicKey={publicKey}
          kit={kit}
          membershipOpen={dao.membershipOpen}
          membersCanPropose={dao.membersCanPropose}
          metadataCid={dao.metadataCid}
          onSettingsChanged={loadDAOInfo}
        />
      )}
    </div>
  );
}
