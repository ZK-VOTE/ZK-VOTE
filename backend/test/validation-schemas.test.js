/**
 * Shared Validation Schema Tests
 *
 * Field-bound checks for every schema centralized in validation/schemas.ts.
 * These cover the schemas that used to live inside individual route files
 * (bridge, circuits, auth, quadratic) plus the ones newly applied to the
 * nova, threshold, admin, and remediation routes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bridgeVoteSchema,
  circuitParamsSchema,
  createTokenSchema,
  tokenIdSchema,
  clientIdQuerySchema,
  auditQuerySchema,
  didAttributeClaimSchema,
  qvAllocationSchema,
  qvCalculateSchema,
  qvTallySchema,
  qvParamsSchema,
  novaAggregateSchema,
  novaWitnessSchema,
  thresholdInitSchema,
  thresholdAuthorityRegisterSchema,
  thresholdFinalizeSchema,
  thresholdEncryptSchema,
  thresholdTallyComputeSchema,
  thresholdDecryptShareSchema,
  thresholdTallyDecryptSchema,
  thresholdStateParamsSchema,
  adminShutdownSchema,
  adminAuditLogQuerySchema,
  adminSbtTransferAttemptsQuerySchema,
  remediationHistoryQuerySchema,
} from "../src/validation/schemas.js";

const TWO_G1 = "0x" + "11".repeat(64); // 128 hex chars
const TWO_G2 = "0x" + "22".repeat(128); // 256 hex chars
const C_G1 = "0x" + "05".repeat(64); // 128 hex chars

const validBridgeVote = {
  daoId: 1,
  proposalId: 2,
  voteChoice: 1,
  nullifier: "0x1234",
  voteRoot: "0xabcd",
  sbtRoot: "0xef00",
  proof: { a: TWO_G1, b: TWO_G2, c: C_G1 },
};

describe("bridgeVoteSchema", () => {
  it("accepts a valid bridge vote payload", () => {
    const result = bridgeVoteSchema.safeParse(validBridgeVote);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("rejects a daoId that is not a positive integer", () => {
    for (const daoId of [0, -1, 1.5, "abc"]) {
      const result = bridgeVoteSchema.safeParse({ ...validBridgeVote, daoId });
      assert.equal(result.success, false, `daoId=${daoId} should be rejected`);
    }
  });

  it("rejects a voteChoice outside [0, 1]", () => {
    for (const voteChoice of [-1, 2]) {
      const result = bridgeVoteSchema.safeParse({
        ...validBridgeVote,
        voteChoice,
      });
      assert.equal(
        result.success,
        false,
        `voteChoice=${voteChoice} should be rejected`,
      );
    }
  });

  it("rejects a nullifier without the 0x prefix", () => {
    const result = bridgeVoteSchema.safeParse({
      ...validBridgeVote,
      nullifier: "1234",
    });
    assert.equal(result.success, false);
  });

  it("rejects a nullifier longer than 64 hex chars", () => {
    const result = bridgeVoteSchema.safeParse({
      ...validBridgeVote,
      nullifier: "0x" + "a".repeat(65),
    });
    assert.equal(result.success, false);
  });

  it("rejects a malformed proof coordinate", () => {
    const proof = { a: "0x00", b: TWO_G2, c: C_G1 };
    const result = bridgeVoteSchema.safeParse({ ...validBridgeVote, proof });
    assert.equal(result.success, false);
  });
});

describe("circuitParamsSchema", () => {
  it("accepts a numeric dao and a valid circuit type", () => {
    for (const type of ["comment", "vote"]) {
      const result = circuitParamsSchema.safeParse({ dao: "7", type });
      assert.ok(result.success, JSON.stringify(result.error?.issues));
    }
  });

  it("coerces the dao string to a number", () => {
    const result = circuitParamsSchema.safeParse({ dao: "7", type: "vote" });
    assert.equal(result.success, true);
    assert.equal(result.data.dao, 7);
  });

  it("rejects a non-positive dao", () => {
    for (const dao of ["0", "-1", "abc"]) {
      const result = circuitParamsSchema.safeParse({ dao, type: "vote" });
      assert.equal(result.success, false, `dao=${dao} should be rejected`);
    }
  });

  it("rejects an invalid circuit type", () => {
    const result = circuitParamsSchema.safeParse({ dao: "7", type: "invalid" });
    assert.equal(result.success, false);
  });
});

describe("auth token schemas", () => {
  it("createTokenSchema accepts a minimal valid body", () => {
    const result = createTokenSchema.safeParse({ clientId: "relayer-cli" });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("createTokenSchema accepts optional description and lifetimeMs", () => {
    const result = createTokenSchema.safeParse({
      clientId: "relayer-cli",
      description: "service token",
      lifetimeMs: 3600000,
    });
    assert.ok(result.success);
    assert.equal(result.data.lifetimeMs, 3600000);
  });

  it("createTokenSchema rejects non-positive lifetimeMs", () => {
    const result = createTokenSchema.safeParse({
      clientId: "relayer-cli",
      lifetimeMs: 0,
    });
    assert.equal(result.success, false);
  });

  it("createTokenSchema rejects an empty clientId", () => {
    const result = createTokenSchema.safeParse({ clientId: "" });
    assert.equal(result.success, false);
  });

  it("tokenIdSchema accepts a token id and rejects an empty one", () => {
    assert.equal(tokenIdSchema.safeParse({ tokenId: "tok_123" }).success, true);
    assert.equal(tokenIdSchema.safeParse({ tokenId: "" }).success, false);
  });

  it("didAttributeClaimSchema accepts a valid claim", () => {
    const result = didAttributeClaimSchema.safeParse({
      claim: {
        issuer: "issuer-1",
        subjectDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        attributeKey: "verified_email",
        attributeValue: 1,
        issuedAt: 1700000000,
        expiresAt: 1800000000,
        signature: "0x01020304050607",
      },
      minAttributeValue: 1,
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("didAttributeClaimSchema rejects a negative attributeValue", () => {
    const claim = {
      issuer: "issuer-1",
      subjectDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      attributeKey: "verified_email",
      attributeValue: -1,
      issuedAt: 1700000000,
      expiresAt: 1800000000,
      signature: "0x01020304050607",
    };
    assert.equal(
      didAttributeClaimSchema.safeParse({ claim, minAttributeValue: 0 })
        .success,
      false,
    );
  });
});

describe("auth query schemas", () => {
  it("clientIdQuerySchema transforms activeOnly into a boolean", () => {
    assert.deepEqual(clientIdQuerySchema.parse({ activeOnly: "true" }), {
      activeOnly: true,
    });
    assert.deepEqual(clientIdQuerySchema.parse({ activeOnly: "false" }), {
      activeOnly: false,
    });
    assert.deepEqual(clientIdQuerySchema.parse({}), { activeOnly: false });
  });

  it("auditQuerySchema caps limit at 1000", () => {
    const result = auditQuerySchema.parse({ limit: "99999" });
    assert.equal(result.limit, 1000);
    assert.equal(result.offset, 0);
  });

  it("auditQuerySchema falls back to 100 for an unparseable limit", () => {
    const result = auditQuerySchema.parse({ limit: "abc" });
    assert.equal(result.limit, 100);
  });
});

describe("quadratic voting schemas", () => {
  it("qvAllocationSchema rejects voice credits outside [0, 10]", () => {
    assert.equal(
      qvAllocationSchema.safeParse({ proposalId: 1, voiceCredits: 11 }).success,
      false,
    );
    assert.equal(
      qvAllocationSchema.safeParse({ proposalId: 1, voiceCredits: -1 }).success,
      false,
    );
    assert.equal(
      qvAllocationSchema.safeParse({ proposalId: 1, voiceCredits: 10 }).success,
      true,
    );
  });

  it("qvCalculateSchema accepts a valid allocation set", () => {
    const result = qvCalculateSchema.safeParse({
      allocations: [
        { proposalId: 1, voiceCredits: 4 },
        { proposalId: 2, voiceCredits: 3 },
      ],
      budget: 100,
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("qvCalculateSchema rejects an empty allocation set", () => {
    const result = qvCalculateSchema.safeParse({ allocations: [] });
    assert.equal(result.success, false);
  });

  it("qvCalculateSchema rejects a budget over the max", () => {
    const result = qvCalculateSchema.safeParse({
      allocations: [{ proposalId: 1, voiceCredits: 1 }],
      budget: 101,
    });
    assert.equal(result.success, false);
  });

  it("qvTallySchema accepts one or more ballots", () => {
    const result = qvTallySchema.safeParse({
      ballots: [
        { allocations: [{ proposalId: 1, voiceCredits: 2 }] },
        { allocations: [{ proposalId: 2, voiceCredits: 5 }] },
      ],
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("qvTallySchema rejects ballots without allocations", () => {
    const result = qvTallySchema.safeParse({ ballots: [{}] });
    assert.equal(result.success, false);
  });

  it("qvParamsSchema only accepts a numeric dao string", () => {
    assert.equal(qvParamsSchema.safeParse({ dao: "123" }).success, true);
    assert.equal(qvParamsSchema.safeParse({ dao: "12a" }).success, false);
    assert.equal(qvParamsSchema.safeParse({ dao: "" }).success, false);
  });
});

describe("nova aggregation schemas", () => {
  const validWitness = {
    secret: "0x01",
    salt: "0x02",
    path_elements: ["0x03", "0x04"],
    path_indices: [0, 1],
    vote_choice: 1,
    nullifier: "0x05",
    dao_id: 1,
    proposal_id: 2,
  };

  it("novaWitnessSchema accepts a valid witness", () => {
    assert.ok(novaWitnessSchema.safeParse(validWitness).success);
  });

  it("novaWitnessSchema rejects an out-of-range vote_choice", () => {
    assert.equal(
      novaWitnessSchema.safeParse({ ...validWitness, vote_choice: 2 }).success,
      false,
    );
  });

  it("novaWitnessSchema rejects a negative path index", () => {
    assert.equal(
      novaWitnessSchema.safeParse({ ...validWitness, path_indices: [-1] })
        .success,
      false,
    );
  });

  it("novaAggregateSchema accepts a valid payload", () => {
    const result = novaAggregateSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      root: "0x00",
      witnesses: [validWitness],
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("novaAggregateSchema accepts a missing root", () => {
    const result = novaAggregateSchema.safeParse({
      daoId: "1",
      proposalId: "2",
      witnesses: [validWitness],
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.equal(result.data.daoId, 1);
  });

  it("novaAggregateSchema rejects a non-array witnesses field", () => {
    const result = novaAggregateSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      witnesses: "not-an-array",
    });
    assert.equal(result.success, false);
  });

  it("novaAggregateSchema rejects a non-hex root", () => {
    const result = novaAggregateSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      root: "zzzz",
      witnesses: [validWitness],
    });
    assert.equal(result.success, false);
  });
});

describe("threshold decryption schemas", () => {
  const ciphertext = { c1: "0x0102", c2: "0x0304" };

  it("thresholdInitSchema accepts a valid init body", () => {
    const result = thresholdInitSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      thresholdN: 5,
      thresholdT: 3,
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("thresholdInitSchema coerces string numbers", () => {
    const result = thresholdInitSchema.safeParse({
      daoId: "1",
      proposalId: "2",
      thresholdN: "5",
      thresholdT: "3",
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
    assert.equal(result.data.thresholdN, 5);
  });

  it("thresholdInitSchema rejects a non-positive threshold", () => {
    for (const thresholdT of [0, -1]) {
      const result = thresholdInitSchema.safeParse({
        daoId: 1,
        proposalId: 2,
        thresholdN: 5,
        thresholdT,
      });
      assert.equal(
        result.success,
        false,
        `thresholdT=${thresholdT} should be rejected`,
      );
    }
  });

  it("thresholdAuthorityRegisterSchema requires an authority name", () => {
    const base = {
      daoId: 1,
      proposalId: 2,
      authorityAddress: "GAUTHORITY",
      verifierId: "BN254-verifier-1234",
    };
    assert.equal(
      thresholdAuthorityRegisterSchema.safeParse({
        ...base,
        authorityName: "alice",
      }).success,
      true,
    );
    assert.equal(
      thresholdAuthorityRegisterSchema.safeParse({ ...base, authorityName: "" })
        .success,
      false,
    );
  });

  it("thresholdFinalizeSchema accepts daoId and proposalId", () => {
    assert.equal(
      thresholdFinalizeSchema.safeParse({ daoId: 1, proposalId: 2 }).success,
      true,
    );
    assert.equal(
      thresholdFinalizeSchema.safeParse({ daoId: 1 }).success,
      false,
    );
  });

  it("thresholdEncryptSchema bounds voteChoice to 0 or 1", () => {
    const base = { daoId: 1, proposalId: 2, voterNullifier: "0x01" };
    assert.equal(
      thresholdEncryptSchema.safeParse({ ...base, voteChoice: 1 }).success,
      true,
    );
    assert.equal(
      thresholdEncryptSchema.safeParse({ ...base, voteChoice: 2 }).success,
      false,
    );
  });

  it("thresholdTallyComputeSchema accepts daoId and proposalId", () => {
    assert.equal(
      thresholdTallyComputeSchema.safeParse({ daoId: 1, proposalId: 2 })
        .success,
      true,
    );
  });

  it("thresholdDecryptShareSchema accepts a decimal private key share", () => {
    const result = thresholdDecryptShareSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      authorityAddress: "GAUTHORITY",
      privateKeyShare: "12345678901234567890",
      encryptedTally: ciphertext,
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("thresholdDecryptShareSchema rejects a non-integer private key share", () => {
    const result = thresholdDecryptShareSchema.safeParse({
      daoId: 1,
      proposalId: 2,
      authorityAddress: "GAUTHORITY",
      privateKeyShare: "12.5",
      encryptedTally: ciphertext,
    });
    assert.equal(result.success, false);
  });

  it("thresholdTallyDecryptSchema requires a ciphertext", () => {
    assert.equal(
      thresholdTallyDecryptSchema.safeParse({
        daoId: 1,
        proposalId: 2,
        encryptedTally: ciphertext,
      }).success,
      true,
    );
    assert.equal(
      thresholdTallyDecryptSchema.safeParse({ daoId: 1, proposalId: 2 })
        .success,
      false,
    );
  });

  it("thresholdStateParamsSchema validates positive integer params", () => {
    assert.equal(
      thresholdStateParamsSchema.safeParse({ daoId: "1", proposalId: "2" })
        .success,
      true,
    );
    assert.equal(
      thresholdStateParamsSchema.safeParse({ daoId: "0", proposalId: "2" })
        .success,
      false,
    );
  });
});

describe("admin schemas", () => {
  it("adminShutdownSchema accepts a reason and rejects non-strings", () => {
    assert.equal(adminShutdownSchema.safeParse({}).success, true);
    assert.equal(
      adminShutdownSchema.safeParse({ reason: "maintenance" }).success,
      true,
    );
    assert.equal(adminShutdownSchema.safeParse({ reason: 42 }).success, false);
  });

  it("adminAuditLogQuerySchema applies defaults", () => {
    const result = adminAuditLogQuerySchema.parse({});
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
    assert.equal(result.format, "json");
  });

  it("adminAuditLogQuerySchema coerces limit and offset", () => {
    const result = adminAuditLogQuerySchema.parse({
      limit: "25",
      offset: "10",
    });
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 10);
  });

  it("adminAuditLogQuerySchema caps limit at 500", () => {
    assert.equal(
      adminAuditLogQuerySchema.safeParse({ limit: "9999" }).success,
      false,
    );
  });

  it("adminAuditLogQuerySchema rejects an unknown format", () => {
    assert.equal(
      adminAuditLogQuerySchema.safeParse({ format: "xml" }).success,
      false,
    );
  });

  it("adminSbtTransferAttemptsQuerySchema requires a positive daoId", () => {
    assert.equal(
      adminSbtTransferAttemptsQuerySchema.safeParse({ daoId: "42" }).success,
      true,
    );
    assert.equal(
      adminSbtTransferAttemptsQuerySchema.safeParse({}).success,
      false,
    );
    assert.equal(
      adminSbtTransferAttemptsQuerySchema.safeParse({ daoId: "0" }).success,
      false,
    );
  });
});

describe("remediationHistoryQuerySchema", () => {
  it("defaults the limit to 50", () => {
    assert.equal(remediationHistoryQuerySchema.parse({}).limit, 50);
  });

  it("coerces a numeric limit", () => {
    assert.equal(
      remediationHistoryQuerySchema.parse({ limit: "10" }).limit,
      10,
    );
  });

  it("rejects a non-positive or oversized limit", () => {
    assert.equal(
      remediationHistoryQuerySchema.safeParse({ limit: "0" }).success,
      false,
    );
    assert.equal(
      remediationHistoryQuerySchema.safeParse({ limit: "1001" }).success,
      false,
    );
  });
});
