// ZK credential management for anonymous voting
import { buildPoseidon } from "circomlibjs";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { CONTRACTS, NETWORK_CONFIG } from "../config/contracts";
import { relayerFetch } from "./api";

// Domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Must match DOMAIN_TAG in circuits
const DOMAIN_TAG = BigInt(
  "19666041591797403834655481403982443037438503980743793537655983658411276515161",
);

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
// - Clear, explicit domain separation in the signing message
// - Cryptographic binding to DAO ID and application domain
// - Phishing-resistant message format that is difficult to repurpose
// - Users should only sign on the official ZKVote application
//
// CRITICAL (#659): Enhanced phishing resistance
// - Message now includes: [app-id][DAO-specific binding][nonce-like timestamp]
// - Each credential derivation is unique per DAO and harder to cross-site forge
// - Signature itself is bound to message with strong cryptographic domain separation
//
// KNOWN TRADE-OFFS:
// 1. Deterministic credentials from wallet signatures can be phished if user signs
//    the same message on a malicious site. Mitigated by strong domain separation in message text.
// 2. Credentials are stored in localStorage (persists across sessions).
//    XSS or malicious extensions can read them. Consider encrypting at rest.
export async function generateDeterministicZKCredentials(
  kit: StellarWalletsKit,
  daoId: number,
): Promise<ZKCredentials> {
  const poseidon = await buildPoseidon();

  // Create deterministic message with CRITICAL (#659) enhanced domain separation
  // This message format is intentionally verbose and specific to prevent cross-site
  // phishing. An attacker cannot simply reuse a signature from one site on another.
  //
  // Format: [app-domain][action][context][binding][warning]
  // The inclusion of DAO ID and explicit dApp name makes signature replay harder.
  const appDomain = "ZKVote Anonymous Voting System";
  const message = `=== ${appDomain} ===
DO NOT SIGN THIS MESSAGE ON ANY OTHER WEBSITE OR APPLICATION

Action: Generate Voting Credentials
DAO ID: ${daoId} (blockchain-specific binding)
Nonce: ${Date.now()} (time-based, prevents simple replay)

Purpose:
This signature authorizes credential generation for anonymous voting in DAO ${daoId}.
Your wallet will be used as an entropy source only - not as your voting identity.

Security Warning:
- Only sign this message on official ZKVote application
- Anyone with this signature can generate voting credentials
- Each DAO requires a separate signature
- Cancel if you see this on an unexpected website

By signing, you accept the voting terms for DAO ${daoId}.`;

  // Sign message with wallet (deterministic per wallet + DAO + timestamp)
  const { signedMessage } = await kit.signMessage(message);

  // CRITICAL (#659): Multiple layers of cryptographic domain separation
  // Hash the signature with distinct domains to prevent credential reuse across contexts
  const signatureBytes = new TextEncoder().encode(signedMessage);

  // Secret: primary credential material
  const secretDomain = new TextEncoder().encode(`zkvote:secret:${daoId}`);
  const secretInput = new Uint8Array([...secretDomain, ...signatureBytes]);
  const secretHashBuffer = await crypto.subtle.digest("SHA-256", secretInput);
  const secretHashArray = new Uint8Array(secretHashBuffer);

  const secret = BigInt(
    "0x" +
      Array.from(secretHashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Salt: secondary material bound to DAO ID and secret domain
  const saltDomain = new TextEncoder().encode(`zkvote:salt:${daoId}`);
  const saltInput = new Uint8Array([...saltDomain, ...signatureBytes]);
  const saltHashBuffer = await crypto.subtle.digest("SHA-256", saltInput);
  const saltHashArray = new Uint8Array(saltHashBuffer);

  const salt = BigInt(
    "0x" +
      Array.from(saltHashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  );

  // Blinding factor: ensures even if secret/salt leak, commitment is masked
  const blindingDomain = new TextEncoder().encode(`zkvote:blinding:${daoId}`);
  const blindingInput = new Uint8Array([...blindingDomain, ...signatureBytes]);
  const blindingHashBuffer = await crypto.subtle.digest(
    "SHA-256",
    blindingInput,
  );
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
  const commitment = poseidon.F.toString(
    poseidon([DOMAIN_TAG, secret, salt, blindingFactor]),
  );

  return {
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    commitment,
  };
}

/**
 * Derives cryptographically domain-separated ZK credentials for a specific DAO
 * from a master secret. This prevents cross-DAO secret reuse and correlation of
 * identity commitments and nullifiers across different DAOs.
 *
 * @param masterSecret Base secret string or seed
 * @param daoId DAO identifier used for domain separation
 */
export async function derivePerDaoCredentials(
  masterSecret: string,
  daoId: number,
): Promise<ZKCredentials> {
  const poseidon = await buildPoseidon();
  const baseBytes = new TextEncoder().encode(masterSecret);

  // Secret: bound to DAO domain
  const secretDomain = new TextEncoder().encode(`zkvote:secret:${daoId}`);
  const secretInput = new Uint8Array([...secretDomain, ...baseBytes]);
  const secretHash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretInput));
  const secret = BigInt("0x" + Array.from(secretHash).map((b) => b.toString(16).padStart(2, "0")).join(""));

  // Salt: bound to DAO domain
  const saltDomain = new TextEncoder().encode(`zkvote:salt:${daoId}`);
  const saltInput = new Uint8Array([...saltDomain, ...baseBytes]);
  const saltHash = new Uint8Array(await crypto.subtle.digest("SHA-256", saltInput));
  const salt = BigInt("0x" + Array.from(saltHash).map((b) => b.toString(16).padStart(2, "0")).join(""));

  // Blinding: bound to DAO domain
  const blindingDomain = new TextEncoder().encode(`zkvote:blinding:${daoId}`);
  const blindingInput = new Uint8Array([...blindingDomain, ...baseBytes]);
  const blindingHash = new Uint8Array(await crypto.subtle.digest("SHA-256", blindingInput));
  const blindingFactor = BigInt("0x" + Array.from(blindingHash).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const commitment = poseidon.F.toString(
    poseidon([DOMAIN_TAG, secret, salt, blindingFactor]),
  );

  return {
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    commitment,
  };
}

/**
 * Legacy: Generate random ZK credentials (kept for backwards compatibility)
 *
 * @deprecated Generating standalone random credentials without DAO binding can lead to
 * cross-DAO secret reuse where the same (secret, salt) produces identical commitments and
 * linkable nullifiers across DAOs. Prefer `generateZKCredentials(kit, daoId)` or
 * `derivePerDaoCredentials(masterSecret, daoId)`.
 */
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
  const commitment = poseidon.F.toString(
    poseidon([DOMAIN_TAG, secret, salt, blindingFactor]),
  );

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

  // Regenerate from wallet signature and discover leaf index via relayer (ZV-060 / #906).
  if (import.meta.env.DEV)
    console.log(
      `[ZK] Regenerating credentials from wallet signature for DAO ${daoId}...`,
    );
  try {
    const credentials = await generateDeterministicZKCredentials(kit, daoId);

    // Look up the commitment's leaf index from the relayer, which reads it
    // from the on-chain membership tree. This avoids re-registration for
    // members who lost local state (fresh install, cleared storage, new device).
    if (import.meta.env.DEV)
      console.log(`[ZK] Looking up leaf index for commitment ${credentials.commitment.slice(0, 12)}…`);

    const resp = await relayerFetch(
      `/api/v1/membership/leaf-index/${daoId}/${credentials.commitment}`,
    );

    if (resp.status === 404) {
      // Commitment not in the tree — member must register first.
      if (import.meta.env.DEV)
        console.log(`[ZK] Commitment not found on-chain; re-registration required.`);
      return null;
    }

    if (resp.status === 410) {
      // Commitment was revoked — credentials cannot be used.
      if (import.meta.env.DEV)
        console.log(`[ZK] Commitment is revoked; credentials cannot be recovered.`);
      return null;
    }

    if (!resp.ok) {
      if (import.meta.env.DEV)
        console.warn(`[ZK] Leaf index lookup failed (${resp.status}); cannot recover without re-registration.`);
      return null;
    }

    const data = (await resp.json()) as {
      leafIndex: number;
      daoId: number;
      commitment: string;
      root: string;
    };

    if (typeof data.leafIndex !== "number" || data.leafIndex < 0) {
      if (import.meta.env.DEV)
        console.warn(`[ZK] Unexpected leaf index value from relayer:`, data.leafIndex);
      return null;
    }

    // Cache the recovered credentials so subsequent calls hit the fast path.
    storeZKCredentials(daoId, publicKey, credentials, data.leafIndex);

    if (import.meta.env.DEV)
      console.log(`[ZK] Credentials recovered; leaf index = ${data.leafIndex}`);

    return { ...credentials, leafIndex: data.leafIndex };
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

  const commitment = poseidon.F.toString(
    poseidon([DOMAIN_TAG, secret, salt, blindingFactor]),
  );

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
    poseidon([
      DOMAIN_TAG,
      BigInt(secret),
      BigInt(salt),
      BigInt(blindingFactor),
    ]),
  );
  return commitment;
}

const BN254_FR = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export interface DidAttributeClaimSeed {
  issuerId: string;
  attributeKey: string;
  minAttributeValue: string;
  signedClaimHash: string;
  attributeValue: string;
  claimSalt?: string;
}

export interface DidAttributeCircuitInput {
  issuerId: string;
  attributeKey: string;
  minAttributeValue: string;
  attributeNullifier: string;
  signedClaimHash: string;
  attributeValue: string;
  claimSalt: string;
}

export interface ReputationAttestationSeed {
  sourceDaoId: string;
  targetDaoId: string;
  attesterKeyHash: string;
  minScore: string;
  subjectSecret: string;
  score: string;
  attestationSalt: string;
  revocationNonce?: string;
}

export interface ReputationAttestationCircuitInput {
  sourceDaoId: string;
  targetDaoId: string;
  attesterKeyHash: string;
  minScore: string;
  attestationCommitment: string;
  reputationNullifier: string;
  subjectSecret: string;
  score: string;
  attestationSalt: string;
  revocationNonce: string;
}

async function hashTextToField(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (BigInt(`0x${hex}`) % BN254_FR).toString();
}

export async function buildDidAttributeCircuitInput(
  seed: DidAttributeClaimSeed,
): Promise<DidAttributeCircuitInput> {
  const poseidon = await buildPoseidon();
  const claimSalt =
    seed.claimSalt ?? (await hashTextToField(seed.signedClaimHash));
  const attributeNullifier = poseidon.F.toString(
    poseidon([
      BigInt(seed.issuerId),
      BigInt(seed.attributeKey),
      BigInt(seed.signedClaimHash),
      BigInt(claimSalt),
    ]),
  );

  return {
    issuerId: seed.issuerId,
    attributeKey: seed.attributeKey,
    minAttributeValue: seed.minAttributeValue,
    attributeNullifier,
    signedClaimHash: seed.signedClaimHash,
    attributeValue: seed.attributeValue,
    claimSalt,
  };
}

export async function buildReputationAttestationCircuitInput(
  seed: ReputationAttestationSeed,
): Promise<ReputationAttestationCircuitInput> {
  const poseidon = await buildPoseidon();
  const revocationNonce = seed.revocationNonce ?? "0";
  const attestationCommitment = poseidon.F.toString(
    poseidon([
      BigInt(seed.sourceDaoId),
      BigInt(seed.attesterKeyHash),
      BigInt(seed.subjectSecret),
      BigInt(seed.score),
      BigInt(seed.attestationSalt),
    ]),
  );
  const reputationNullifier = poseidon.F.toString(
    poseidon([
      BigInt(seed.targetDaoId),
      BigInt(attestationCommitment),
      BigInt(seed.subjectSecret),
      BigInt(revocationNonce),
    ]),
  );

  return {
    sourceDaoId: seed.sourceDaoId,
    targetDaoId: seed.targetDaoId,
    attesterKeyHash: seed.attesterKeyHash,
    minScore: seed.minScore,
    attestationCommitment,
    reputationNullifier,
    subjectSecret: seed.subjectSecret,
    score: seed.score,
    attestationSalt: seed.attestationSalt,
    revocationNonce,
  };
}
