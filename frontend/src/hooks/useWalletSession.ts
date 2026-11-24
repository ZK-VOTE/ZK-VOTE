import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  APP_NETWORK_PASSPHRASE,
  networkLabel,
  walletSession,
  type WalletSessionState,
} from "../lib/walletSession";

/** Live wallet session (#750), shared by every component. */
export function useWalletSession(): WalletSessionState {
  return useSyncExternalStore(walletSession.subscribe, walletSession.getState);
}

/**
 * For forms and quotes that must not survive a wallet change (#750): the
 * snapshot is retaken whenever `deps` change (the user edited the form under
 * the current session). `blockReason()` returns why a submit must stop, and
 * re-arms so a second click after review goes through.
 */
export function useSessionBoundForm(deps: readonly unknown[]) {
  const snap = useRef(walletSession.snapshot());

  useEffect(() => {
    snap.current = walletSession.snapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the form fields
  }, deps);

  const blockReason = useCallback((): string | null => {
    const { status, walletPassphrase } = walletSession.getState();
    if (status === "network_mismatch") {
      return `Your wallet is on ${networkLabel(walletPassphrase)}, but this app uses ${networkLabel(APP_NETWORK_PASSPHRASE)}. Switch networks in your wallet first.`;
    }
    const change = walletSession.changeSince(snap.current);
    snap.current = walletSession.snapshot();
    if (change && change !== "reconnected") {
      return "Your wallet changed since this was filled in. Check the details, then submit again.";
    }
    return null;
  }, []);

  return { blockReason };
}

/** Run `onChange` whenever the wallet session moves to a new generation. */
export function useOnWalletSessionChange(onChange: () => void): void {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  useEffect(() => {
    let generation = walletSession.getState().generation;
    return walletSession.subscribe(() => {
      const next = walletSession.getState().generation;
      if (next !== generation) {
        generation = next;
        cb.current();
      }
    });
  }, []);
}
