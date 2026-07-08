import { useState } from "react";
import { Button, Card, Banner } from "@stellar/design-system";

interface WalletConnectProps {
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  publicKey: string | null;
  isConnected: boolean;
}

export default function WalletConnect({
  onConnect,
  onDisconnect,
  publicKey,
  isConnected,
}: WalletConnectProps) {
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    try {
      setError(null);
      setConnecting(true);
      await onConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    onDisconnect();
  };

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };

  if (isConnected && publicKey) {
    return (
      <Banner variant="success">
        <div className="flex items-center justify-between w-full">
          <div>
            <h3 className="text-lg font-semibold mb-1">Wallet Connected</h3>
            <p className="font-mono text-sm">{truncateAddress(publicKey)}</p>
          </div>
          <Button variant="destructive" size="md" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </div>
      </Banner>
    );
  }

  return (
    <Card variant="primary">
      <h3 className="text-lg font-semibold mb-2">Connect Wallet</h3>
      <p className="text-muted-foreground mb-4">
        Connect your Stellar wallet (Freighter, xBull, Albedo, etc.) to interact
        with the DAO.
      </p>
      {error && (
        <div className="mb-4">
          <Banner variant="error">{error}</Banner>
        </div>
      )}
      <Button
        variant="primary"
        size="md"
        isFullWidth
        onClick={handleConnect}
        disabled={connecting}
        isLoading={connecting}
      >
        {connecting ? "Connecting..." : "Connect Wallet"}
      </Button>
    </Card>
  );
}
