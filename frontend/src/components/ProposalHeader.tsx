import { useNavigate } from "react-router-dom";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { LoadingSpinner } from "./ui";
import {
  Shield,
  Users,
  Lock,
  Unlock,
  Home,
  FileText,
  UserPlus,
  KeyRound,
} from "lucide-react";

interface DaoInfo {
  name: string;
  admin?: string;
  isAdmin?: boolean;
  membershipOpen?: boolean;
}

interface ProposalHeaderProps {
  daoSlugForNav: string;
  daoDisplayName: string;
  numericDaoId: number | null;
  daoInfo: DaoInfo | undefined;
  hasMembership: boolean;
  isRegistered: boolean;
  publicKey: string | null;
  proposalTitle?: string;
  /** Join DAO action */
  joining: boolean;
  onJoinDao: () => void;
  /** Register to vote action */
  registering: boolean;
  registrationStatus: string | null;
  onRegisterForVoting: () => void;
  /** Action error to display */
  actionError: string | null;
}

export default function ProposalHeader({
  daoSlugForNav,
  daoDisplayName,
  numericDaoId,
  daoInfo,
  hasMembership,
  isRegistered,
  publicKey,
  proposalTitle,
  joining,
  onJoinDao,
  registering,
  registrationStatus,
  onRegisterForVoting,
  actionError,
}: ProposalHeaderProps) {
  const navigate = useNavigate();

  return (
    <>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate("/daos/")}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          DAOs
        </button>
        <span className="text-muted-foreground">/</span>
        <button
          onClick={() => navigate(`/daos/${daoSlugForNav}`)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {daoDisplayName}
        </button>
        {proposalTitle && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-foreground font-medium">{proposalTitle}</span>
          </>
        )}
      </nav>

      {/* DAO Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-3xl font-bold tracking-tight text-foreground">
                {daoDisplayName}
              </h2>
              {daoInfo?.isAdmin ? (
                <Badge variant="blue" className="gap-1">
                  <Shield className="w-3 h-3" /> Admin
                </Badge>
              ) : hasMembership ? (
                <Badge variant="success" className="gap-1">
                  <Users className="w-3 h-3" /> Member
                </Badge>
              ) : (
                <Badge variant="gray" className="gap-1">
                  <Users className="w-3 h-3" /> Non-member
                </Badge>
              )}
              {daoInfo?.membershipOpen ? (
                <Badge variant="success" className="gap-1">
                  <Unlock className="w-3 h-3" /> Open
                </Badge>
              ) : daoInfo ? (
                <Badge variant="secondary" className="gap-1">
                  <Lock className="w-3 h-3" /> Closed
                </Badge>
              ) : null}
            </div>
            {daoInfo && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded">
                  ID: {numericDaoId}
                </span>
                {daoInfo.admin && (
                  <>
                    <span>•</span>
                    <span>
                      Created by {daoInfo.admin.slice(0, 4)}...
                      {daoInfo.admin.slice(-4)}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/daos/${daoSlugForNav}`)}
            className="gap-2"
          >
            <Home className="w-4 h-4" />
            Overview
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/daos/${daoSlugForNav}/info`)}
            className="gap-2"
          >
            <FileText className="w-4 h-4" /> Info
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/daos/${daoSlugForNav}/members`)}
            className="gap-2"
          >
            <Users className="w-4 h-4" />
            Members
          </Button>

          {/* Join DAO button - show for non-members when membership is open */}
          {!hasMembership && daoInfo?.membershipOpen && publicKey && (
            <Button
              variant="outline"
              onClick={onJoinDao}
              disabled={joining}
              size="sm"
              className="gap-2"
            >
              {joining ? (
                <>
                  <LoadingSpinner size="sm" />
                  Joining...
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  Join DAO
                </>
              )}
            </Button>
          )}

          {/* Register to Vote button - show for members who haven't registered */}
          {hasMembership && !isRegistered && publicKey && (
            <Button
              variant="outline"
              onClick={onRegisterForVoting}
              disabled={registering}
              size="sm"
              className="gap-2"
            >
              {registering ? (
                <>
                  <LoadingSpinner size="sm" />
                  {registrationStatus || "Registering..."}
                </>
              ) : (
                <>
                  <KeyRound className="w-4 h-4" />
                  Register to Vote
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Show action errors */}
      {actionError && (
        <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-md">
          {actionError}
        </div>
      )}
    </>
  );
}
