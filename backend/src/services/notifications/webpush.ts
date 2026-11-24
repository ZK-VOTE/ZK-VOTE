/**
 * WebPush without a third-party library (ZV-037 / #886).
 *
 * - Payload encryption: RFC 8291 (Message Encryption for Web Push) with the
 *   `aes128gcm` content coding of RFC 8188, single record.
 * - Sender identity: RFC 8292 VAPID, an ES256 JWT bound to the push service's
 *   origin.
 *
 * Everything uses node:crypto (P-256 ECDH, HKDF-SHA-256, AES-128-GCM, ECDSA).
 */
import crypto from "node:crypto";
import type { WebPushSubscription } from "./types.js";

const RECORD_SIZE = 4096;

/** Any byte view (Buffer or Uint8Array): their typings disagree under newer TypeScript. */
type Bytes = { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };

export const b64url = {
  encode: (buf: Bytes): string => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64url"),
  decode: (value: string): Buffer => Buffer.from(value, "base64url"),
};

/** node:crypto's typings want plain Uint8Array views; Buffers are, at run time. */
const u8 = (buf: Bytes): Uint8Array => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
const concat = (...parts: Bytes[]): Buffer => Buffer.concat(parts.map(u8));

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string;
  /** P-256 private scalar (32 bytes), base64url. */
  privateKey: string;
  /** `mailto:` or `https:` contact for the push service operator. */
  subject: string;
}

/** Generates a VAPID key pair in the base64url form browsers and this module use. */
export function generateVapidKeys(subject = "mailto:ops@zkvote.local"): VapidKeys {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64url.encode(ecdh.getPublicKey()),
    privateKey: b64url.encode(ecdh.getPrivateKey()),
    subject,
  };
}

/** Validates the shape of a browser PushSubscription before it is stored. */
export function parseWebPushSubscription(value: unknown): WebPushSubscription {
  const sub = typeof value === "string" ? JSON.parse(value) : value;
  if (!sub || typeof sub !== "object") throw new Error("subscription must be an object");
  const { endpoint, keys } = sub as Partial<WebPushSubscription>;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    throw new Error("subscription.endpoint must be an https URL");
  }
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    throw new Error("subscription.keys.p256dh and subscription.keys.auth are required");
  }
  if (b64url.decode(keys.p256dh).length !== 65 || b64url.decode(keys.auth).length !== 16) {
    throw new Error("subscription keys have the wrong length");
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * RFC 8291 §3.3–3.4: IKM from the ECDH secret and the auth secret, then the
 * content-encryption key and nonce from IKM and the salt (RFC 8188 §2.2).
 */
function deriveKeys(
  sharedSecret: Bytes,
  authSecret: Bytes,
  uaPublic: Bytes,
  asPublic: Bytes,
  salt: Bytes,
): { cek: Buffer; nonce: Buffer } {
  const hkdf = (ikm: Bytes, s: Bytes, info: Bytes, length: number): Buffer =>
    Buffer.from(crypto.hkdfSync("sha256", u8(ikm), u8(s), u8(info), length));
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const ikm = hkdf(sharedSecret, authSecret, concat(Buffer.from("WebPush: info\0"), uaPublic, asPublic), 32);
  return {
    cek: hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
    nonce: hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  };
}

/**
 * Encrypts `plaintext` for one subscription (RFC 8291 §3.4, RFC 8188 §2).
 * Returns the full request body: header (salt, rs, keyid) followed by the record.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscription: WebPushSubscription,
  options: { salt?: Buffer; senderKeys?: crypto.ECDH } = {},
): Buffer {
  const uaPublic = b64url.decode(subscription.keys.p256dh);
  const authSecret = b64url.decode(subscription.keys.auth);
  const sender = options.senderKeys ?? crypto.createECDH("prime256v1");
  if (!options.senderKeys) sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(u8(uaPublic));
  const salt = options.salt ?? crypto.randomBytes(16);
  const { cek, nonce } = deriveKeys(sharedSecret, authSecret, uaPublic, asPublic, salt);

  // Single record: plaintext, then the 0x02 last-record delimiter.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload too large");
  const cipher = crypto.createCipheriv("aes-128-gcm", u8(cek), u8(nonce));
  const record = concat(cipher.update(u8(concat(plaintext, Buffer.from([2])))), cipher.final(), cipher.getAuthTag());

  const header = Buffer.alloc(16 + 4 + 1);
  header.set(u8(salt), 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return concat(header, asPublic, record);
}

/**
 * Reverses {@link encryptPayload} with the subscriber's private key. Used by
 * the tests as an independent check of the RFC 8291 derivation.
 */
export function decryptPayload(body: Buffer, uaPrivate: crypto.ECDH, authSecret: Bytes): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const sharedSecret = uaPrivate.computeSecret(u8(asPublic));
  const { cek, nonce } = deriveKeys(sharedSecret, authSecret, uaPrivate.getPublicKey(), asPublic, salt);
  const decipher = crypto.createDecipheriv("aes-128-gcm", u8(cek), u8(nonce));
  decipher.setAuthTag(u8(record.subarray(record.length - 16)));
  const padded = concat(decipher.update(u8(record.subarray(0, record.length - 16))), decipher.final());
  const delimiter = padded.lastIndexOf(2);
  return padded.subarray(0, delimiter);
}

function vapidPrivateKey(keys: VapidKeys): crypto.KeyObject {
  const publicKey = b64url.decode(keys.publicKey);
  return crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url.encode(publicKey.subarray(1, 33)),
      y: b64url.encode(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/** Builds the RFC 8292 `Authorization: vapid t=…, k=…` header for `endpoint`. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const header = b64url.encode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url.encode(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: keys.subject }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("sha256", u8(Buffer.from(signingInput)), {
    key: vapidPrivateKey(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${b64url.encode(signature)}, k=${keys.publicKey}`;
}
