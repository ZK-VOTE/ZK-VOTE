import { useState } from "react";
import { truncateAddress } from "../lib/utils";
import { Button } from "./ui/Button";
import { Moon, Sun, Wallet, LogOut, Menu, X } from "lucide-react";

interface NavbarProps {
  onConnect: () => void;
  onDisconnect: () => void;
  publicKey: string | null;
  isConnected: boolean;
  connecting: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  currentView: "home" | "browse" | "votes" | "docs";
  onNavigate: (view: "home" | "browse" | "votes" | "docs") => void;
  relayerStatus?: string | null;
  relayerErrors?: string[];
}

export default function Navbar({
  onConnect,
  onDisconnect,
  publicKey,
  isConnected,
  connecting,
  theme,
  onToggleTheme,
  currentView,
  onNavigate,
  relayerStatus,
  relayerErrors = [],
}: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleNavigate = (view: "home" | "browse" | "votes" | "docs") => {
    onNavigate(view);
    setMobileMenuOpen(false);
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center px-4 sm:px-6 lg:px-8">
        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="mr-2 p-2 lg:hidden"
        >
          {mobileMenuOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </button>

        {/* Logo - visible on all screens */}
        <button
          onClick={() => handleNavigate("home")}
          className="mr-4 lg:mr-8 flex items-center space-x-2"
        >
          <svg
            className="h-5 w-auto"
            viewBox="0 0 203.97 50.91"
            fill="currentColor"
          >
            <path d="M30.96,18.29c-5.69,9.07-12.96,21.17-17.64,28.59h5.62c7.06,0,8.42-2.16,10.51-9.29h2.59l-.72,12.46H.79l-.79-1.37c6.05-9.22,12.96-20.74,17.64-28.59h-5.47c-6.26,0-6.77,2.74-8.21,8.28H1.22v-11.52h29.09l.65,1.44Z" />
            <path d="M38.39,8.28c0-2.74-.58-3.38-1.51-3.6l-2.38-.43V1.8l14.19-1.8.43.36v43.85c0,2.74.58,3.02,4.32,3.24v2.59h-19.37v-2.59c3.74-.22,4.32-.5,4.32-3.24V8.28ZM58.55,18.65c1.22-1.51,1.73-1.8,3.17-1.8h10.37v2.23c-8.06,1.58-10.51,2.59-12.1,4.46-.65.72-2.09,2.38-2.66,3.1-.07.14-.14.29,0,.5,3.24,5.98,6.91,11.45,11.38,16.92,1.94,2.38,3.31,3.24,4.61,3.74v2.16l-6.41.07c-5.33,0-7.85-1.01-10.15-4.25-3.1-4.18-5.04-8.5-7.2-12.89v-.58c1.66-2.3,6.55-10.58,9-13.68Z" />
            <path d="M88.55,50.04c-3.31-9.22-6.98-18.87-10.3-27.58-.79-2.09-1.73-2.81-4.25-2.95v-2.66h18.29v2.66l-2.45.29c-1.22.22-1.3.72-.94,2.02,1.58,4.97,5.18,15.05,6.77,19.66h.29c2.3-6.91,4.46-13.25,6.05-19.37.36-1.3.14-2.02-1.08-2.16l-3.38-.43v-2.66h14.19v2.66c-2.74.22-3.89.43-4.97,2.88-3.82,8.64-7.2,18.94-10.44,27.65h-7.78Z" />
            <path d="M146.69,33.48c0,10.8-5.18,17.43-17.64,17.43s-17.71-6.62-17.71-17.43,5.18-17.5,17.79-17.5,17.57,6.7,17.57,17.5ZM129.04,47.74c4.54,0,6.34-5.26,6.34-14.26s-1.8-14.26-6.34-14.26-6.41,5.18-6.41,14.33,1.8,14.19,6.41,14.19Z" />
            <path d="M162.98,20.31v19.23c0,4.46,1.8,6.19,4.18,6.19.65,0,2.02-.29,2.88-.65l.72,2.16c-3.96,2.52-7.34,3.67-10.01,3.67-3.96,0-8.5-2.81-8.5-8.86v-21.75h-3.82v-3.46h4.18l6.19-8.5h4.18v8.5h6.84v3.46h-6.84Z" />
            <path d="M183.16,33.12c0,7.06,2.38,12.38,8.86,12.38,3.96,0,6.91-2.02,8.93-5.9l2.52,1.44c-2.38,5.98-6.84,9.87-14.91,9.87-12.82.07-16.71-8.42-16.71-17.5s4.46-17.43,16.85-17.43c13.18,0,15.27,8.42,15.27,14.19,0,2.16-1.15,2.95-3.74,2.95h-17.07ZM191.08,29.74c1.51,0,2.09-.36,2.09-2.23,0-3.24-.86-8.28-4.61-8.28-4.03,0-5.47,5.33-5.47,10.51h7.99Z" />
          </svg>
        </button>

        {/* Desktop navigation */}
        <nav className="hidden lg:flex items-center space-x-6 text-sm font-medium">
          <button
            onClick={() => handleNavigate("browse")}
            className={`transition-colors hover:text-foreground/80 ${
              currentView === "browse"
                ? "text-foreground"
                : "text-foreground/60"
            }`}
          >
            Browse DAOs
          </button>
          <button
            onClick={() => handleNavigate("votes")}
            className={`transition-colors hover:text-foreground/80 ${
              currentView === "votes" ? "text-foreground" : "text-foreground/60"
            }`}
          >
            Public Votes
          </button>
          <button
            onClick={() => handleNavigate("docs")}
            className={`transition-colors hover:text-foreground/80 ${
              currentView === "docs" ? "text-foreground" : "text-foreground/60"
            }`}
          >
            Docs
          </button>
        </nav>

        <div className="flex flex-1 items-center justify-end space-x-2">
          <div className="flex items-center gap-2">
            {relayerStatus && (
              <div className="hidden sm:flex items-center px-2 py-1 rounded-md bg-muted text-xs font-medium">
                <div
                  className={`w-2 h-2 rounded-full mr-2 ${
                    relayerStatus === "ready" ? "bg-green-500" : "bg-yellow-500"
                  }`}
                />
                <span title={relayerErrors.join("; ")}>
                  {relayerStatus === "ready"
                    ? "Relayer Active"
                    : "Relayer Issues"}
                </span>
              </div>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleTheme}
              className="h-9 w-9"
            >
              {theme === "light" ? (
                <Moon className="h-4 w-4 transition-all" />
              ) : (
                <Sun className="h-4 w-4 transition-all" />
              )}
              <span className="sr-only">Toggle theme</span>
            </Button>

            {isConnected && publicKey ? (
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center h-9 px-4 rounded-md border bg-muted/50 font-mono text-xs">
                  {truncateAddress(publicKey, 6, 4)}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDisconnect}
                  className="h-9"
                >
                  <LogOut className="mr-2 h-3.5 w-3.5" />
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                onClick={onConnect}
                disabled={connecting}
                size="sm"
                className="h-9"
              >
                <Wallet className="mr-2 h-3.5 w-3.5" />
                {connecting ? "Connecting..." : "Connect Wallet"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-b bg-background">
          <div className="container mx-auto px-4 py-4 space-y-3">
            <button
              onClick={() => handleNavigate("browse")}
              className={`block w-full text-left px-3 py-2 rounded-md transition-colors ${
                currentView === "browse"
                  ? "bg-muted text-foreground"
                  : "text-foreground/60 hover:bg-muted/50"
              }`}
            >
              Browse DAOs
            </button>
            <button
              onClick={() => handleNavigate("votes")}
              className={`block w-full text-left px-3 py-2 rounded-md transition-colors ${
                currentView === "votes"
                  ? "bg-muted text-foreground"
                  : "text-foreground/60 hover:bg-muted/50"
              }`}
            >
              Public Votes
            </button>
            <button
              onClick={() => handleNavigate("docs")}
              className={`block w-full text-left px-3 py-2 rounded-md transition-colors ${
                currentView === "docs"
                  ? "bg-muted text-foreground"
                  : "text-foreground/60 hover:bg-muted/50"
              }`}
            >
              Docs
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
