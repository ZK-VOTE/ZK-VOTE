/**
 * Admin Routes - Multisig & Role Management Tests
 *
 * Tests for DAO role assignment and multisig functionality.
 * Covers:
 * - Role assignment/revocation (Admin, Member, Auditor)
 * - Multisig initialization and configuration
 * - Multisig proposal creation and signing
 * - Multisig proposal execution
 */

import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../src/routes/admin.js";
import { log } from "../src/services/logger.js";

// Mock the auth middleware to simulate an authenticated user
const mockAuthGuard = (req: any, res: any, next: any) => {
  req.user = { address: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S" };
  next();
};

const mockQueryLimiter = (req: any, res: any, next: any) => next();
const mockBodyLimit = (size: string) => (req: any, res: any, next: any) => next();

describe("Admin Routes - Multisig & Roles", () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Patch middleware for testing
    app.use(mockAuthGuard);
    app.use(mockQueryLimiter);
    app.use(mockBodyLimit("100kb"));
    app.use("/admin", adminRouter);
  });

  describe("Role Management", () => {
    describe("POST /admin/dao/:daoId/roles", () => {
      it("should assign an Admin role", async () => {
        const res = await request(app)
          .post("/admin/dao/1/roles")
          .send({
            member: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
            role: 0, // Admin
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.role).toBe("Admin");
      });

      it("should assign a Member role", async () => {
        const res = await request(app)
          .post("/admin/dao/1/roles")
          .send({
            member: "GBXVJAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ",
            role: 1, // Member
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.role).toBe("Member");
      });

      it("should assign an Auditor role", async () => {
        const res = await request(app)
          .post("/admin/dao/1/roles")
          .send({
            member: "GDVVF5XSUMEWVXO3BG2PYVJZUGCZPHUVFIXZ2BG7SEIYK4QNQQVLYAY4",
            role: 2, // Auditor
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.role).toBe("Auditor");
      });

      it("should reject invalid role value", async () => {
        const res = await request(app)
          .post("/admin/dao/1/roles")
          .send({
            member: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
            role: 99, // Invalid
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("role must be");
      });

      it("should reject missing member address", async () => {
        const res = await request(app)
          .post("/admin/dao/1/roles")
          .send({ role: 0 });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("member");
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app)
          .post("/admin/dao/invalid/roles")
          .send({
            member: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
            role: 0,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("daoId");
      });
    });

    describe("GET /admin/dao/:daoId/roles/:member", () => {
      it("should retrieve a member's role", async () => {
        const res = await request(app).get(
          "/admin/dao/1/roles/GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
        );

        expect(res.status).toBe(200);
        expect(res.body.daoId).toBe(1);
        expect(res.body.member).toBeTruthy();
        expect("role" in res.body).toBe(true);
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app).get(
          "/admin/dao/invalid/roles/GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
        );

        expect(res.status).toBe(400);
      });
    });

    describe("DELETE /admin/dao/:daoId/roles/:member", () => {
      it("should revoke a member's role", async () => {
        const res = await request(app).delete(
          "/admin/dao/1/roles/GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
        );

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.message).toContain("revocation");
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app).delete(
          "/admin/dao/-1/roles/GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
        );

        expect(res.status).toBe(400);
      });
    });
  });

  describe("Multisig Management", () => {
    const testSigners = [
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
      "GBXVJAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ",
      "GDVVF5XSUMEWVXO3BG2PYVJZUGCZPHUVFIXZ2BG7SEIYK4QNQQVLYAY4",
    ];

    describe("POST /admin/dao/:daoId/multisig/config", () => {
      it("should initialize multisig with 3 signers and threshold 2", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/config")
          .send({
            signers: testSigners,
            threshold: 2,
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.signerCount).toBe(3);
        expect(res.body.threshold).toBe(2);
      });

      it("should reject empty signers array", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/config")
          .send({
            signers: [],
            threshold: 1,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("signers");
      });

      it("should reject threshold exceeding signer count", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/config")
          .send({
            signers: testSigners,
            threshold: 5, // More than 3 signers
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("threshold");
      });

      it("should reject zero threshold", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/config")
          .send({
            signers: testSigners,
            threshold: 0,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("threshold");
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app)
          .post("/admin/dao/invalid/multisig/config")
          .send({
            signers: testSigners,
            threshold: 2,
          });

        expect(res.status).toBe(400);
      });
    });

    describe("GET /admin/dao/:daoId/multisig/config", () => {
      it("should retrieve multisig configuration", async () => {
        const res = await request(app).get("/admin/dao/1/multisig/config");

        expect(res.status).toBe(200);
        expect(res.body.daoId).toBe(1);
        expect("signers" in res.body).toBe(true);
        expect("threshold" in res.body).toBe(true);
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app).get("/admin/dao/invalid/multisig/config");

        expect(res.status).toBe(400);
      });
    });

    describe("POST /admin/dao/:daoId/multisig/proposal", () => {
      it("should create a multisig proposal", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal")
          .send({
            title: "Transfer Admin Rights",
            description: "Propose transferring admin to new address",
            actionType: "TransferAdmin",
            actionData: "base64encodeddata",
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.proposalId).toBeTruthy();
        expect(res.body.actionType).toBe("TransferAdmin");
      });

      it("should support different action types", async () => {
        const actionTypes = ["SetRole", "UpdateMultisig", "RevokeRole"];

        for (const actionType of actionTypes) {
          const res = await request(app)
            .post("/admin/dao/1/multisig/proposal")
            .send({
              title: `Test ${actionType}`,
              description: "Test proposal",
              actionType,
              actionData: "data",
            });

          expect(res.status).toBe(200);
          expect(res.body.actionType).toBe(actionType);
        }
      });

      it("should reject missing title", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal")
          .send({
            description: "Missing title",
            actionType: "TransferAdmin",
            actionData: "data",
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("title");
      });

      it("should reject missing actionType", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal")
          .send({
            title: "Test",
            description: "Missing actionType",
            actionData: "data",
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("actionType");
      });

      it("should set proposal expiration to 7 days", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal")
          .send({
            title: "Test",
            description: "Test expiration",
            actionType: "TransferAdmin",
            actionData: "data",
          });

        expect(res.status).toBe(200);
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = res.body.expiresAt;
        const expectedExpiration = 7 * 24 * 60 * 60; // 7 days in seconds

        // Allow 5 second variance
        expect(expiresAt).toBeGreaterThanOrEqual(now + expectedExpiration - 5);
        expect(expiresAt).toBeLessThanOrEqual(now + expectedExpiration + 5);
      });
    });

    describe("POST /admin/dao/:daoId/multisig/proposal/:proposalId/sign", () => {
      it("should sign a multisig proposal", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal/1/sign");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.daoId).toBe(1);
        expect(res.body.proposalId).toBe(1);
        expect(res.body.signatureCount).toBeTruthy();
      });

      it("should reject invalid proposalId", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal/invalid/sign");

        expect(res.status).toBe(400);
      });

      it("should reject zero proposalId", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal/0/sign");

        expect(res.status).toBe(400);
      });
    });

    describe("POST /admin/dao/:daoId/multisig/proposal/:proposalId/execute", () => {
      it("should execute a multisig proposal", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal/1/execute");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
        expect(res.body.message).toContain("executed");
        expect(res.body.daoId).toBe(1);
        expect(res.body.proposalId).toBe(1);
      });

      it("should reject invalid daoId", async () => {
        const res = await request(app)
          .post("/admin/dao/invalid/multisig/proposal/1/execute");

        expect(res.status).toBe(400);
      });

      it("should reject invalid proposalId", async () => {
        const res = await request(app)
          .post("/admin/dao/1/multisig/proposal/invalid/execute");

        expect(res.status).toBe(400);
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle all role routes gracefully", async () => {
      const endpoints = [
        { method: "post", path: "/admin/dao/1/roles" },
        { method: "get", path: "/admin/dao/1/roles/ADDRESS" },
        { method: "delete", path: "/admin/dao/1/roles/ADDRESS" },
      ];

      for (const endpoint of endpoints) {
        const req = request(app)[endpoint.method as "get" | "post" | "delete"](endpoint.path);

        const res = await req;
        expect([200, 400, 500]).toContain(res.status);
      }
    });

    it("should handle all multisig routes gracefully", async () => {
      const endpoints = [
        { method: "post", path: "/admin/dao/1/multisig/config" },
        { method: "get", path: "/admin/dao/1/multisig/config" },
        { method: "post", path: "/admin/dao/1/multisig/proposal" },
        { method: "post", path: "/admin/dao/1/multisig/proposal/1/sign" },
        { method: "post", path: "/admin/dao/1/multisig/proposal/1/execute" },
      ];

      for (const endpoint of endpoints) {
        const req = request(app)[endpoint.method as "get" | "post"](endpoint.path);

        const res = await req;
        expect([200, 400, 500]).toContain(res.status);
      }
    });
  });

  describe("Input Validation", () => {
    it("should validate Stellar addresses in role assignment", async () => {
      const res = await request(app)
        .post("/admin/dao/1/roles")
        .send({
          member: "INVALID_ADDRESS",
          role: 0,
        });

      expect(res.status).toBe(400);
    });

    it("should handle null/undefined values gracefully", async () => {
      const res = await request(app)
        .post("/admin/dao/1/roles")
        .send({
          member: null,
          role: 0,
        });

      expect(res.status).toBe(400);
    });

    it("should handle empty request bodies", async () => {
      const res = await request(app)
        .post("/admin/dao/1/roles")
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
