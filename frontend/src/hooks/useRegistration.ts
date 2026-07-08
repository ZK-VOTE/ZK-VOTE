import { useState, useEffect, useCallback } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import {
  generateDeterministicZKCredentials,
  getZKCredentials,
  storeZKCredentials,
} from "../lib/zk";
import { isUserRejection, extractTxHash } from "../lib/utils";
import { notifyEvent } from "../lib/api";

interface UseRegistrationOptions {
  daoId: number;
  publicKey: string | null;
  kit: StellarWalletsKit | null;
}

interface UseRegistrationReturn {
  register: () => Promise<void>;
  isRegistering: boolean;
  registrationStatus: string | null;
  isRegistered: boolean;
  hasUnregisteredCredentials: boolean;
  error: string | null;
  clearError: () => void;
  checkRegistrationStatus: () => Promise<void>;
}

export function useRegistration({
  daoId,
  publicKey,
  kit,
}: UseRegistrationOptions): UseRegistrationReturn {
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(
    null,
  );
  const [isRegistered, setIsRegistered] = useState(false);
  const [hasUnregisteredCredentials, setHasUnregisteredCredentials] =
    useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check local credential cache on mount / when publicKey changes
  useEffect(() => {
    if (publicKey) {
      const cached = getZKCredentials(daoId, publicKey);
      setIsRegistered(!!cached);
    }
  }, [publicKey, daoId]);

  const clearError = useCallback(() => setError(null), []);

  const checkRegistrationStatus = useCallback(async () => {
    // Don't check during active registration to avoid race conditions
    if (isRegistering) return;

    const cached = publicKey ? getZKCredentials(daoId, publicKey) : null;

    if (!cached) {
      setIsRegistered(false);
      setHasUnregisteredCredentials(false);
      return;
    }

    try {
      const clients = initializeContractClients(publicKey || "");

      const leafIndexResult = await clients.membershipTree.get_leaf_index({
        dao_id: BigInt(daoId),
        commitment: BigInt(cached.commitment),
      });

      const onChainLeafIndex = Number(leafIndexResult.result);

      if (onChainLeafIndex === cached.leafIndex) {
        setIsRegistered(true);
        setHasUnregisteredCredentials(false);
      } else {
        if (publicKey) {
          const legacyKey = `voting_registration_${daoId}_${publicKey}`;
          localStorage.removeItem(legacyKey);
        }
        setIsRegistered(false);
        setHasUnregisteredCredentials(false);
      }
    } catch {
      setIsRegistered(false);
      setHasUnregisteredCredentials(true);
    }
  }, [daoId, publicKey, isRegistering]);

  const register = useCallback(async () => {
    if (isRegistering) {
      if (import.meta.env.DEV)
        console.log(
          "[Registration] Already in progress, ignoring duplicate call",
        );
      return;
    }

    try {
      setIsRegistering(true);
      setError(null);
      setRegistrationStatus(null);

      if (!kit) {
        throw new Error("Wallet kit not available");
      }

      let secret: string, salt: string, commitment: string;

      const cached = publicKey ? getZKCredentials(daoId, publicKey) : null;

      if (hasUnregisteredCredentials && cached) {
        if (import.meta.env.DEV)
          console.log(
            "[Registration] Using existing credentials, skipping signature step",
          );
        secret = cached.secret;
        salt = cached.salt;
        commitment = cached.commitment;
        setRegistrationStatus("Using existing credentials...");
      } else {
        setRegistrationStatus("Step 1/2: Generating Secret");
        if (import.meta.env.DEV)
          console.log(
            "[Registration] Step 1: Generating deterministic credentials from wallet signature...",
          );
        let credentials;
        try {
          credentials = await generateDeterministicZKCredentials(kit, daoId);
        } catch (err) {
          console.error("[Registration] Step 1 failed:", err);
          throw err;
        }

        secret = credentials.secret;
        salt = credentials.salt;
        commitment = credentials.commitment;

        if (import.meta.env.DEV)
          console.log(
            "[Registration] Step 1 complete - Generated voting credentials",
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      setRegistrationStatus("Step 2/2: Registering Commitment");
      if (import.meta.env.DEV)
        console.log(
          "[Registration] Step 2: Registering commitment in Merkle tree...",
        );
      const clients = initializeContractClients(publicKey || "");

      const tx = await clients.membershipTree.register_with_caller({
        dao_id: BigInt(daoId),
        commitment: BigInt(commitment),
        caller: publicKey || "",
      });

      // Helper to check if error is CommitmentExists (error #5 from tree contract)
      const isCommitmentExistsError = (err: unknown): boolean => {
        const errStr = (err as { message?: string })?.message || String(err);
        return errStr.includes("#5") || errStr.includes("Error(Contract, #5)");
      };

      let alreadyRegistered = false;
      let txHash: string | null = null;
      try {
        if (import.meta.env.DEV)
          console.log("[Registration] Calling signAndSend...");
        const result = await tx.signAndSend({
          signTransaction: kit.signTransaction.bind(kit),
        });
        if (import.meta.env.DEV)
          console.log(
            "[Registration] Step 2 complete - Transaction signed and sent:",
            result,
          );
        txHash = extractTxHash(result);
      } catch (err) {
        // Check if this is a CommitmentExists error - means we're already registered
        if (isCommitmentExistsError(err)) {
          if (import.meta.env.DEV)
            console.log(
              "[Registration] Commitment already exists on-chain - recovering credentials",
            );
          alreadyRegistered = true;
        } else {
          console.error("[Registration] Step 2 (signAndSend) failed:", err);
          const errorMessage =
            err instanceof Error ? err.message : "Unknown error";
          const enhancedError = new Error(
            `Transaction signing failed: ${errorMessage}`,
          );
          (enhancedError as Error & { originalError: unknown }).originalError =
            err;
          throw enhancedError;
        }
      }

      if (alreadyRegistered) {
        setRegistrationStatus("Found existing registration - recovering...");
      }

      const leafIndexResult = await clients.membershipTree.get_leaf_index({
        dao_id: BigInt(daoId),
        commitment: BigInt(commitment),
      });

      const leafIndex = Number(leafIndexResult.result);
      storeZKCredentials(
        daoId,
        publicKey || "",
        { secret, salt, commitment },
        leafIndex,
      );

      // Notify relayer of registration event (only if we actually registered, not recovered)
      if (txHash && !alreadyRegistered) {
        notifyEvent(daoId, "voter_registered", txHash, {
          commitment,
          leafIndex,
        });
      }

      setIsRegistered(true);
      setHasUnregisteredCredentials(false);
      setRegistrationStatus(
        alreadyRegistered ? "Credentials recovered!" : "Registration complete!",
      );
      if (import.meta.env.DEV)
        console.log(
          alreadyRegistered
            ? "Credentials recovered! Leaf index:"
            : "Registration successful! Leaf index:",
          leafIndex,
        );

      // Clear status after a short delay
      setTimeout(() => setRegistrationStatus(null), 2000);
    } catch (err) {
      if (isUserRejection(err)) {
        if (import.meta.env.DEV) console.log("User cancelled registration");
        setRegistrationStatus(null);
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to register for voting",
        );
        console.error("Registration failed:", err);
        setRegistrationStatus(null);
      }
    } finally {
      setIsRegistering(false);
    }
  }, [daoId, publicKey, kit, isRegistering, hasUnregisteredCredentials]);

  return {
    register,
    isRegistering,
    registrationStatus,
    isRegistered,
    hasUnregisteredCredentials,
    error,
    clearError,
    checkRegistrationStatus,
  };
}
