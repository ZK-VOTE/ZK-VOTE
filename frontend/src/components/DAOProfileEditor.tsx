import { useState, useRef, useEffect } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import { extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";
import {
  type DAOMetadata,
  uploadDAOMetadata,
  uploadImage,
  fetchDAOMetadata,
  getImageUrl,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  normalizeTwitterHandle,
  getTwitterUrl,
} from "../lib/daoMetadata";
import { Button } from "./ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import { Input } from "./ui/Input";
import { Label } from "./ui/Label";
import { Textarea } from "./ui/Textarea";
import {
  Image,
  Upload,
  Globe,
  Loader2,
  X,
  Check,
  AlertCircle,
} from "lucide-react";

// Custom Twitter/X icon
const TwitterIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// Custom LinkedIn icon
const LinkedInIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

// Custom GitHub icon
const GitHubIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

interface DAOProfileEditorProps {
  daoId: number;
  daoName: string;
  publicKey: string;
  kit: StellarWalletsKit;
  metadataCid: string | null;
  onSaved: () => void;
}

export default function DAOProfileEditor({
  daoId,
  daoName,
  publicKey,
  kit,
  metadataCid,
  onSaved,
}: DAOProfileEditorProps) {
  // Form state
  const [name, setName] = useState(daoName);
  const [description, setDescription] = useState("");
  const [coverImageCid, setCoverImageCid] = useState<string | null>(null);
  const [profileImageCid, setProfileImageCid] = useState<string | null>(null);
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [github, setGithub] = useState("");

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [isUploadingProfile, setIsUploadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Track original values for change detection
  const [_originalName, _setOriginalName] = useState(daoName);
  const [originalProfile, setOriginalProfile] = useState<{
    description: string;
    coverImageCid: string | null;
    profileImageCid: string | null;
    website: string;
    twitter: string;
    linkedin: string;
    github: string;
  } | null>(null);

  // File input refs
  const coverInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);

  // Load existing metadata
  useEffect(() => {
    async function loadMetadata() {
      if (metadataCid) {
        try {
          const metadata = await fetchDAOMetadata(metadataCid);
          if (metadata) {
            const loadedProfile = {
              description: metadata.description || "",
              coverImageCid: metadata.coverImageCid || null,
              profileImageCid: metadata.profileImageCid || null,
              website: metadata.links?.website || "",
              twitter: metadata.links?.twitter || "",
              linkedin: metadata.links?.linkedin || "",
              github: metadata.links?.github || "",
            };
            setDescription(loadedProfile.description);
            setCoverImageCid(loadedProfile.coverImageCid);
            setProfileImageCid(loadedProfile.profileImageCid);
            setWebsite(loadedProfile.website);
            setTwitter(loadedProfile.twitter);
            setLinkedin(loadedProfile.linkedin);
            setGithub(loadedProfile.github);
            // Store original for change tracking
            setOriginalProfile(loadedProfile);
          }
        } catch (err) {
          console.error("Failed to load metadata:", err);
        }
      } else {
        // No existing metadata - store empty original
        setOriginalProfile({
          description: "",
          coverImageCid: null,
          profileImageCid: null,
          website: "",
          twitter: "",
          linkedin: "",
          github: "",
        });
      }
      setIsLoading(false);
    }
    loadMetadata();
  }, [metadataCid]);

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingCover(true);
    setError(null);
    try {
      const { cid } = await uploadImage(file);
      setCoverImageCid(cid);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to upload cover image",
      );
    } finally {
      setIsUploadingCover(false);
    }
  };

  const handleProfileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingProfile(true);
    setError(null);
    try {
      const { cid } = await uploadImage(file);
      setProfileImageCid(cid);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to upload profile image",
      );
    } finally {
      setIsUploadingProfile(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const clients = initializeContractClients(publicKey);

      // Check what changed
      const nameChanged = name.trim() !== daoName;
      const metadataContentChanged =
        description.trim() !== (originalProfile?.description || "") ||
        coverImageCid !== originalProfile?.coverImageCid ||
        profileImageCid !== originalProfile?.profileImageCid ||
        website.trim() !== (originalProfile?.website || "") ||
        (twitter.trim() ? normalizeTwitterHandle(twitter.trim()) : "") !==
          (originalProfile?.twitter || "") ||
        linkedin.trim() !== (originalProfile?.linkedin || "") ||
        github.trim() !== (originalProfile?.github || "");

      // If nothing changed, show success and return
      if (!nameChanged && !metadataContentChanged) {
        setSuccess(true);
        setTimeout(() => {
          onSaved();
        }, 1500);
        return;
      }

      let newMetadataCid: string | null = metadataCid;
      // Transaction result - use unknown since SDK types may vary, we extract hash via helper
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;

      // Only upload metadata if content actually changed
      if (metadataContentChanged) {
        // Build metadata object
        const metadata: Omit<DAOMetadata, "version" | "updatedAt"> = {
          description: description.trim(),
          coverImageCid: coverImageCid || undefined,
          profileImageCid: profileImageCid || undefined,
          links: {
            website: website.trim() || undefined,
            twitter: twitter.trim()
              ? normalizeTwitterHandle(twitter.trim())
              : undefined,
            linkedin: linkedin.trim() || undefined,
            github: github.trim() || undefined,
          },
        };

        // Remove empty links object if all fields are empty
        if (
          !metadata.links?.website &&
          !metadata.links?.twitter &&
          !metadata.links?.linkedin &&
          !metadata.links?.github
        ) {
          delete metadata.links;
        }

        // Upload metadata to IPFS
        const uploadResult = await uploadDAOMetadata(metadata);
        newMetadataCid = uploadResult.cid;
      }

      // Update name on-chain if changed
      if (nameChanged) {
        const nameTx = await clients.daoRegistry.set_name({
          dao_id: BigInt(daoId),
          name: name.trim(),
          admin: publicKey,
        });

        result = await nameTx.signAndSend({
          signTransaction: kit.signTransaction.bind(kit),
        });
      }

      // Update metadata CID on-chain if changed
      if (metadataContentChanged && newMetadataCid) {
        const metadataTx = await clients.daoRegistry.set_metadata_cid({
          dao_id: BigInt(daoId),
          metadata_cid: newMetadataCid,
          admin: publicKey,
        });

        result = await metadataTx.signAndSend({
          signTransaction: kit.signTransaction.bind(kit),
        });
      }

      // Notify relayer of profile updated event with old and new values
      const txHash = extractTxHash(result);
      if (txHash) {
        const newProfile = {
          name: name.trim(),
          description: description.trim(),
          coverImageCid: coverImageCid || null,
          profileImageCid: profileImageCid || null,
          website: website.trim() || null,
          twitter: twitter.trim()
            ? normalizeTwitterHandle(twitter.trim())
            : null,
          linkedin: linkedin.trim() || null,
          github: github.trim() || null,
        };

        const oldProfile = {
          name: daoName,
          description: originalProfile?.description || "",
          coverImageCid: originalProfile?.coverImageCid || null,
          profileImageCid: originalProfile?.profileImageCid || null,
          website: originalProfile?.website || null,
          twitter: originalProfile?.twitter || null,
          linkedin: originalProfile?.linkedin || null,
          github: originalProfile?.github || null,
        };

        // Calculate what changed
        const changes: Record<
          string,
          { old: string | null; new: string | null }
        > = {};
        if (oldProfile.name !== newProfile.name) {
          changes.name = { old: oldProfile.name, new: newProfile.name };
        }
        if (oldProfile.description !== newProfile.description) {
          changes.description = {
            old: oldProfile.description || null,
            new: newProfile.description || null,
          };
        }
        if (oldProfile.coverImageCid !== newProfile.coverImageCid) {
          changes.coverImageCid = {
            old: oldProfile.coverImageCid,
            new: newProfile.coverImageCid,
          };
        }
        if (oldProfile.profileImageCid !== newProfile.profileImageCid) {
          changes.profileImageCid = {
            old: oldProfile.profileImageCid,
            new: newProfile.profileImageCid,
          };
        }
        if (oldProfile.website !== newProfile.website) {
          changes.website = {
            old: oldProfile.website,
            new: newProfile.website,
          };
        }
        if (oldProfile.twitter !== newProfile.twitter) {
          changes.twitter = {
            old: oldProfile.twitter,
            new: newProfile.twitter,
          };
        }
        if (oldProfile.linkedin !== newProfile.linkedin) {
          changes.linkedin = {
            old: oldProfile.linkedin,
            new: newProfile.linkedin,
          };
        }
        if (oldProfile.github !== newProfile.github) {
          changes.github = { old: oldProfile.github, new: newProfile.github };
        }

        notifyEvent(daoId, "profile_updated", txHash, {
          metadataCid: newMetadataCid,
          oldMetadataCid: metadataCid,
          changes,
        });
      }

      setSuccess(true);
      setTimeout(() => {
        onSaved();
      }, 1500);
    } catch (err) {
      console.error("Failed to save profile:", err);
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Cover & Profile Images */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Image className="w-5 h-5" />
            Images
          </CardTitle>
          <CardDescription>
            Upload a cover photo and profile image for your DAO.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Cover Image */}
          <div className="space-y-2">
            <Label>Cover Photo</Label>
            <div
              className="relative h-32 rounded-lg border-2 border-dashed border-muted-foreground/25 hover:border-muted-foreground/50 transition-colors cursor-pointer overflow-hidden"
              onClick={() => coverInputRef.current?.click()}
            >
              {coverImageCid ? (
                <img
                  src={getImageUrl(coverImageCid)}
                  alt="Cover"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  {isUploadingCover ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <>
                      <Upload className="w-6 h-6 mb-2" />
                      <span className="text-sm">
                        Click to upload cover photo
                      </span>
                    </>
                  )}
                </div>
              )}
              {coverImageCid && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCoverImageCid(null);
                  }}
                  className="absolute top-2 right-2 p-1 bg-background/80 rounded-full hover:bg-background"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              onChange={handleCoverUpload}
              className="hidden"
            />
          </div>

          {/* Profile Image */}
          <div className="space-y-2">
            <Label>Profile Image</Label>
            <div className="flex items-center gap-4">
              <div
                className="relative w-24 h-24 rounded-full border-2 border-dashed border-muted-foreground/25 hover:border-muted-foreground/50 transition-colors cursor-pointer overflow-hidden"
                onClick={() => profileInputRef.current?.click()}
              >
                {profileImageCid ? (
                  <img
                    src={getImageUrl(profileImageCid)}
                    alt="Profile"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                    {isUploadingProfile ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Upload className="w-5 h-5" />
                    )}
                  </div>
                )}
                {profileImageCid && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setProfileImageCid(null);
                    }}
                    className="absolute -top-1 -right-1 p-0.5 bg-background rounded-full border"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Recommended: Square image, at least 200x200px
              </p>
            </div>
            <input
              ref={profileInputRef}
              type="file"
              accept="image/*"
              onChange={handleProfileUpload}
              className="hidden"
            />
          </div>
        </CardContent>
      </Card>

      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>Basic Info</CardTitle>
          <CardDescription>
            Set your DAO's name and description.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">DAO Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="My DAO"
            />
            <p className="text-xs text-muted-foreground text-right">
              {name.length}/{MAX_NAME_LENGTH}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              placeholder="Describe your DAO's purpose and goals... (Markdown supported)"
              rows={5}
            />
            <p className="text-xs text-muted-foreground text-right">
              {description.length}/{MAX_DESCRIPTION_LENGTH}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Social Links */}
      <Card>
        <CardHeader>
          <CardTitle>Social Links</CardTitle>
          <CardDescription>
            Add links to your DAO's online presence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="website" className="flex items-center gap-2">
              <Globe className="w-4 h-4" />
              Website
            </Label>
            <Input
              id="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
              type="url"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="twitter" className="flex items-center gap-2">
              <TwitterIcon className="w-4 h-4" />X (Twitter)
            </Label>
            <Input
              id="twitter"
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              placeholder="@handle or https://x.com/handle"
            />
            {twitter && (
              <a
                href={getTwitterUrl(twitter)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                {getTwitterUrl(normalizeTwitterHandle(twitter))}
              </a>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="linkedin" className="flex items-center gap-2">
              <LinkedInIcon className="w-4 h-4" />
              LinkedIn
            </Label>
            <Input
              id="linkedin"
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="https://linkedin.com/company/..."
              type="url"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="github" className="flex items-center gap-2">
              <GitHubIcon className="w-4 h-4" />
              GitHub
            </Label>
            <Input
              id="github"
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder="https://github.com/org-name"
              type="url"
            />
          </div>
        </CardContent>
      </Card>

      {/* Status Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-600 dark:text-green-400 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          Profile saved successfully!
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={
            isSaving || isUploadingCover || isUploadingProfile || !name.trim()
          }
          size="lg"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Profile"
          )}
        </Button>
      </div>
    </div>
  );
}
