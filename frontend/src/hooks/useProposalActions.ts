import { useState, useEffect } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { initializeContractClients } from "../lib/contracts";
import { getReadOnlyMembershipSbt } from "../lib/readOnlyContracts";
import {
  generateDeterministicZKCredentials,
  getZKCredentials,
  storeZKCredentials,
} from "../lib/zk";
import { isUserRejection } from "../lib/utils";

interface UseProposalActionsOptions {
  publicKey: string | null;
  kit: StellarWalletsKit | null;
  numericDaoId: number | null;
}

export function useProposalActions({
  publicKey,
  kit,
  numericDaoId,
}: UseProposalActionsOptions) {
  const [hasMembership, setHasMembership] = useState(false);
  const [joining, setJoining] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const [isRegistered, setIsRegistered] = useState(() => {
    return publicKey && numericDaoId !== null
      ? !!getZKCredentials(numericDaoId, publicKey)
      : false;
  });

  // Update isRegistered when publicKey or daoId changes
  useEffect(() => {
    if (publicKey && numericDaoId !== null) {
      setIsRegistered(!!getZKCredentials(numericDaoId, publicKey));
    } else {
      setIsRegistered(false);
    }
  }, [publicKey, numericDaoId]);

  // Check membership on-chain when wallet/dao changes
  useEffect(() => {
    if (!publicKey || numericDaoId === null) {
      setHasMembership(false);
      return;
    }

    const checkMembership = async () => {
      try {
        const sbt = publicKey
          ? initializeContractClients(publicKey).membershipSbt
          : getReadOnlyMembershipSbt();
        const hasSbtResult = await sbt.has({
          dao_id: BigInt(numericDaoId),
          of: publicKey,
        });
        setHasMembership(hasSbtResult.result);
      } catch {
        // Ignore membership check errors
      }
    };

    checkMembership();
  }, [publicKey, numericDaoId]);

  const handleJoinDao = async () => {
    if (!publicKey || !kit || numericDaoId === null) return;

    try {
      setJoining(true);
      setActionError(null);

      const clients = initializeContractClients(publicKey);

      const tx = await clients.membershipSbt.self_join({
        dao_id: BigInt(numericDaoId),
        member: publicKey,
        encrypted_alias: undefined,
      });

      await tx.signAndSend({ signTransaction: kit.signTransaction.bind(kit) });

      setHasMembership(true);
    } catch (err) {
      if (!isUserRejection(err)) {
        setActionError(
          err instanceof Error ? err.message : "Failed to join DAO",
        );
        console.error("Join DAO failed:", err);
      }
    } finally {
      setJoining(false);
    }
  };

  const handleRegisterForVoting = async () => {
    if (!publicKey || !kit || numericDaoId === null || registering) return;

    try {
      setRegistering(true);
      setActionError(null);
      setRegistrationStatus("Step 1/2: Generating secret (sign message)...");

      const credentials = await generateDeterministicZKCredentials(
        kit,
        numericDaoId,
      );

      setRegistrationStatus(
        "Step 2/2: Registering commitment (sign transaction)...",
      );
      const clients = initializeContractClients(publicKey);

      const tx = await clients.membershipTree.register_with_caller({
        dao_id: BigInt(numericDaoId),
        commitment: BigInt(credentials.commitment),
        caller: publicKey,
      });

      const isCommitmentExistsError = (err: unknown): boolean => {
        const errStr = (err as { message?: string })?.message || String(err);
        return errStr.includes("#5") || errStr.includes("Error(Contract, #5)");
      };

      let alreadyRegistered = false;
      try {
        await tx.signAndSend({
          signTransaction: kit.signTransaction.bind(kit),
        });
      } catch (err) {
        if (isCommitmentExistsError(err)) {
          if (import.meta.env.DEV)
            console.log(
              "[Registration] Commitment already exists on-chain - recovering credentials",
            );
          alreadyRegistered = true;
        } else {
          throw err;
        }
      }

      if (alreadyRegistered) {
        setRegistrationStatus("Found existing registration - recovering...");
      }

      const leafIndexResult = await clients.membershipTree.get_leaf_index({
        dao_id: BigInt(numericDaoId),
        commitment: BigInt(credentials.commitment),
      });

      const leafIndex = Number(leafIndexResult.result);
      storeZKCredentials(numericDaoId, publicKey, credentials, leafIndex);

      setIsRegistered(true);
      setRegistrationStatus(null);
    } catch (err) {
      if (!isUserRejection(err)) {
        setActionError(
          err instanceof Error ? err.message : "Failed to register for voting",
        );
        console.error("Registration failed:", err);
      }
      setRegistrationStatus(null);
    } finally {
      setRegistering(false);
    }
  };

  return {
    hasMembership,
    isRegistered,
    joining,
    registering,
    registrationStatus,
    actionError,
    handleJoinDao,
    handleRegisterForVoting,
  };
}
