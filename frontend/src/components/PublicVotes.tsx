import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { initializeContractClients } from "../lib/contracts";
import {
  getReadOnlyDaoRegistry,
  getReadOnlyMembershipSbt,
  getReadOnlyMembershipTree,
  getReadOnlyVoting,
} from "../lib/readOnlyContracts";
import { useWallet } from "../hooks/useWallet";
import ProposalList from "./ProposalList";
import ManageMembers from "./ManageMembers";
import DAOInfoPanel from "./DAOInfoPanel";
import {
  getZKCredentials,
  storeZKCredentials,
  generateDeterministicZKCredentials,
} from "../lib/zk";
import { isUserRejection, extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";
import { Alert, LoadingSpinner, CreateProposalForm } from "./ui";
import { Button } from "./ui/Button";
import { FileText, Users, PlusCircle, Home } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";

interface PublicVotesProps {
  publicKey: string | null;
  isConnected: boolean;
  isInitializing?: boolean;
  tab?: "info" | "proposals" | "members" | "create-proposal";
}

interface DAOInfo {
  id: number;
  name: string;
  creator: string;
  hasMembership: boolean;
  isRegistered: boolean;
  memberCount: number;
  vkVersion: number | null;
}

const PUBLIC_DAO_ID = 1;
const PUBLIC_DAO_CACHE_KEY = `public_dao_info_${PUBLIC_DAO_ID}`;

export default function PublicVotes({
  publicKey,
  isConnected,
  isInitializing = false,
  tab = "proposals",
}: PublicVotesProps) {
  const { kit } = useWallet();
  const navigate = useNavigate();
  const [dao, setDao] = useState<DAOInfo | null>(() => {
    // Initialize from cache for instant display
    const cached = localStorage.getItem(PUBLIC_DAO_CACHE_KEY);
    return cached ? JSON.parse(cached) : null;
  });
  const [loading, setLoading] = useState(() => {
    // Only show loading spinner if no cache exists
    const cached = localStorage.getItem(PUBLIC_DAO_CACHE_KEY);
    return !cached;
  });
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [proposalKey, setProposalKey] = useState(0);
  const [creatingProposal, setCreatingProposal] = useState(false);
  // Use tab prop from URL route - activeTab is now derived from the route
  const activeTab = tab;

  useEffect(() => {
    if (isInitializing) {
      return;
    }
    loadPublicDAO();
  }, [publicKey, isInitializing]);

  const loadPublicDAO = async () => {
    try {
      // Load from cache first for instant display
      const cached = localStorage.getItem(PUBLIC_DAO_CACHE_KEY);
      if (cached) {
        setDao(JSON.parse(cached));
        setLoading(false);
      } else {
        setLoading(true);
      }
      setError(null);

      const publicDaoId = PUBLIC_DAO_ID;

      let result;
      let vkResult;
      if (publicKey) {
        try {
          const clients = initializeContractClients(publicKey);
          result = await clients.daoRegistry.get_dao({
            dao_id: BigInt(publicDaoId),
          });
          vkResult = await clients.voting.vk_version({
            dao_id: BigInt(publicDaoId),
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (
            errorMessage.includes("Account not found") ||
            errorMessage.includes("does not exist")
          ) {
            const registry = getReadOnlyDaoRegistry();
            result = await registry.get_dao({
              dao_id: BigInt(publicDaoId),
            });
            const voting = getReadOnlyVoting();
            vkResult = await voting.vk_version({ dao_id: BigInt(publicDaoId) });
          } else {
            throw err;
          }
        }
      } else {
        const registry = getReadOnlyDaoRegistry();
        result = await registry.get_dao({
          dao_id: BigInt(publicDaoId),
        });
        const voting = getReadOnlyVoting();
        vkResult = await voting.vk_version({ dao_id: BigInt(publicDaoId) });
      }

      if (!result.result.membership_open) {
        setError("Public DAO not configured correctly. Please redeploy.");
        return;
      }

      let hasMembership = false;
      let isRegistered = false;

      if (publicKey) {
        try {
          if (publicKey) {
            try {
              const clients = initializeContractClients(publicKey);
              const membershipResult = await clients.membershipSbt.has({
                dao_id: BigInt(publicDaoId),
                of: publicKey,
              });
              hasMembership = membershipResult.result;
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              if (
                errorMessage.includes("Account not found") ||
                errorMessage.includes("does not exist")
              ) {
                const sbt = getReadOnlyMembershipSbt();
                const membershipResult = await sbt.has({
                  dao_id: BigInt(publicDaoId),
                  of: publicKey,
                });
                hasMembership = membershipResult.result;
              } else {
                throw err;
              }
            }
          } else {
            const sbt = getReadOnlyMembershipSbt();
            const membershipResult = await sbt.has({
              dao_id: BigInt(publicDaoId),
              of: publicKey,
            });
            hasMembership = membershipResult.result;
          }

          const cached = publicKey
            ? getZKCredentials(publicDaoId, publicKey)
            : null;
          if (cached && publicKey) {
            try {
              try {
                const clients = initializeContractClients(publicKey);
                const leafIndexResult =
                  await clients.membershipTree.get_leaf_index({
                    dao_id: BigInt(publicDaoId),
                    commitment: BigInt(cached.commitment),
                  });
                const onChainLeafIndex = Number(leafIndexResult.result);
                isRegistered = onChainLeafIndex === cached.leafIndex;
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : String(err);
                if (
                  errorMessage.includes("Account not found") ||
                  errorMessage.includes("does not exist")
                ) {
                  const tree = getReadOnlyMembershipTree();
                  const leafIndexResult = await tree.get_leaf_index({
                    dao_id: BigInt(publicDaoId),
                    commitment: BigInt(cached.commitment),
                  });
                  const onChainLeafIndex = Number(leafIndexResult.result);
                  isRegistered = onChainLeafIndex === cached.leafIndex;
                } else {
                  throw err;
                }
              }
            } catch {
              if (import.meta.env.DEV)
                console.log("Cached registration invalid, clearing...");
              isRegistered = false;
            }
          }
        } catch (e) {
          console.error("Failed to check membership:", e);
        }
      }

      let memberCount = 0;
      try {
        if (publicKey) {
          try {
            const clients = initializeContractClients(publicKey);
            const countResult = await clients.membershipSbt.get_member_count({
              dao_id: BigInt(publicDaoId),
            });
            memberCount = Number(countResult.result);
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            if (
              errorMessage.includes("Account not found") ||
              errorMessage.includes("does not exist")
            ) {
              const sbt = getReadOnlyMembershipSbt();
              const countResult = await sbt.get_member_count({
                dao_id: BigInt(publicDaoId),
              });
              memberCount = Number(countResult.result);
            } else {
              throw err;
            }
          }
        } else {
          const sbt = getReadOnlyMembershipSbt();
          const countResult = await sbt.get_member_count({
            dao_id: BigInt(publicDaoId),
          });
          memberCount = Number(countResult.result);
        }
      } catch (err) {
        console.error("Failed to get member count:", err);
      }

      const daoInfo = {
        id: publicDaoId,
        name: result.result.name,
        creator: result.result.admin,
        hasMembership,
        isRegistered,
        memberCount,
        vkVersion:
          vkResult?.result !== undefined ? Number(vkResult.result) : null,
      };
      setDao(daoInfo);
      // Cache the DAO info for instant loading next time
      localStorage.setItem(PUBLIC_DAO_CACHE_KEY, JSON.stringify(daoInfo));
    } catch (err) {
      console.error("Failed to load public DAO:", err);
      // Only show error if we don't have cached data to display
      if (!localStorage.getItem(PUBLIC_DAO_CACHE_KEY)) {
        setError(
          "Failed to load public DAO. Make sure DAO #1 exists and is public.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleJoinDAO = async () => {
    if (!publicKey || !kit || !dao) {
      setError("Wallet not connected");
      return;
    }

    try {
      setJoining(true);
      setError(null);

      const clients = initializeContractClients(publicKey);

      if (import.meta.env.DEV)
        console.log("[JoinDAO] Starting join for DAO:", dao.id);
      const joinTx = await clients.membershipSbt.self_join({
        dao_id: BigInt(dao.id),
        member: publicKey,
        encrypted_alias: undefined,
      });

      if (import.meta.env.DEV)
        console.log("[JoinDAO] Transaction prepared, waiting for signature...");
      const result = await joinTx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });
      if (import.meta.env.DEV)
        console.log("[JoinDAO] signAndSend completed:", result);

      // Notify relayer of member joined event
      const txHash = extractTxHash(result);
      if (import.meta.env.DEV)
        console.log("[JoinDAO] Transaction hash:", txHash);
      if (txHash) {
        notifyEvent(dao.id, "member_added", txHash, { member: publicKey });
      }

      // Verify membership was actually created on-chain BEFORE updating cache/UI
      // Add a small delay and retry to handle RPC propagation delay
      if (import.meta.env.DEV)
        console.log("[JoinDAO] Verifying membership on-chain...");
      let membershipConfirmed = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) {
          if (import.meta.env.DEV)
            console.log(
              `[JoinDAO] Retrying membership check (attempt ${attempt + 1}/6)...`,
            );
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
        }
        const membershipCheck = await clients.membershipSbt.has({
          dao_id: BigInt(dao.id),
          of: publicKey,
        });
        if (import.meta.env.DEV)
          console.log(
            `[JoinDAO] Membership check result (attempt ${attempt + 1}):`,
            membershipCheck.result,
          );
        if (membershipCheck.result) {
          membershipConfirmed = true;
          break;
        }
      }

      if (!membershipConfirmed) {
        throw new Error(
          "Join transaction may have failed. Please check your transaction history and try again.",
        );
      }

      // Clear cache and reload only after confirming membership
      if (import.meta.env.DEV)
        console.log("[JoinDAO] Membership confirmed, updating UI...");
      localStorage.removeItem(PUBLIC_DAO_CACHE_KEY);
      await loadPublicDAO();
      if (import.meta.env.DEV)
        console.log("[JoinDAO] Join completed successfully");
    } catch (err) {
      if (isUserRejection(err)) {
        if (import.meta.env.DEV)
          console.log("[JoinDAO] User cancelled joining DAO");
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        console.error("[JoinDAO] Failed to join DAO:", err);
      }
    } finally {
      setJoining(false);
    }
  };

  const handleRegisterToVote = async () => {
    if (!publicKey || !kit || !dao) {
      setError("Wallet not connected");
      return;
    }

    try {
      setRegistering(true);
      setError(null);

      let secret, salt, commitment;

      if (import.meta.env.DEV)
        console.log(
          "[Registration] Step 1: Generating deterministic credentials from wallet signature...",
        );
      try {
        const credentials = await generateDeterministicZKCredentials(
          kit,
          dao.id,
        );
        secret = credentials.secret;
        salt = credentials.salt;
        commitment = credentials.commitment;
      } catch (err) {
        console.error("[Registration] Step 1 failed:", err);
        throw err;
      }

      if (import.meta.env.DEV)
        console.log(
          "[Registration] Step 1 complete - Generated voting credentials",
        );
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (import.meta.env.DEV)
        console.log(
          "[Registration] Step 2: Registering commitment in Merkle tree...",
        );
      const clients = initializeContractClients(publicKey);

      // Helper to check if error is CommitmentExists (error #5 from tree contract)
      const isCommitmentExistsError = (err: unknown): boolean => {
        const errStr = (err as { message?: string })?.message || String(err);
        return errStr.includes("#5") || errStr.includes("Error(Contract, #5)");
      };

      // Helper to check if error is txBadSeq (stale sequence number)
      const isBadSeqError = (err: unknown): boolean => {
        const errStr = (err as { message?: string })?.message || String(err);
        return errStr.includes("txBadSeq") || errStr.includes("bad_seq");
      };

      // Helper to check if error is NoSbt (error #8 from tree contract)
      // This happens when user just joined but SBT transaction hasn't confirmed yet
      const isNoSbtError = (err: unknown): boolean => {
        const errStr = (err as { message?: string })?.message || String(err);
        return errStr.includes("#8") || errStr.includes("Error(Contract, #8)");
      };

      let alreadyRegistered = false;
      let registerTxHash: string | null = null;

      // Retry loop for txBadSeq and NoSbt errors
      // NoSbt needs more retries with longer delays (waiting for SBT confirmation)
      const maxRetries = 5;
      let noSbtRetryCount = 0;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            if (import.meta.env.DEV)
              console.log(
                `[Registration] Retrying transaction (attempt ${attempt + 1}/${maxRetries})...`,
              );
            // Longer delay for NoSbt errors (SBT confirmation can take time)
            const delay = noSbtRetryCount > 0 ? 3000 : 2000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          // Create fresh transaction for each attempt (gets latest sequence number)
          const registerTx = await clients.membershipTree.self_register({
            dao_id: BigInt(dao.id),
            commitment: BigInt(commitment),
            member: publicKey,
          });

          if (import.meta.env.DEV)
            console.log("[Registration] Calling signAndSend...");
          const result = await registerTx.signAndSend({
            signTransaction: kit.signTransaction.bind(kit),
          });
          if (import.meta.env.DEV)
            console.log(
              "[Registration] Step 2 complete - Transaction signed and sent:",
              result,
            );
          registerTxHash = extractTxHash(result);
          break; // Success, exit retry loop
        } catch (err: unknown) {
          // Check if this is a CommitmentExists error - means we're already registered
          if (isCommitmentExistsError(err)) {
            if (import.meta.env.DEV)
              console.log(
                "[Registration] Commitment already exists on-chain - recovering credentials",
              );
            alreadyRegistered = true;
            break; // Not an error, exit retry loop
          }

          // Check if this is a NoSbt error - SBT not confirmed yet, can be retried
          if (isNoSbtError(err) && attempt < maxRetries - 1) {
            noSbtRetryCount++;
            if (import.meta.env.DEV)
              console.log(
                `[Registration] SBT membership not confirmed yet (NoSbt error), waiting for blockchain confirmation... (attempt ${noSbtRetryCount})`,
              );
            continue; // Retry after delay
          }

          // Check if this is a txBadSeq error - can be retried
          if (isBadSeqError(err) && attempt < maxRetries - 1) {
            if (import.meta.env.DEV)
              console.log(
                "[Registration] Got txBadSeq error (stale sequence number), will retry...",
              );
            continue; // Retry with fresh transaction
          }

          // Other errors or final retry failed
          console.error("[Registration] Step 2 (signAndSend) failed:", err);

          // Provide a more helpful error message for NoSbt
          let errorMessage =
            (err as { message?: string })?.message || "Unknown error";
          if (isNoSbtError(err)) {
            errorMessage =
              "Membership not yet confirmed on blockchain. Please wait a few seconds and try again.";
          }

          const enhancedError = new Error(
            `Transaction signing failed: ${errorMessage}`,
          );
          (
            enhancedError as unknown as { originalError: unknown }
          ).originalError = err;
          throw enhancedError;
        }
      }

      // Retry get_leaf_index with delays to handle RPC propagation
      if (import.meta.env.DEV)
        console.log("[Registration] Verifying registration on-chain...");
      let leafIndex: number = NaN;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) {
          if (import.meta.env.DEV)
            console.log(
              `[Registration] Retrying get_leaf_index (attempt ${attempt + 1}/6)...`,
            );
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
        }

        try {
          const leafIndexResult = await clients.membershipTree.get_leaf_index({
            dao_id: BigInt(dao.id),
            commitment: BigInt(commitment),
          });

          if (import.meta.env.DEV)
            console.log(
              `[Registration] get_leaf_index result (attempt ${attempt + 1}):`,
              leafIndexResult.result,
            );

          // Check if result is an error object (Err variant from Rust Result)
          const rawResult = leafIndexResult.result;
          if (
            rawResult &&
            typeof rawResult === "object" &&
            "error" in rawResult
          ) {
            if (import.meta.env.DEV)
              console.log(`[Registration] Got error response, will retry...`);
            continue;
          }

          // The result could be a BigInt or number - handle both
          const parsedIndex =
            typeof rawResult === "bigint"
              ? Number(rawResult)
              : Number(rawResult);

          if (!isNaN(parsedIndex)) {
            leafIndex = parsedIndex;
            if (import.meta.env.DEV)
              console.log(`[Registration] Got valid leaf index: ${leafIndex}`);
            break;
          }
        } catch (queryErr) {
          if (import.meta.env.DEV)
            console.log(
              `[Registration] Query error on attempt ${attempt + 1}:`,
              queryErr,
            );
        }
      }

      if (isNaN(leafIndex)) {
        throw new Error(
          "Registration may have failed - could not verify commitment in tree after multiple attempts. Please try again.",
        );
      }

      storeZKCredentials(
        dao.id,
        publicKey,
        { secret, salt, commitment },
        leafIndex,
      );

      // Notify relayer of voter registered event (only if we actually registered, not recovered)
      if (registerTxHash && !alreadyRegistered) {
        notifyEvent(dao.id, "voter_registered", registerTxHash, {
          commitment,
          leafIndex,
        });
      }

      if (import.meta.env.DEV)
        console.log(
          alreadyRegistered
            ? "[Registration] Credentials recovered! Leaf index:"
            : "[Registration] Registration successful! Leaf index:",
          leafIndex,
        );

      // Immediately update local state to reflect registration (optimistic update)
      setDao((prev) => (prev ? { ...prev, isRegistered: true } : prev));

      // Also reload in background to ensure consistency
      await loadPublicDAO();
    } catch (err) {
      if (isUserRejection(err)) {
        if (import.meta.env.DEV) console.log("User cancelled registration");
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        console.error("Failed to register to vote:", err);
      }
    } finally {
      setRegistering(false);
    }
  };

  const handleCreateProposal = async (data: {
    title: string;
    contentCid: string;
    voteMode: "fixed" | "trailing";
    deadlineSeconds: number;
  }) => {
    if (!publicKey || !kit || !dao) {
      setError("Wallet not connected");
      return;
    }

    try {
      setCreatingProposal(true);
      setError(null);

      const clients = initializeContractClients(publicKey);

      let endTime: bigint;
      if (data.deadlineSeconds === 0) {
        endTime = BigInt(0);
      } else {
        endTime = BigInt(Math.floor(Date.now() / 1000) + data.deadlineSeconds);
      }

      const createProposalTx = await clients.voting.create_proposal({
        dao_id: BigInt(dao.id),
        title: data.title,
        content_cid: data.contentCid,
        end_time: endTime,
        creator: publicKey,
        vote_mode: {
          tag: data.voteMode === "fixed" ? "Fixed" : "Trailing",
          values: undefined,
        },
      });

      const result = await createProposalTx.signAndSend({
        signTransaction: kit.signTransaction.bind(kit),
      });

      // Notify relayer of proposal created event
      const txHash = extractTxHash(result);
      if (txHash) {
        notifyEvent(dao.id, "proposal_created", txHash, {
          title: data.title,
          contentCid: data.contentCid,
        });
      }

      navigate("/public-votes/");
      setProposalKey((prev) => prev + 1);
    } catch (err) {
      if (isUserRejection(err)) {
        if (import.meta.env.DEV)
          console.log("User cancelled proposal creation");
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        console.error("Failed to create proposal:", err);
      }
    } finally {
      setCreatingProposal(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error && !dao) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-xl font-semibold mb-4">Public Votes</h2>
        <Alert variant="error">{error}</Alert>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="space-y-1">
              <h2 className="text-3xl font-bold tracking-tight text-foreground">
                {dao?.name || "Public DAO"}
              </h2>
              <p className="text-sm text-muted-foreground">
                Open DAO • {dao?.memberCount || 0} member
                {dao?.memberCount !== 1 ? "s" : ""} • VK v
                {dao?.vkVersion ?? "?"} • Anyone can join and vote
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={activeTab === "proposals" ? "secondary" : "outline"}
              size="sm"
              onClick={() => navigate("/public-votes/")}
              className="gap-2"
            >
              <Home className="w-4 h-4" />
              Overview
            </Button>
            <Button
              variant={activeTab === "info" ? "secondary" : "outline"}
              size="sm"
              onClick={() => navigate("/public-votes/info")}
              className="gap-2"
            >
              <FileText className="w-4 h-4" /> Info
            </Button>
            <Button
              variant={activeTab === "members" ? "secondary" : "outline"}
              size="sm"
              onClick={() => navigate("/public-votes/members")}
              className="gap-2"
            >
              <Users className="w-4 h-4" />
              Members
            </Button>
            {isConnected && dao && dao.isRegistered && (
              <Button
                variant={
                  activeTab === "create-proposal" ? "secondary" : "outline"
                }
                onClick={() => navigate("/public-votes/create-proposal")}
                size="sm"
                className="gap-2"
              >
                <PlusCircle className="w-4 h-4" />
                Add Proposal
              </Button>
            )}

            {isConnected && dao && !dao.hasMembership && (
              <Button
                variant="outline"
                onClick={handleJoinDAO}
                disabled={joining}
                size="sm"
                className="gap-2"
              >
                {joining && <LoadingSpinner size="sm" color="white" />}
                {joining ? "Joining..." : "Join DAO"}
              </Button>
            )}
            {isConnected && dao && dao.hasMembership && !dao.isRegistered && (
              <Button
                variant="outline"
                onClick={handleRegisterToVote}
                disabled={registering}
                size="sm"
                className="gap-2"
              >
                {registering && <LoadingSpinner size="sm" color="white" />}
                {registering ? "Registering..." : "Register to Vote"}
              </Button>
            )}
          </div>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        {activeTab === "info" && dao && (
          <DAOInfoPanel daoId={dao.id} publicKey={publicKey} kit={kit} />
        )}

        {activeTab === "proposals" && (
          <>
            {!isConnected && (
              <div className="rounded-xl border bg-card p-6">
                <p className="text-muted-foreground">
                  Connect your wallet to join this public DAO and vote on
                  proposals.
                </p>
              </div>
            )}

            {dao && (
              <ProposalList
                key={proposalKey}
                publicKey={publicKey}
                daoId={dao.id}
                kit={kit}
                hasMembership={dao.hasMembership}
                vkSet={true}
                isInitializing={isInitializing}
              />
            )}
          </>
        )}

        {activeTab === "members" && dao && (
          <ManageMembers daoId={dao.id} publicKey={publicKey} isAdmin={false} />
        )}

        {activeTab === "create-proposal" && dao && (
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
                  navigate("/public-votes/");
                  setError(null);
                }}
                isSubmitting={creatingProposal}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
