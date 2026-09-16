/**
 * E2E Encrypted Governance Content API (#324)
 *
 * `/api/v1/encryption` — key-epoch distribution and the ciphertext store for
 * proposal and comment bodies.
 *
 * Every handler is deliberately incapable of reading what it moves. Key
 * material arrives already sealed to its recipient, bodies arrive as complete
 * AES-GCM envelopes, and no route accepts a plaintext or a raw group key. If a
 * request could hand the relay something it could decrypt, that would be the
 * bug — not a convenience.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=encryption.d.ts.map