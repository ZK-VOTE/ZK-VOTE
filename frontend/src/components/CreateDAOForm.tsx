import { useState } from "react";
import { Buffer } from "buffer";
import { useNavigate } from "react-router-dom";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { Alert, LoadingSpinner } from "./ui";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Textarea } from "./ui/Textarea";
import { Label } from "./ui/Label";
import {
  uploadDAOMetadata,
  uploadImage,
  MAX_DESCRIPTION_LENGTH,
} from "../lib/daoMetadata";
import {
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Link2,
  Globe,
  Twitter,
  Linkedin,
  Github,
  X,
} from "lucide-react";
import { initializeContractClients } from "../lib/contracts";
import { toIdSlug } from "../lib/utils";
import verificationKey from "../lib/verification_key_soroban.json";
import { CONTRACTS } from "../config/contracts";

interface CreateDAOFormProps {
  publicKey: string;
  kit: StellarWalletsKit;
  isInitializing: boolean;
  onCancel: () => void;
  onSuccess: (daoId: number, daoName: string) => void;
}

export function CreateDAOForm({
  publicKey,
  kit,
  isInitializing,
  onCancel,
  onSuccess,
}: CreateDAOFormProps) {
  const navigate = useNavigate();
  const [newDaoName, setNewDaoName] = useState("");
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [membersCanPropose, setMembersCanPropose] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Profile fields
  const [showProfileOptions, setShowProfileOptions] = useState(false);
  const [description, setDescription] = useState("");
  const [coverImageFile, setCoverImageFile] = useState<File | null>(null);
  const [coverImagePreview, setCoverImagePreview] = useState<string | null>(
    null,
  );
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);
  const [profileImagePreview, setProfileImagePreview] = useState<string | null>(
    null,
  );
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [github, setGithub] = useState("");

  const handleCoverImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCoverImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setCoverImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleProfileImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setProfileImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfileImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const resetProfileFields = () => {
    setShowProfileOptions(false);
    setDescription("");
    setCoverImageFile(null);
    setCoverImagePreview(null);
    setProfileImageFile(null);
    setProfileImagePreview(null);
    setWebsite("");
    setTwitter("");
    setLinkedin("");
    setGithub("");
  };

  const handleCreateDao = async () => {
    if (!newDaoName.trim()) {
      setError("DAO name is required");
      return;
    }

    try {
      setCreating(true);
      setError(null);
      setSuccess(null);

      const clients = initializeContractClients(publicKey);

      // Helper function to retry transactions on TRY_AGAIN_LATER errors
      const sendWithRetry = async (
        tx: {
          signAndSend: (opts: {
            signTransaction: typeof kit.signTransaction;
          }) => Promise<{ result: unknown }>;
        },
        maxRetries = 3,
      ) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await tx.signAndSend({
              signTransaction: kit.signTransaction.bind(kit),
            });
          } catch (err: unknown) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            const isTryAgainLater = errorMessage.includes("TRY_AGAIN_LATER");

            if (isTryAgainLater && attempt < maxRetries) {
              if (import.meta.env.DEV)
                console.log(
                  `Transaction failed with TRY_AGAIN_LATER, retrying (attempt ${attempt}/${maxRetries})...`,
                );
              await new Promise((resolve) => setTimeout(resolve, 2000));
              continue;
            }
            throw err;
          }
        }
      };

      // Convert hex strings to Buffers for VK
      const vk = {
        alpha: Buffer.from(verificationKey.alpha, "hex"),
        beta: Buffer.from(verificationKey.beta, "hex"),
        gamma: Buffer.from(verificationKey.gamma, "hex"),
        delta: Buffer.from(verificationKey.delta, "hex"),
        ic: verificationKey.ic.map((ic: string) => Buffer.from(ic, "hex")),
      };

      // Upload profile metadata BEFORE creating DAO
      const hasProfileData =
        description ||
        coverImageFile ||
        profileImageFile ||
        website ||
        twitter ||
        linkedin ||
        github;
      let metadataCid: string | undefined;

      if (hasProfileData) {
        try {
          setSuccess("Uploading DAO profile to IPFS...");

          let coverImageCid: string | undefined;
          let profileImageCid: string | undefined;

          if (coverImageFile) {
            const coverResult = await uploadImage(coverImageFile);
            coverImageCid = coverResult.cid;
          }

          if (profileImageFile) {
            const profileResult = await uploadImage(profileImageFile);
            profileImageCid = profileResult.cid;
          }

          const metadataToUpload: {
            description: string;
            coverImageCid?: string;
            profileImageCid?: string;
            links?: {
              website?: string;
              twitter?: string;
              linkedin?: string;
              github?: string;
            };
          } = {
            description: description || "",
            coverImageCid,
            profileImageCid,
          };

          if (website || twitter || linkedin || github) {
            metadataToUpload.links = {};
            if (website) metadataToUpload.links.website = website;
            if (twitter) metadataToUpload.links.twitter = twitter;
            if (linkedin) metadataToUpload.links.linkedin = linkedin;
            if (github) metadataToUpload.links.github = github;
          }

          const uploadResult = await uploadDAOMetadata(metadataToUpload);
          metadataCid = uploadResult.cid;
          if (import.meta.env.DEV)
            console.log("Metadata uploaded to IPFS:", metadataCid);
        } catch (metadataErr) {
          console.error("Failed to upload profile metadata:", metadataErr);
          setError(
            "Failed to upload profile. Continuing without profile metadata...",
          );
          setTimeout(() => setError(null), 3000);
        }
      }

      if (import.meta.env.DEV) console.log("Creating and initializing DAO...");
      setSuccess(
        "Creating DAO (initializing tree and setting verification key)...",
      );

      const createAndInitTx =
        await clients.daoRegistry.create_and_init_dao_no_reg(
          {
            name: newDaoName,
            creator: publicKey,
            membership_open: membershipOpen,
            members_can_propose: membersCanPropose,
            metadata_cid: metadataCid || undefined,
            sbt_contract: CONTRACTS.SBT_ID,
            tree_contract: CONTRACTS.TREE_ID,
            voting_contract: CONTRACTS.VOTING_ID,
            tree_depth: 18,
            vk,
          },
          {
            fee: "10000000", // 10 XLM max fee
          },
        );

      const result = await sendWithRetry(createAndInitTx);

      const newDaoId = Number(result?.result);
      if (import.meta.env.DEV)
        console.log(
          `DAO created and fully initialized with ID: ${newDaoId}${metadataCid ? ` with metadata CID: ${metadataCid}` : ""}`,
        );

      setSuccess(`DAO "${newDaoName}" created successfully! Redirecting...`);

      if (import.meta.env.DEV)
        console.log(`DAO "${newDaoName}" (ID: ${newDaoId}) fully initialized!`);
      const createdDaoName = newDaoName;
      setNewDaoName("");
      resetProfileFields();

      onSuccess(newDaoId, createdDaoName);
      navigate(`/daos/${toIdSlug(newDaoId, createdDaoName)}`);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create DAO";
      setError(errorMessage);
      console.error("Failed to create DAO:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = () => {
    setNewDaoName("");
    setMembershipOpen(false);
    setMembersCanPropose(true);
    resetProfileFields();
    setError(null);
    onCancel();
  };

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-6 animate-slide-in-from-top">
      {/* Success/Error Messages */}
      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold leading-none tracking-tight mb-4">
            Create New DAO
          </h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="dao-name-input"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                DAO Name
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  ({newDaoName.length}/24 characters)
                </span>
              </label>
              <input
                id="dao-name-input"
                type="text"
                value={newDaoName}
                onChange={(e) => setNewDaoName(e.target.value)}
                placeholder="Enter DAO name..."
                maxLength={24}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="membership-open"
                checked={membershipOpen}
                onChange={(e) => setMembershipOpen(e.target.checked)}
                className="h-4 w-4 rounded border-gray-400 text-primary focus:ring-1 focus:ring-primary/50 focus:ring-offset-0"
              />
              <label
                htmlFor="membership-open"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Open Membership
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  (Allow users to join without admin approval)
                </span>
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="members-can-propose"
                checked={membersCanPropose}
                onChange={(e) => setMembersCanPropose(e.target.checked)}
                className="h-4 w-4 rounded border-gray-400 text-primary focus:ring-1 focus:ring-primary/50 focus:ring-offset-0"
              />
              <label
                htmlFor="members-can-propose"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Member Proposals
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  (Allow members to create proposals, or admin-only)
                </span>
              </label>
            </div>

            {/* Profile Options Toggle */}
            <button
              type="button"
              onClick={() => setShowProfileOptions(!showProfileOptions)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mt-2"
            >
              {showProfileOptions ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
              <ImageIcon className="w-4 h-4" />
              Add Profile (optional)
            </button>

            {/* Profile Options */}
            {showProfileOptions && (
              <div className="space-y-4 pt-4 border-t mt-4">
                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="dao-description">
                    Description
                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                      ({description.length}/{MAX_DESCRIPTION_LENGTH} characters,
                      Markdown supported)
                    </span>
                  </Label>
                  <Textarea
                    id="dao-description"
                    value={description}
                    onChange={(e) =>
                      setDescription(
                        e.target.value.slice(0, MAX_DESCRIPTION_LENGTH),
                      )
                    }
                    placeholder="Describe your DAO..."
                    rows={3}
                  />
                </div>

                {/* Images */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Cover Image */}
                  <div className="space-y-2">
                    <Label htmlFor="cover-image">Cover Image</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="cover-image"
                        type="file"
                        accept="image/*"
                        onChange={handleCoverImageChange}
                        className="flex-1"
                      />
                      {coverImagePreview && (
                        <button
                          type="button"
                          onClick={() => {
                            setCoverImageFile(null);
                            setCoverImagePreview(null);
                          }}
                          className="p-1 hover:bg-muted rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {coverImagePreview && (
                      <div className="relative h-24 rounded-lg overflow-hidden bg-muted">
                        <img
                          src={coverImagePreview}
                          alt="Cover preview"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                  </div>

                  {/* Profile Image */}
                  <div className="space-y-2">
                    <Label htmlFor="profile-image">Profile Image</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="profile-image"
                        type="file"
                        accept="image/*"
                        onChange={handleProfileImageChange}
                        className="flex-1"
                      />
                      {profileImagePreview && (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileImageFile(null);
                            setProfileImagePreview(null);
                          }}
                          className="p-1 hover:bg-muted rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {profileImagePreview && (
                      <div className="w-16 h-16 rounded-full overflow-hidden bg-muted">
                        <img
                          src={profileImagePreview}
                          alt="Profile preview"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Social Links */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-1">
                    <Link2 className="w-4 h-4" />
                    Social Links
                  </Label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
                      <Input
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        placeholder="https://example.com"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Twitter className="w-4 h-4 text-muted-foreground shrink-0" />
                      <Input
                        value={twitter}
                        onChange={(e) => setTwitter(e.target.value)}
                        placeholder="@handle or x.com/handle"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Linkedin className="w-4 h-4 text-muted-foreground shrink-0" />
                      <Input
                        value={linkedin}
                        onChange={(e) => setLinkedin(e.target.value)}
                        placeholder="linkedin.com/company/..."
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Github className="w-4 h-4 text-muted-foreground shrink-0" />
                      <Input
                        value={github}
                        onChange={(e) => setGithub(e.target.value)}
                        placeholder="github.com/org"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleCreateDao}
            disabled={creating || isInitializing}
            className="flex-1"
          >
            {creating && (
              <LoadingSpinner size="sm" color="white" className="mr-2" />
            )}
            {creating ? "Creating..." : "Create DAO"}
          </Button>
          <Button variant="outline" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
