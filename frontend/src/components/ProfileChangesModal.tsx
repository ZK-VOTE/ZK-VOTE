import { X, ArrowRight, Image, Globe, FileText } from "lucide-react";
import { Button } from "./ui/Button";
import { getImageUrl } from "../lib/daoMetadata";

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

interface ProfileChange {
  old: string | null;
  new: string | null;
}

interface ProfileChangesModalProps {
  changes: Record<string, ProfileChange>;
  timestamp?: string | null;
  onClose: () => void;
}

// Field display configuration
const FIELD_CONFIG: Record<
  string,
  { label: string; icon: React.ElementType; isImage?: boolean; isUrl?: boolean }
> = {
  name: { label: "DAO Name", icon: FileText },
  description: { label: "Description", icon: FileText },
  coverImageCid: { label: "Cover Image", icon: Image, isImage: true },
  profileImageCid: { label: "Profile Image", icon: Image, isImage: true },
  website: { label: "Website", icon: Globe, isUrl: true },
  twitter: { label: "Twitter", icon: TwitterIcon, isUrl: true },
  linkedin: { label: "LinkedIn", icon: LinkedInIcon, isUrl: true },
  github: { label: "GitHub", icon: GitHubIcon, isUrl: true },
};

function ImagePreview({ cid, label }: { cid: string | null; label: string }) {
  if (!cid) {
    return (
      <div className="w-16 h-16 rounded bg-muted flex items-center justify-center text-muted-foreground">
        <span className="text-xs">None</span>
      </div>
    );
  }

  return (
    <img
      src={getImageUrl(cid)}
      alt={label}
      className="w-16 h-16 rounded object-cover"
    />
  );
}

function TextValue({
  value,
  isUrl,
}: {
  value: string | null;
  isUrl?: boolean;
}) {
  if (!value) {
    return <span className="text-muted-foreground italic">Not set</span>;
  }

  if (isUrl) {
    return (
      <a
        href={value.startsWith("http") ? value : `https://${value}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
      >
        {value}
      </a>
    );
  }

  // For description, limit display length
  if (value.length > 100) {
    return (
      <span className="break-all" title={value}>
        {value.slice(0, 100)}...
      </span>
    );
  }

  return <span className="break-all">{value}</span>;
}

export default function ProfileChangesModal({
  changes,
  timestamp,
  onClose,
}: ProfileChangesModalProps) {
  const changeEntries = Object.entries(changes);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-lg font-semibold">Profile Changes</h3>
            {timestamp && (
              <p className="text-sm text-muted-foreground">
                {new Date(timestamp).toLocaleString()}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {changeEntries.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              No changes recorded
            </p>
          ) : (
            <div className="space-y-4">
              {changeEntries.map(([field, change]) => {
                const config = FIELD_CONFIG[field] || {
                  label: field,
                  icon: FileText,
                };
                const Icon = config.icon;

                return (
                  <div
                    key={field}
                    className="rounded-lg border bg-muted/30 p-4"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{config.label}</span>
                    </div>

                    {config.isImage ? (
                      <div className="flex items-center gap-4">
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground mb-1">
                            Before
                          </p>
                          <ImagePreview
                            cid={change.old}
                            label={`Old ${config.label}`}
                          />
                        </div>
                        <ArrowRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground mb-1">
                            After
                          </p>
                          <ImagePreview
                            cid={change.new}
                            label={`New ${config.label}`}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr,auto,1fr] gap-2 items-start text-sm">
                        <div className="bg-red-500/10 rounded p-2 min-h-[2.5rem]">
                          <p className="text-xs text-red-500 dark:text-red-400 mb-1">
                            Before
                          </p>
                          <TextValue value={change.old} isUrl={config.isUrl} />
                        </div>
                        <ArrowRight className="w-4 h-4 text-muted-foreground mt-3 flex-shrink-0" />
                        <div className="bg-green-500/10 rounded p-2 min-h-[2.5rem]">
                          <p className="text-xs text-green-500 dark:text-green-400 mb-1">
                            After
                          </p>
                          <TextValue value={change.new} isUrl={config.isUrl} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-muted/30">
          <p className="text-xs text-muted-foreground">
            {changeEntries.length} field{changeEntries.length !== 1 ? "s" : ""}{" "}
            changed
          </p>
        </div>
      </div>
    </div>
  );
}
