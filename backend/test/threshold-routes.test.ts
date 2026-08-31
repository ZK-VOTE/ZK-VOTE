import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import thresholdRouter from "../src/routes/threshold.js";

let app: express.Express;
let server: Server;
let baseUrl: string;

function createTestApp(): express.Express {
  const testApp = express();
  testApp.use(express.json());
  testApp.use(thresholdRouter);
  return testApp;
}

async function req(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, options);
  const data = await res.json();
  return { status: res.status, body: data as Record<string, unknown> };
}

describe("Threshold Routes", () => {
  before(async () => {
    app = createTestApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("POST /threshold/init", () => {
    it("should initialize DKG", async () => {
      const res = await req("POST", "/threshold/init", {
        daoId: 10,
        proposalId: 20,
        thresholdN: 3,
        thresholdT: 2,
        creator: "creator-addr",
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.round);
    });

    it("should return error for missing params", async () => {
      const res = await req("POST", "/threshold/init", {});
      assert.strictEqual(res.status, 400);
    });
  });

  describe("POST /threshold/authority/register", () => {
    it("should register an authority", async () => {
      await req("POST", "/threshold/init", {
        daoId: 11,
        proposalId: 21,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      const res = await req("POST", "/threshold/authority/register", {
        daoId: 11,
        proposalId: 21,
        authorityAddress: "auth-addr-1",
        authorityName: "Auth 1",
        verifierId: "verifier-1",
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(typeof res.body.authorityAddress === "string");
    });
  });

  describe("POST /threshold/dkg/finalize", () => {
    it("should finalize DKG", async () => {
      const daoId = 12;
      const proposalId = 22;
      await req("POST", "/threshold/init", {
        daoId,
        proposalId,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a1",
        authorityName: "A1",
        verifierId: "v1",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a2",
        authorityName: "A2",
        verifierId: "v2",
      });
      const res = await req("POST", "/threshold/dkg/finalize", {
        daoId,
        proposalId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.jointPublicKey);
    });

    it("should fail for nonexistent round", async () => {
      const res = await req("POST", "/threshold/dkg/finalize", {
        daoId: 999,
        proposalId: 999,
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe("POST /threshold/vote/encrypt", () => {
    it("should encrypt a vote after DKG", async () => {
      const daoId = 13;
      const proposalId = 23;
      await req("POST", "/threshold/init", {
        daoId,
        proposalId,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a1",
        authorityName: "A1",
        verifierId: "v1",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a2",
        authorityName: "A2",
        verifierId: "v2",
      });
      await req("POST", "/threshold/dkg/finalize", { daoId, proposalId });
      const res = await req("POST", "/threshold/vote/encrypt", {
        daoId,
        proposalId,
        voteChoice: 1,
        voterNullifier: "null-1",
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.ciphertext);
    });
  });

  describe("POST /threshold/tally/compute", () => {
    it("should compute encrypted tally", async () => {
      const daoId = 14;
      const proposalId = 24;
      await req("POST", "/threshold/init", {
        daoId,
        proposalId,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a1",
        authorityName: "A1",
        verifierId: "v1",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a2",
        authorityName: "A2",
        verifierId: "v2",
      });
      await req("POST", "/threshold/dkg/finalize", { daoId, proposalId });
      await req("POST", "/threshold/vote/encrypt", {
        daoId,
        proposalId,
        voteChoice: 1,
        voterNullifier: "null-1",
      });
      const res = await req("POST", "/threshold/tally/compute", {
        daoId,
        proposalId,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.encryptedTally);
    });

    it("should fail with no votes", async () => {
      const daoId = 15;
      const proposalId = 25;
      await req("POST", "/threshold/init", {
        daoId,
        proposalId,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a1",
        authorityName: "A1",
        verifierId: "v1",
      });
      await req("POST", "/threshold/authority/register", {
        daoId,
        proposalId,
        authorityAddress: "a2",
        authorityName: "A2",
        verifierId: "v2",
      });
      await req("POST", "/threshold/dkg/finalize", { daoId, proposalId });
      const res = await req("POST", "/threshold/tally/compute", {
        daoId,
        proposalId,
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe("GET /threshold/state/:daoId/:proposalId", () => {
    it("should return protocol state", async () => {
      const daoId = 16;
      const proposalId = 26;
      await req("POST", "/threshold/init", {
        daoId,
        proposalId,
        thresholdN: 2,
        thresholdT: 1,
        creator: "creator",
      });
      const res = await req("GET", `/threshold/state/${daoId}/${proposalId}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.state);
    });
  });

  describe("GET /threshold/status", () => {
    it("should return system status", async () => {
      const res = await req("GET", "/threshold/status");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.status, "operational");
    });
  });
});
