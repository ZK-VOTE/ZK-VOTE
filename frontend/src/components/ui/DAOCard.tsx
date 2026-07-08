import { Lock, Unlock } from "lucide-react";

interface DAOCardProps {
  id: number;
  name: string;
  membershipOpen: boolean;
  isSelected: boolean;
  coverUrl: string | null;
  profileUrl: string | null;
  hasCover: boolean;
  onClick: () => void;
  role?: "admin" | "member";
}

// Default backgrounds for DAOs without cover images (light/dark mode)
const DEFAULT_BG_DARK = "/empty-bg-dark.png";
const DEFAULT_BG_LIGHT = "/empty-bg-light.png";

export default function DAOCard({
  id,
  name,
  membershipOpen,
  isSelected,
  coverUrl,
  profileUrl,
  hasCover,
  onClick,
  role,
}: DAOCardProps) {
  return (
    <button
      onClick={onClick}
      className={`group text-left rounded-xl overflow-hidden border transition-all duration-200 ease-out hover:shadow-lg ${
        isSelected
          ? "border-primary ring-2 ring-primary"
          : "border-border hover:border-primary/50"
      }`}
    >
      {/* Cover image area */}
      <div
        className="relative h-60 bg-cover bg-center"
        style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
      >
        {/* Default background for DAOs without cover - switches based on theme */}
        {!coverUrl && (
          <>
            <div
              className="absolute inset-0 bg-cover bg-center dark:hidden"
              style={{ backgroundImage: `url(${DEFAULT_BG_LIGHT})` }}
            />
            <div
              className="absolute inset-0 bg-cover bg-center hidden dark:block"
              style={{ backgroundImage: `url(${DEFAULT_BG_DARK})` }}
            />
          </>
        )}

        {/* Overlay - dark for custom covers, light/dark adaptive for defaults */}
        {hasCover ? (
          <div className="absolute inset-0 bg-black/50 transition-opacity duration-200 group-hover:bg-black/30" />
        ) : (
          <div className="absolute inset-0 bg-white/50 dark:bg-black/50 transition-opacity duration-200 group-hover:bg-white/30 dark:group-hover:bg-black/30" />
        )}

        {/* Top row: badges + selection indicator */}
        <div className="absolute top-3 left-3 right-3 flex items-start justify-between">
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-medium gap-0.5 rounded-full bg-black/50 text-white">
              #{id}
            </span>
            {membershipOpen ? (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-medium gap-0.5 rounded-full bg-green-500/90 dark:bg-green-500/80 text-white">
                <Unlock className="w-2.5 h-2.5" /> Open
              </span>
            ) : (
              <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-medium gap-0.5 rounded-full bg-gray-500/90 dark:bg-gray-500/80 text-white">
                <Lock className="w-2.5 h-2.5" /> Closed
              </span>
            )}
            {role && (
              <span
                className={`inline-flex items-center h-5 px-1.5 text-[10px] font-medium rounded-full ${
                  role === "admin"
                    ? "bg-blue-500/90 dark:bg-blue-500/80 text-white"
                    : "bg-purple-500/90 dark:bg-purple-500/80 text-white"
                }`}
              >
                {role.charAt(0).toUpperCase() + role.slice(1)}
              </span>
            )}
          </div>
          {isSelected && (
            <div className="w-3 h-3 rounded-full bg-primary shadow-lg" />
          )}
        </div>

        {/* Centered content: profile image + name */}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 pt-8">
          {/* Profile image - only show if exists */}
          {profileUrl && (
            <img
              src={profileUrl}
              alt={`${name} profile`}
              className={`w-16 h-16 rounded-full border-2 object-cover mb-3 ${
                hasCover
                  ? "border-white/50"
                  : "border-black/30 dark:border-white/50"
              }`}
            />
          )}
          {/* Name - centered, wrapped */}
          <h3
            className={`w-full text-base font-bold text-center leading-tight break-words ${
              hasCover ? "text-white" : "text-gray-900 dark:text-white"
            }`}
          >
            {name}
          </h3>
        </div>
      </div>
    </button>
  );
}
