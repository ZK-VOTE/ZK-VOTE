import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import nacl from "tweetnacl";
import {
  authorizeVote,
  canonicalVoteAuthPayload,
  seedVoteSigner,
  SponsoredVoteClient,
  VOTE_AUTH_DOMAIN,
  VOTE_AUTH_VERSION,
  type DigestFn,
  type VoteAuthorizationFields,
} from "./client";

const digest: DigestFn = async (data) =>
  new Uint8Array(
    await webcrypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer),
  );

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const signer = seedVoteSigner(seed);

const fields: VoteAuthorizationFields = {
  version: VOTE_AUTH_VERSION,
  domain: VOTE_AUTH_DOMAIN,
  chainId: "Test Network",
  daoId: 42,
  proposalId: 9,
  voter: signer.publicKey,
  nullifier: "cd".repeat(32),
  choice: 1,
  relayer: "GTESTRELAYER",
  expiry: Math.floor(Date.now() / 1000) + 60,
  nonce: "nonce-1",
  signerPublicKey: signer.publicKey,
};

function fakeFetch(status: number, body: Record<string, unknown>, headers: Record<string, string>) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("sponsored vote authorization SDK", () => {
  it("produces a canonical, domain-separated payload", () => {
    const payload = canonicalVoteAuthPayload(fields);
    expect(payload.startsWith("zkvote-vote-auth-canonical-v1|")).toBe(true);
    expect(payload).toContain(`${Buffer.byteLength(VOTE_AUTH_DOMAIN)}:${VOTE_AUTH_DOMAIN}`);
    expect(canonicalVoteAuthPayload({ ...fields, nonce: "nonce-2" })).not.toBe(payload);
  });

  it("signs a digest that verifies with the advertised public key", async () => {
    const auth = await authorizeVote(fields, signer, digest);
    const payload = new TextEncoder().encode(canonicalVoteAuthPayload(auth));
    const hash = await digest(payload);
    const signature = Uint8Array.from(atob(auth.signature), (c) => c.charCodeAt(0));
    // seedVoteSigner exposes a G-address; verify with tweetnacl's raw key.
    const rawKey = nacl.sign.keyPair.fromSeed(seed).publicKey;
    expect(nacl.sign.detached.verify(hash, signature, rawKey)).toBe(true);
  });

  it("reads quota headers on success", async () => {
    const client = new SponsoredVoteClient({
      baseUrl: "http://relayer.test",
      chainId: "Test Network",
      fetchImpl: fakeFetch(
        200,
        { success: true, txHash: "abc", feeStroops: 110000 },
        {
          "X-Sponsorship-Limit": "50000000",
          "X-Sponsorship-Remaining": "49989000",
          "X-Sponsorship-Reset": "1790083200",
          "X-RateLimit-Limit": "30",
          "X-RateLimit-Remaining": "29",
          "X-RateLimit-Reset": "1790000060",
        },
      ),
    });
    const result = await client.submit(fields, signer, digest);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe("abc");
    expect(result.sponsorship?.remainingStroops).toBe(49989000);
    expect(result.rateLimit?.remaining).toBe(29);
    expect(result.degraded).toBe(false);
  });

  it("treats RELAYER_RESERVE_LOW as graceful degradation, not an exception", async () => {
    const client = new SponsoredVoteClient({
      baseUrl: "http://relayer.test",
      chainId: "Test Network",
      fetchImpl: fakeFetch(
        503,
        { error: "reserve low", code: "RELAYER_RESERVE_LOW", retryable: true },
        { "Retry-After": "300", "X-Sponsorship-Remaining": "49989000" },
      ),
    });
    const result = await client.submit(fields, signer, digest);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.code).toBe("RELAYER_RESERVE_LOW");
    expect(result.retryAfterSeconds).toBe(300);
  });
});
