/**
 * Scoped relay session tokens and encrypted relay metadata support.
 *
 * The relay is assumed to be honest-but-curious, so the session token must be
 * short-lived and bound to a specific DAO scope. Each token includes an Ed25519
 * signature over its payload so the relay can authenticate a client without
 * trusting a static shared secret alone.
 */

import crypto from "node:crypto";
import { config } from "../config.js";

export interface RelaySessionCapability {
  daoId?: number;
  actions?: string[];
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
  scope?: string;
}

export interface RelaySessionTokenPayload {
  jti: string;
  clientId: string;
  daoId?: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  capabilities: string[];
  publicKeyPem: string;
}

const SESSION_TOKEN_PREFIX = "relay_session";

function b64urlEncode(value: Buffer | string): string {
  const source = typeof value === "string" ? Buffer.from(value) : value;
  return source
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

export function createSignedSessionToken(
  clientId: string,
  privateKeyPem: string,
  options: {
    daoId?: number;
    nonce?: string;
    capabilities?: string[];
    ttlMs?: number;
  } = {},
): string {
  if (!clientId || !privateKeyPem) {
    throw new Error("clientId and signing private key are required");
  }

  const publicKey = crypto.createPublicKey(privateKeyPem);
  const publicKeyPem = crypto
    .createPublicKey(publicKey)
    .export({ type: "spki", format: "pem" })
    .toString();

  const issuedAt = Date.now();
  const expiresAt = issuedAt + (options.ttlMs ?? 5 * 60_000);
  const payload: RelaySessionTokenPayload = {
    jti: `sess_${crypto.randomBytes(8).toString("hex")}`,
    clientId,
    daoId: options.daoId,
    nonce: options.nonce ?? crypto.randomBytes(16).toString("hex"),
    issuedAt,
    expiresAt,
    capabilities: options.capabilities ?? ["relay:write"],
    publicKeyPem,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = b64urlEncode(payloadJson);
  const signature = crypto.sign(null, Buffer.from(payloadJson), privateKeyPem);
  const signatureEncoded = b64urlEncode(signature);
  return `${SESSION_TOKEN_PREFIX}.${payloadEncoded}.${signatureEncoded}`;
}

export function verifySignedSessionToken(
  sessionToken: string,
  expectedDaoId?: number,
): {
  valid: boolean;
  clientId?: string;
  daoId?: number;
  tokenId?: string;
  reason?: string;
} {
  if (!sessionToken || typeof sessionToken !== "string") {
    return { valid: false, reason: "missing_session_token" };
  }

  const parts = sessionToken.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) {
    return { valid: false, reason: "malformed_session_token" };
  }

  try {
    const payloadJson = b64urlDecode(parts[1]).toString("utf-8");
    const payload = JSON.parse(payloadJson) as RelaySessionTokenPayload;
    const signature = b64urlDecode(parts[2]);

    if (!payload.clientId || !payload.publicKeyPem) {
      return { valid: false, reason: "session_missing_identity" };
    }

    if (payload.expiresAt <= Date.now()) {
      return {
        valid: false,
        reason: "session_expired",
        clientId: payload.clientId,
        daoId: payload.daoId,
        tokenId: payload.jti,
      };
    }

    if (
      expectedDaoId !== undefined &&
      payload.daoId !== undefined &&
      expectedDaoId !== payload.daoId
    ) {
      return {
        valid: false,
        reason: "dao_scope_mismatch",
        clientId: payload.clientId,
        daoId: payload.daoId,
        tokenId: payload.jti,
      };
    }

    if (expectedDaoId !== undefined && payload.daoId === undefined) {
      return {
        valid: false,
        reason: "dao_scope_required",
        clientId: payload.clientId,
        tokenId: payload.jti,
      };
    }

    if (!payload.capabilities || payload.capabilities.length === 0) {
      return {
        valid: false,
        reason: "session_missing_capabilities",
        clientId: payload.clientId,
        daoId: payload.daoId,
        tokenId: payload.jti,
      };
    }

    const publicKey = crypto.createPublicKey(payload.publicKeyPem);
    const ok = crypto.verify(
      null,
      Buffer.from(payloadJson),
      publicKey,
      signature,
    );
    if (!ok) {
      return {
        valid: false,
        reason: "invalid_session_signature",
        clientId: payload.clientId,
        daoId: payload.daoId,
        tokenId: payload.jti,
      };
    }

    return {
      valid: true,
      clientId: payload.clientId,
      daoId: payload.daoId,
      tokenId: payload.jti,
    };
  } catch {
    return { valid: false, reason: "session_token_parse_failed" };
  }
}

export function getDefaultSessionSigningKey(): string | null {
  const key =
    config.relayerSecretKey ||
    process.env.RELAY_SESSION_PRIVATE_KEY ||
    process.env.RELAYER_SESSION_PRIVATE_KEY;
  if (!key) return null;
  try {
    const keyObj = crypto.createPrivateKey(key);
    return keyObj.export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    return null;
  }
}

export function generateSessionSigningKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
