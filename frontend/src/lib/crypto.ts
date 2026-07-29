import { buildPoseidon } from "circomlibjs";
import {
  generateMnemonic,
  masterSecretToMnemonic,
  mnemonicToMasterSecret,
  mnemonicToEntropy,
} from "./bip39";

// BN254 Scalar Field Order (r)
export const BN254_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

// Domain separator for ZK-VOTE key derivation KDF
const DOMAIN_SEPARATOR = "ZK-VOTE";

export interface DerivedElectionKeys {
  masterSecret: string;
  electionId: string;
  electionSecret: string;
  commitment: string;
  nullifier: string;
}

// Convert arbitrary string or number to a valid BN254 Field Element (BigInt)
export function stringToFieldElement(str: string | number): bigint {
  if (typeof str === "number") {
    return BigInt(str) % BN254_MODULUS;
  }
  if (/^\d+$/.test(str)) {
    return BigInt(str) % BN254_MODULUS;
  }
  if (str.startsWith("0x")) {
    return BigInt(str) % BN254_MODULUS;
  }

  // Hash string with SHA-256 to fit in scalar field
  let hash = BigInt(0);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * BigInt(31) + BigInt(str.charCodeAt(i))) % BN254_MODULUS;
  }
  return hash;
}

// Generate a random 256-bit master secret (in BN254 scalar field)
export function generateMasterSecret(): bigint {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "0x";
  for (let i = 0; i < 32; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex) % BN254_MODULUS;
}

/**
 * Derives a deterministic per-election secret using a Poseidon-based KDF:
 * election_secret = Poseidon(master_secret, domain_hash, election_id)
 *
 * Requirements satisfied:
 * 1. Each election gets a unique, deterministic secret.
 * 2. Master secret backup enables recovery of all election secrets.
 * 3. Secrets for different elections are unlinkable without the master secret.
 * 4. Maintains circuit compatibility with BN254 / circomlib Poseidon.
 */
export async function deriveElectionSecret(
  masterSecretInput: string | bigint,
  electionIdInput: string | number
): Promise<DerivedElectionKeys> {
  const poseidon = await buildPoseidon();

  // Normalize master secret to BigInt within scalar field
  let masterSecret: bigint;
  if (typeof masterSecretInput === "string" && masterSecretInput.includes(" ")) {
    // Input is a BIP-39 mnemonic phrase
    masterSecret = mnemonicToMasterSecret(masterSecretInput);
  } else if (typeof masterSecretInput === "string") {
    masterSecret = BigInt(masterSecretInput) % BN254_MODULUS;
  } else {
    masterSecret = masterSecretInput % BN254_MODULUS;
  }

  const domainHash = stringToFieldElement(DOMAIN_SEPARATOR);
  const electionIdField = stringToFieldElement(electionIdInput);

  // KDF: Poseidon(masterSecret, domainHash, electionId)
  const poseidonResult = poseidon([masterSecret, domainHash, electionIdField]);
  const electionSecret = poseidon.F.toString(poseidonResult);

  // Compute derived commitment: Poseidon(electionSecret)
  const commitmentResult = poseidon([BigInt(electionSecret)]);
  const commitment = poseidon.F.toString(commitmentResult);

  // Compute derived nullifier: Poseidon(electionSecret, electionId)
  const nullifierResult = poseidon([BigInt(electionSecret), electionIdField]);
  const nullifier = poseidon.F.toString(nullifierResult);

  return {
    masterSecret: masterSecret.toString(),
    electionId: String(electionIdInput),
    electionSecret,
    commitment,
    nullifier,
  };
}

// Synchronous / Standalone Poseidon KDF fallback if circomlibjs initialized
export function deriveElectionSecretSync(
  masterSecretInput: bigint | string,
  electionIdInput: string | number,
  poseidonInstance: any
): DerivedElectionKeys {
  const masterSecret = typeof masterSecretInput === "string" && masterSecretInput.includes(" ")
    ? mnemonicToMasterSecret(masterSecretInput)
    : BigInt(masterSecretInput) % BN254_MODULUS;

  const domainHash = stringToFieldElement(DOMAIN_SEPARATOR);
  const electionIdField = stringToFieldElement(electionIdInput);

  const poseidonResult = poseidonInstance([masterSecret, domainHash, electionIdField]);
  const electionSecret = poseidonInstance.F.toString(poseidonResult);

  const commitmentResult = poseidonInstance([BigInt(electionSecret)]);
  const commitment = poseidonInstance.F.toString(commitmentResult);

  const nullifierResult = poseidonInstance([BigInt(electionSecret), electionIdField]);
  const nullifier = poseidonInstance.F.toString(nullifierResult);

  return {
    masterSecret: masterSecret.toString(),
    electionId: String(electionIdInput),
    electionSecret,
    commitment,
    nullifier,
  };
}

// Re-export BIP-39 utilities for UI & backup
export {
  generateMnemonic,
  masterSecretToMnemonic,
  mnemonicToMasterSecret,
  mnemonicToEntropy,
};
