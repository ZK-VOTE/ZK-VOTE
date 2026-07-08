import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type DAOMetadata,
  getImageUrl,
  getTwitterUrl,
} from "../lib/daoMetadata";
import { Badge, LoadingSpinner } from "./ui";
import { Button } from "./ui/Button";
import { Card, CardContent } from "./ui/Card";
import {
  Shield,
  Users,
  Lock,
  Unlock,
  FileText,
  CheckCircle,
  PlusCircle,
  Home,
  Settings,
  Globe,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// Custom social icons
const TwitterIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const LinkedInIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

const GitHubIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

export type DAOTab =
  | "info"
  | "proposals"
  | "members"
  | "create-proposal"
  | "settings";

export interface DAOInfo {
  id: number;
  name: string;
  creator: string;
  hasMembership: boolean;
  isAdmin: boolean;
  treeInitialized: boolean;
  vkSet: boolean;
  membershipOpen: boolean;
  membersCanPropose: boolean;
  metadataCid: string | null;
}

interface SocialLinksProps {
  links: DAOMetadata["links"];
  variant: "cover" | "standalone";
}

function SocialLinks({ links, variant }: SocialLinksProps) {
  if (!links || !Object.values(links).some(Boolean)) return null;

  const isCover = variant === "cover";
  const containerClass = isCover
    ? "absolute top-3 right-3 flex items-center gap-1"
    : "flex items-center gap-2 mb-4";
  const linkClass = isCover
    ? "p-2 rounded-lg bg-background/80 hover:bg-background transition-colors text-muted-foreground hover:text-foreground"
    : "p-2 rounded-lg bg-muted/30 dark:bg-muted/50 hover:bg-muted transition-colors text-foreground/70 hover:text-foreground";
  const iconSize = isCover ? "w-4 h-4" : "w-5 h-5";

  return (
    <div className={containerClass}>
      {links.website && (
        <a
          href={links.website}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          title="Website"
        >
          <Globe className={iconSize} />
        </a>
      )}
      {links.twitter && (
        <a
          href={getTwitterUrl(links.twitter)}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          title="X (Twitter)"
        >
          <TwitterIcon className={iconSize} />
        </a>
      )}
      {links.linkedin && (
        <a
          href={links.linkedin}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          title="LinkedIn"
        >
          <LinkedInIcon className={iconSize} />
        </a>
      )}
      {links.github && (
        <a
          href={links.github}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          title="GitHub"
        >
          <GitHubIcon className={iconSize} />
        </a>
      )}
    </div>
  );
}

interface RegistrationButtonProps {
  isRegistered: boolean;
  hasMembership: boolean;
  hasUnregisteredCredentials: boolean;
  isRegistering: boolean;
  registrationStatus: string | null;
  publicKey: string | null;
  onRegister: () => void;
  variant: "button" | "menu-item";
}

function RegistrationButton({
  isRegistered,
  hasMembership,
  hasUnregisteredCredentials,
  isRegistering,
  registrationStatus,
  publicKey,
  onRegister,
  variant,
}: RegistrationButtonProps) {
  const shouldShow = hasMembership && !isRegistered && publicKey;
  if (!shouldShow) return null;

  const buttonText = hasUnregisteredCredentials
    ? "Complete Registration"
    : "Register to Vote";

  if (variant === "menu-item") {
    return (
      <>
        <div className="border-t my-2" />
        <button
          onClick={onRegister}
          disabled={isRegistering}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors"
        >
          {isRegistering ? (
            <>
              <LoadingSpinner size="sm" color="white" />
              {registrationStatus || "Registering..."}
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4" />
              {buttonText}
            </>
          )}
        </button>
      </>
    );
  }

  return (
    <Button
      variant="outline"
      onClick={onRegister}
      disabled={isRegistering}
      size="sm"
      className="gap-2"
    >
      {isRegistering ? (
        <>
          <LoadingSpinner size="sm" color="white" />
          {registrationStatus || "Registering..."}
        </>
      ) : (
        <>
          <CheckCircle className="w-4 h-4" />
          {buttonText}
        </>
      )}
    </Button>
  );
}

interface JoinButtonProps {
  hasMembership: boolean;
  membershipOpen: boolean;
  publicKey: string | null;
  joining: boolean;
  onJoin: () => void;
  variant: "button" | "menu-item";
}

function JoinButton({
  hasMembership,
  membershipOpen,
  publicKey,
  joining,
  onJoin,
  variant,
}: JoinButtonProps) {
  const shouldShow = !hasMembership && membershipOpen && publicKey;
  if (!shouldShow) return null;

  if (variant === "menu-item") {
    return (
      <>
        <div className="border-t my-2" />
        <button
          onClick={onJoin}
          disabled={joining}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors"
        >
          {joining ? (
            <LoadingSpinner size="sm" color="white" />
          ) : (
            <Users className="w-4 h-4" />
          )}
          {joining ? "Joining..." : "Join DAO"}
        </button>
      </>
    );
  }

  return (
    <Button
      variant="outline"
      onClick={onJoin}
      disabled={joining}
      size="sm"
      className="gap-2"
    >
      {joining && <LoadingSpinner size="sm" color="white" />}
      {joining ? "Joining..." : "Join DAO"}
    </Button>
  );
}

interface NavButtonsProps {
  dao: DAOInfo;
  activeTab: DAOTab;
  publicKey: string | null;
  hasKit: boolean;
  navigateToTab: (tab: DAOTab) => void;
}

function NavButtons({
  dao,
  activeTab,
  publicKey,
  hasKit,
  navigateToTab,
}: NavButtonsProps) {
  return (
    <>
      <Button
        variant={activeTab === "proposals" ? "secondary" : "outline"}
        size="sm"
        onClick={() => navigateToTab("proposals")}
        className="gap-2"
      >
        <Home className="w-4 h-4" />
        Overview
      </Button>
      <Button
        variant={activeTab === "info" ? "secondary" : "outline"}
        size="sm"
        onClick={() => navigateToTab("info")}
        className="gap-2"
      >
        <FileText className="w-4 h-4" /> Info
      </Button>
      <Button
        variant={activeTab === "members" ? "secondary" : "outline"}
        size="sm"
        onClick={() => navigateToTab("members")}
        className="gap-2"
      >
        <Users className="w-4 h-4" />
        Members
      </Button>
      {dao.isAdmin && publicKey && hasKit && (
        <Button
          variant={activeTab === "settings" ? "secondary" : "outline"}
          size="sm"
          onClick={() => navigateToTab("settings")}
          className="gap-2"
        >
          <Settings className="w-4 h-4" />
          Settings
        </Button>
      )}
      {(dao.isAdmin || (dao.hasMembership && dao.membersCanPropose)) &&
        dao.vkSet && (
          <Button
            variant={activeTab === "create-proposal" ? "secondary" : "outline"}
            onClick={() => navigateToTab("create-proposal")}
            size="sm"
            className="gap-2"
          >
            <PlusCircle className="w-4 h-4" />
            Add Proposal
          </Button>
        )}
    </>
  );
}

export interface DAOHeaderProps {
  dao: DAOInfo;
  metadata: DAOMetadata | null;
  activeTab: DAOTab;
  publicKey: string | null;
  hasKit: boolean;
  // Membership actions
  joining: boolean;
  onJoin: () => void;
  // Registration actions
  isRegistered: boolean;
  hasUnregisteredCredentials: boolean;
  isRegistering: boolean;
  registrationStatus: string | null;
  onRegister: () => void;
  // Navigation
  navigateToTab: (tab: DAOTab) => void;
}

export default function DAOHeader({
  dao,
  metadata,
  activeTab,
  publicKey,
  hasKit,
  joining,
  onJoin,
  isRegistered,
  hasUnregisteredCredentials,
  isRegistering,
  registrationStatus,
  onRegister,
  navigateToTab,
}: DAOHeaderProps) {
  const [showDescription, setShowDescription] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <Card>
      <CardContent className="pt-6">
        {/* Cover Image with Profile Photo and Social Links overlay */}
        {metadata?.coverImageCid && (
          <div className="relative -mx-6 -mt-6 mb-4">
            {/* Cover container with overflow hidden */}
            <div className="relative h-[200px] rounded-t-lg overflow-hidden bg-muted">
              <img
                src={getImageUrl(metadata.coverImageCid)}
                alt="DAO Cover"
                className="w-full h-full object-cover"
              />
            </div>
            {/* Profile Image - positioned outside the overflow-hidden container */}
            {metadata?.profileImageCid && (
              <div className="absolute -bottom-12 left-4">
                <div className="w-24 h-24 md:w-28 md:h-28 rounded-xl border-4 border-background overflow-hidden bg-muted shadow-lg">
                  <img
                    src={getImageUrl(metadata.profileImageCid)}
                    alt="DAO Profile"
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>
            )}
            {/* Social Links - top right of cover */}
            <SocialLinks links={metadata?.links} variant="cover" />
          </div>
        )}

        {/* Profile Image - shown standalone when no cover image */}
        {metadata?.profileImageCid && !metadata?.coverImageCid && (
          <div className="mb-4">
            <div className="w-24 h-24 md:w-28 md:h-28 rounded-xl border-4 border-background overflow-hidden bg-muted shadow-lg">
              <img
                src={getImageUrl(metadata.profileImageCid)}
                alt="DAO Profile"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        )}

        {/* Header Info with Navigation - flex row layout on 2xl+ */}
        <div
          className={`flex flex-col 2xl:flex-row 2xl:items-start 2xl:justify-between gap-4 mb-4 ${metadata?.coverImageCid && metadata?.profileImageCid ? "mt-14" : ""}`}
        >
          {/* Left: DAO name, badges, and ID */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                {dao.name}
              </h2>
              {dao.isAdmin ? (
                <Badge variant="blue" className="gap-1">
                  <Shield className="w-3 h-3" /> Admin
                </Badge>
              ) : dao.hasMembership ? (
                <Badge variant="success" className="gap-1">
                  <Users className="w-3 h-3" /> Member
                </Badge>
              ) : (
                <Badge variant="gray" className="gap-1">
                  <Users className="w-3 h-3" /> Non-member
                </Badge>
              )}
              {dao.membershipOpen ? (
                <Badge variant="success" className="gap-1">
                  <Unlock className="w-3 h-3" /> Open
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <Lock className="w-3 h-3" /> Closed
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <span className="font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded">
                ID: {dao.id}
              </span>
              <span>•</span>
              <span>
                Created by {dao.creator?.slice(0, 4) ?? "..."}...
                {dao.creator?.slice(-4) ?? "..."}
              </span>
            </p>
          </div>

          {/* Right: Navigation Menu (2xl+ only - floated right of header) */}
          <div className="shrink-0 hidden 2xl:block">
            <div className="flex flex-wrap items-center gap-2">
              <NavButtons
                dao={dao}
                activeTab={activeTab}
                publicKey={publicKey}
                hasKit={hasKit}
                navigateToTab={navigateToTab}
              />
              <JoinButton
                hasMembership={dao.hasMembership}
                membershipOpen={dao.membershipOpen}
                publicKey={publicKey}
                joining={joining}
                onJoin={onJoin}
                variant="button"
              />
              <RegistrationButton
                isRegistered={isRegistered}
                hasMembership={dao.hasMembership}
                hasUnregisteredCredentials={hasUnregisteredCredentials}
                isRegistering={isRegistering}
                registrationStatus={registrationStatus}
                publicKey={publicKey}
                onRegister={onRegister}
                variant="button"
              />
            </div>
          </div>
        </div>

        {/* Social Links - shown below header when no cover image */}
        {!metadata?.coverImageCid && (
          <SocialLinks links={metadata?.links} variant="standalone" />
        )}

        {/* Mobile Navigation Menu - dropdown for < 1024px */}
        <div className="lg:hidden mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="w-full justify-between"
          >
            <span className="flex items-center gap-2">
              {activeTab === "proposals" && (
                <>
                  <Home className="w-4 h-4" /> Overview
                </>
              )}
              {activeTab === "info" && (
                <>
                  <FileText className="w-4 h-4" /> Info
                </>
              )}
              {activeTab === "members" && (
                <>
                  <Users className="w-4 h-4" /> Members
                </>
              )}
              {activeTab === "settings" && (
                <>
                  <Settings className="w-4 h-4" /> Settings
                </>
              )}
              {activeTab === "create-proposal" && (
                <>
                  <PlusCircle className="w-4 h-4" /> Add Proposal
                </>
              )}
            </span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${mobileMenuOpen ? "rotate-180" : ""}`}
            />
          </Button>
          {mobileMenuOpen && (
            <div className="mt-2 w-full rounded-lg border bg-background shadow-lg">
              <div className="p-2 space-y-1">
                <button
                  onClick={() => {
                    navigateToTab("proposals");
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeTab === "proposals" ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                >
                  <Home className="w-4 h-4" /> Overview
                </button>
                <button
                  onClick={() => {
                    navigateToTab("info");
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeTab === "info" ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                >
                  <FileText className="w-4 h-4" /> Info
                </button>
                <button
                  onClick={() => {
                    navigateToTab("members");
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeTab === "members" ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                >
                  <Users className="w-4 h-4" /> Members
                </button>
                {dao.isAdmin && publicKey && hasKit && (
                  <button
                    onClick={() => {
                      navigateToTab("settings");
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeTab === "settings" ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                  >
                    <Settings className="w-4 h-4" /> Settings
                  </button>
                )}
                {(dao.isAdmin ||
                  (dao.hasMembership && dao.membersCanPropose)) &&
                  dao.vkSet && (
                    <button
                      onClick={() => {
                        navigateToTab("create-proposal");
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeTab === "create-proposal" ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                    >
                      <PlusCircle className="w-4 h-4" /> Add Proposal
                    </button>
                  )}
                <JoinButton
                  hasMembership={dao.hasMembership}
                  membershipOpen={dao.membershipOpen}
                  publicKey={publicKey}
                  joining={joining}
                  onJoin={() => {
                    onJoin();
                    setMobileMenuOpen(false);
                  }}
                  variant="menu-item"
                />
                <RegistrationButton
                  isRegistered={isRegistered}
                  hasMembership={dao.hasMembership}
                  hasUnregisteredCredentials={hasUnregisteredCredentials}
                  isRegistering={isRegistering}
                  registrationStatus={registrationStatus}
                  publicKey={publicKey}
                  onRegister={() => {
                    onRegister();
                    setMobileMenuOpen(false);
                  }}
                  variant="menu-item"
                />
              </div>
            </div>
          )}
        </div>

        {/* Inline Navigation Menu - shown for lg to 2xl (1024px - 1536px), above description */}
        <div className="hidden lg:block 2xl:hidden mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <NavButtons
              dao={dao}
              activeTab={activeTab}
              publicKey={publicKey}
              hasKit={hasKit}
              navigateToTab={navigateToTab}
            />
            <JoinButton
              hasMembership={dao.hasMembership}
              membershipOpen={dao.membershipOpen}
              publicKey={publicKey}
              joining={joining}
              onJoin={onJoin}
              variant="button"
            />
            <RegistrationButton
              isRegistered={isRegistered}
              hasMembership={dao.hasMembership}
              hasUnregisteredCredentials={hasUnregisteredCredentials}
              isRegistering={isRegistering}
              registrationStatus={registrationStatus}
              publicKey={publicKey}
              onRegister={onRegister}
              variant="button"
            />
          </div>
        </div>

        {/* Description (collapsible) */}
        {metadata?.description && (
          <div>
            <button
              onClick={() => setShowDescription(!showDescription)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {showDescription ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
              {showDescription ? "Hide description" : "Show description"}
            </button>
            {showDescription && (
              <div className="mt-3 p-4 rounded-lg bg-muted/30">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {metadata.description}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
