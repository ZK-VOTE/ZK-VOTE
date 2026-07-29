// ZK credential management for anonymous voting
import { buildPoseidon } from "circomlibjs";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { CONTRACTS, NETWORK_CONFIG } from "../config/contracts";

// Domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Must match DOMAIN_TAG in circuits
const DOMAIN_TAG = BigInt("19666041591797403834655481403982443037438503980743793537655983658411276515161");

export interface ZKCredentials {
  secret: string;
  salt: string;
  blindingFactor: string;
  commitment: string;
}

const CREDENTIAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STORAGE_PREFIX = `zkvote_${NETWORK_CONFIG.networkName}_${CONTRACTS.VOTING_ID.slice(0, 6)}`;

function credentialKey(daoId: number, publicKey: string) {
  return `${STORAGE_PREFIX}_voting_registration_${daoId}_${publicKey}`;
}

// Generate deterministic ZK credentials from wallet signature
// This allows credentials to be recovered on any device with the same wallet
//
// SECURITY WARNING: Deterministic signature-based credentials are vulnerable to phishing!
// If an attacker tricks a user into signing the same message on a malicious site,
// they can derive the user's voting credentials and vote on their behalf.
//
// Mitigations:
// - Clear warning text in the signing message
// - Domain separation in the message format
// - Users should only sign on the official ZKVote application
//
// KNOWN TRADE-OFFS:
// 1. Deterministic credentials from wallet signatures can be phished if user signs
//    the same message on a malicious site. Mitigated by domain separation in message text.
// 2. Credentials are stored in localStorage (persists across sessions).
//    XSS or malicious extensions can read them. Consider encrypting at rest.
export async function generateDeterministicZKCredentials(
  kit: StellarWalletsKit,
  daoId: number,
): Promise<ZKCredentials> {
  const poseidon = await buildPoseidon();

  // Create deterministic message with strong domain separation
  // Format: [domain] [action] [context] [unique-id]
  // This prevents cross-site replay attacks
  const message = `[ZKVote App - DO NOT SIGN ON OTHER SITES]

Action: Generate anonymous voting credentials
DAO ID: ${daoId}
Purpose: This signature creates your secret voting key for this DAO.
Warning: Only sign this on the official ZKVote application.

By signing, you acknowledge that anyone who obtains this signature can vote on your behalf in DAO ${daoId}.`;

  // Sign message with wallet (deterministic per wallet + DAO)
  // Only 1 signature needed - we'll derive both secret and salt from it
  const { signedMessage } = await kit.signMessage(message);

  // Hash the signature to get deterministic bytes
  const signatureBytes = new TextEncoder().encode(signedMessage);
  const hashBuffer = await crypto.subtle.digest("SHA-256", signatureBytes);
  const hashArray = new Uint8Array(hashBuffer);

  // Derive secret from first 32 bytes
  const secret = BigInt(
    "0x" +
      Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Derive salt by hashing the signature again with a different domain separator
  // This gives us a second independent value from the same signature
  const saltInput = new TextEncoder().encode(`salt:${signedMessage}`);
  const saltHashBuffer = await crypto.subtle.digest("SHA-256", saltInput);
  const saltHashArray = new Uint8Array(saltHashBuffer);

  const salt = BigInt(
    "0x" +
      Array.from(saltHashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Derive blinding factor with a third domain separator
  const blindingInput = new TextEncoder().encode(`blinding:${signedMessage}`);
  const blindingHashBuffer = await crypto.subtle.digest("SHA-256", blindingInput);
  const blindingHashArray = new Uint8Array(blindingHashBuffer);

  const blindingFactor = BigInt(
    "0x" +
      Array.from(blindingHashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Compute commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
  // Domain-separated commitment prevents cross-protocol attacks.
  // Blinding factor ensures uniform distribution even if secret/salt are correlated.
  const commitment = poseidon.F.toString(poseidon([DOMAIN_TAG, secret, salt, blindingFactor]));

  return {
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    commitment,
  };
}

// Legacy: Generate random ZK credentials (kept for backwards compatibility)
export async function generateRandomZKCredentials(): Promise<ZKCredentials> {
  const poseidon = await buildPoseidon();

  // Generate random secret and salt (32 bytes each -> 256 bits)
  const secret = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  const salt = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Generate random blinding factor
  const blindingFactor = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Compute commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
  const commitment = poseidon.F.toString(poseidon([DOMAIN_TAG, secret, salt, blindingFactor]));

  return {
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    commitment,
  };
}

// Store ZK credentials in localStorage (indexed by DAO ID and public key)
// Uses the same format as manual registration in DAODashboard
export function storeZKCredentials(
  daoId: number,
  publicKey: string,
  credentials: ZKCredentials,
  leafIndex: number = 0,
) {
  const key = credentialKey(daoId, publicKey);
  localStorage.setItem(
    key,
    JSON.stringify({
      secret: credentials.secret,
      salt: credentials.salt,
      blindingFactor: credentials.blindingFactor,
      commitment: credentials.commitment,
      leafIndex,
      registeredAt: Date.now(),
    }),
  );
  if (import.meta.env.DEV)
    console.log(
      `Stored ZK credentials for DAO ${daoId}, user ${publicKey.substring(0, 8)}...`,
    );
}

// Retrieve ZK credentials from localStorage
export function getZKCredentials(
  daoId: number,
  publicKey: string,
): {
  secret: string;
  salt: string;
  blindingFactor: string;
  commitment: string;
  leafIndex: number;
} | null {
  const key = credentialKey(daoId, publicKey);
  const stored = localStorage.getItem(key);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    if (
      parsed.registeredAt &&
      Date.now() - parsed.registeredAt > CREDENTIAL_CACHE_TTL_MS
    ) {
      localStorage.removeItem(key);
      console.warn(
        `[ZK] Cached credentials expired for DAO ${daoId}, key cleared`,
      );
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Get or regenerate ZK credentials (deterministic recovery)
// If credentials exist in localStorage, return them
// If not, regenerate from wallet signature and cache
export async function getOrRegenerateZKCredentials(
  kit: StellarWalletsKit | null,
  daoId: number,
  publicKey: string,
): Promise<{
  secret: string;
  salt: string;
  blindingFactor: string;
  commitment: string;
  leafIndex: number;
} | null> {
  // Try to load from cache first
  const cached = getZKCredentials(daoId, publicKey);
  if (cached) {
    if (import.meta.env.DEV)
      console.log(`[ZK] Using cached credentials for DAO ${daoId}`);
    return cached;
  }

  // No cache and no wallet = can't regenerate
  if (!kit) {
    if (import.meta.env.DEV)
      console.log(`[ZK] No credentials in cache and no wallet connected`);
    return null;
  }

  // Regenerate from wallet signature
  if (import.meta.env.DEV)
    console.log(
      `[ZK] Regenerating credentials from wallet signature for DAO ${daoId}...`,
    );
  try {
    // Credentials generated but not used - leaf index lookup not yet implemented
    await generateDeterministicZKCredentials(kit, daoId);

    // Get leaf index from contract (this requires on-chain lookup)
    // For now, return null and require explicit registration
    // In the future, we could query the tree contract to find the leaf index
    if (import.meta.env.DEV)
      console.log(
        `[ZK] Credentials regenerated, but leaf index unknown. User must re-register.`,
      );
    return null;

    // Future enhancement: Query contract for leaf index
    // const leafIndex = await queryLeafIndexFromContract(commitment, daoId);
    // storeZKCredentials(daoId, publicKey, credentials, leafIndex);
    // return { ...credentials, leafIndex };
  } catch (err) {
    console.error(`[ZK] Failed to regenerate credentials:`, err);
    return null;
  }
}

// ─── Panic / Fake Credentials (#96 Coercion Resistance) ─────────────────────
//
// A coerced voter can generate "fake" credentials: a random secret/salt pair
// whose commitment is registered with the registrar. The resulting ZK proof is
// structurally valid (passes the circuit) but the commitment is not in the
// membership Merkle tree, so the on-chain nullifier check will reject the vote.
//
// This implements the first layer of the JCJ coercion-resistance model:
//  1. The coercer sees valid-looking credentials and a valid-looking proof.
//  2. The real credential (derived deterministically from the wallet) remains
//     usable — the voter can cast their real vote after the coercion ends.
//  3. Only the registrar can distinguish real from fake credentials because
//     only real commitments appear in the membership Merkle tree.
//
// NOTE: Full JCJ requires a separate re-voting window and registrar-side
// filtering; this function provides the client-side credential generation step.
export async function generateFakeZKCredentials(): Promise<ZKCredentials> {
  const poseidon = await buildPoseidon();

  const secret = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  const salt = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  const blindingFactor = BigInt(
    "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  const commitment = poseidon.F.toString(poseidon([DOMAIN_TAG, secret, salt, blindingFactor]));

  return {
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    commitment,
  };
}

// Compute commitment from secret, salt, and blinding factor
// Matches circuit computation: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
export async function computeCommitment(
  secret: string,
  salt: string,
  blindingFactor: string,
): Promise<string> {
  const poseidon = await buildPoseidon();
  const commitment = poseidon.F.toString(
    poseidon([DOMAIN_TAG, BigInt(secret), BigInt(salt), BigInt(blindingFactor)]),
  );
  return commitment;
}
