import { useState, useEffect } from "react";
import {
  subscribeToRelayerStatus,
  getRelayerStatus,
  forceReconnect,
  checkRelayerHealth,
} from "../lib/api";

export function RelayerStatusBanner() {
  const [connected, setConnected] = useState(true);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    // Subscribe to relayer status changes
    const unsubscribe = subscribeToRelayerStatus((status) => {
      setConnected(status);
    });

    // Initial health check
    checkRelayerHealth().then(setConnected);

    return unsubscribe;
  }, []);

  const handleRetry = async () => {
    setIsRetrying(true);
    forceReconnect();
    const healthy = await checkRelayerHealth();
    setConnected(healthy);
    setIsRetrying(false);
  };

  if (connected) {
    return null;
  }

  const { backoffRemaining } = getRelayerStatus();
  const backoffSeconds = Math.ceil(backoffRemaining / 1000);

  return (
    <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-200 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <svg
          className="w-5 h-5 text-yellow-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <span>
          Relayer disconnected.
          {backoffSeconds > 0 && ` Retrying in ${backoffSeconds}s...`} Anonymous
          voting and comments require the relayer.
        </span>
      </div>
      <button
        onClick={handleRetry}
        disabled={isRetrying}
        className="px-3 py-1 bg-yellow-500/20 hover:bg-yellow-500/30 rounded text-sm font-medium disabled:opacity-50"
      >
        {isRetrying ? "Retrying..." : "Retry Now"}
      </button>
    </div>
  );
}
