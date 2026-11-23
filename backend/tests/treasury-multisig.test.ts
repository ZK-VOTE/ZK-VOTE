/**
 * Treasury multisig signing sessions (ZV-039 / #888).
 *
 * The on-chain rules are tested in contracts/threshold-crypto/src/treasury_test.rs;
 * this covers the off-chain coordination: signatures bound to the proposal's
 * digest and expiry, the contract's threshold rule (dual control for large
 * spends, current threshold for rotations), no replay, and the audit trail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as StellarSdk from "@stellar/stellar-sdk";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-treasury-"));
const { initDb, getDb } = await import("../src/services/db.ts");
initDb(path.join(TEST_DIR, "treasury.db"));
const { TreasuryMultisig, TreasuryMultisigError, approvalMessage, signSep53, requiredApprovals } = await import(
  "../src/services/treasury-multisig.ts"
);
const { getAuditLogs, verifyAuditChain } = await import("../src/services/audit.ts");

const signers = [StellarSdk.Keypair.random(), StellarSdk.Keypair.random(), StellarSdk.Keypair.random()];
const outsider = StellarSdk.Keypair.random();
const config = { signers: signers.map((k) => k.publicKey()), threshold: 2, largeAmount: "1000", largeThreshold: 3 };
const TOKEN = StellarSdk.StrKey.encodeContract(crypto.randomBytes(32));
const PAYEE = StellarSdk.Keypair.random().publicKey();
const NOW = Math.floor(Date.now() / 1000);

const service = new TreasuryMultisig();
let nextProposal = 1;

function open(amount = "500", expiresAt = NOW + 3600) {
  const proposalId = nextProposal++;
  const digest = crypto.randomBytes(32).toString("hex");
  return service.open(
    { proposalId, digest, expiresAt, action: { kind: "spend", token: TOKEN, to: PAYEE, amount }, config },
    { actor: "test-admin" },
  );
}

const sign = (session: { proposalId: number; digest: string; expiresAt: number }, keypair: StellarSdk.Keypair) =>
  signSep53(keypair, approvalMessage(session.proposalId, session.digest, session.expiresAt));

function rejects(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof TreasuryMultisigError && err.code === code);
}

test("end to end: propose, collect signatures, execute, audit", () => {
  const session = open("500");
  assert.equal(session.required, 2);
  assert.equal(session.status, "collecting");

  let updated = service.sign(session.id, signers[0].publicKey(), sign(session, signers[0]));
  assert.equal(updated.status, "collecting");
  rejects(() => service.markExecuted(session.id, "a".repeat(64)), "insufficient_signatures");

  updated = service.sign(session.id, signers[1].publicKey(), sign(session, signers[1]));
  assert.equal(updated.status, "ready");

  const executed = service.markExecuted(session.id, "b".repeat(64), { actor: "test-admin" });
  assert.equal(executed.status, "executed");
  assert.equal(executed.stellarTxHash, "b".repeat(64));

  const actions = getAuditLogs({ limit: 50 }).logs
    .filter((r: { params: string | null }) => r.params?.includes(session.id))
    .map((r: { action: string }) => r.action);
  for (const action of ["treasury.session.opened", "treasury.session.signed", "treasury.session.ready", "treasury.spend.executed"]) {
    assert.ok(actions.includes(action), `${action} audited`);
  }
  assert.equal(verifyAuditChain().valid, true, "the audit log stays hash-chained");
});

test("an executed proposal cannot be executed again", () => {
  const session = open("10");
  service.sign(session.id, signers[0].publicKey(), sign(session, signers[0]));
  service.sign(session.id, signers[2].publicKey(), sign(session, signers[2]));
  service.markExecuted(session.id, "c".repeat(64));
  rejects(() => service.markExecuted(session.id, "d".repeat(64)), "already_executed");
  rejects(() => service.sign(session.id, signers[1].publicKey(), sign(session, signers[1])), "already_executed");
});

test("signatures are bound to the proposal digest and expiry: replay onto another proposal fails", () => {
  const a = open("100");
  const b = open("100");
  rejects(() => service.sign(b.id, signers[0].publicKey(), sign(a, signers[0])), "bad_signature");
  // Same proposal and digest, but a signature made for a later expiry.
  rejects(
    () => service.sign(a.id, signers[0].publicKey(), sign({ ...a, expiresAt: a.expiresAt + 60 }, signers[0])),
    "bad_signature",
  );
  // A signature by another key, claimed for a signer.
  rejects(() => service.sign(a.id, signers[0].publicKey(), sign(a, signers[1])), "bad_signature");
});

test("only the session's signers count, each once", () => {
  const session = open("100");
  rejects(() => service.sign(session.id, outsider.publicKey(), sign(session, outsider)), "not_signer");
  service.sign(session.id, signers[0].publicKey(), sign(session, signers[0]));
  rejects(() => service.sign(session.id, signers[0].publicKey(), sign(session, signers[0])), "already_signed");
});

test("a large spend needs the dual-control threshold", () => {
  const session = open("1000.0000001");
  assert.equal(session.required, 3);
  service.sign(session.id, signers[0].publicKey(), sign(session, signers[0]));
  service.sign(session.id, signers[1].publicKey(), sign(session, signers[1]));
  assert.equal(service.get(session.id)!.status, "collecting");
  rejects(() => service.markExecuted(session.id, "e".repeat(64)), "insufficient_signatures");
  service.sign(session.id, signers[2].publicKey(), sign(session, signers[2]));
  assert.equal(service.get(session.id)!.status, "ready");
  assert.equal(requiredApprovals(config, { kind: "spend", token: TOKEN, to: PAYEE, amount: "1000" }), 2, "exactly the limit is not large");
});

test("a signer rotation needs the current threshold and is audited", () => {
  const newcomer = StellarSdk.Keypair.random();
  const session = service.open({
    proposalId: nextProposal++,
    digest: crypto.randomBytes(32).toString("hex"),
    expiresAt: NOW + 3600,
    action: {
      kind: "rotate",
      signers: [signers[1].publicKey(), signers[2].publicKey(), newcomer.publicKey()],
      threshold: 1,
      largeAmount: "5000",
      largeThreshold: 2,
    },
    config,
  });
  assert.equal(session.required, 2, "the current threshold, not the new one");
  service.sign(session.id, signers[0].publicKey(), sign(session, signers[0]));
  rejects(() => service.markExecuted(session.id, "f".repeat(64)), "insufficient_signatures");
  rejects(() => service.sign(session.id, newcomer.publicKey(), sign(session, newcomer)), "not_signer");
  service.sign(session.id, signers[2].publicKey(), sign(session, signers[2]));
  service.markExecuted(session.id, "f".repeat(64));
  const audit = getAuditLogs({ limit: 50 }).logs.find(
    (r: { action: string; params: string | null }) => r.action === "treasury.signer_set.rotated" && r.params?.includes(session.id),
  );
  assert.ok(audit, "rotation audited");
  // The audit log keeps addresses in the platform's shortened form (redaction policy).
  const pk = newcomer.publicKey();
  assert.ok(audit.params.includes(`${pk.slice(0, 4)}…${pk.slice(-4)}`), "the new signer is named");
  assert.ok(audit.params.includes('"newThreshold":1'));
});

test("expired proposals and invalid input are refused", () => {
  rejects(() => open("1", NOW - 1), "expired");
  const session = open("1", NOW + 2);
  const later = new TreasuryMultisig(getDb, () => NOW + 10);
  assert.equal(later.get(session.id)!.status, "expired");
  rejects(() => later.sign(session.id, signers[0].publicKey(), sign(session, signers[0])), "expired");

  const base = { proposalId: 999, digest: "ab".repeat(32), expiresAt: NOW + 60, config };
  rejects(() => service.open({ ...base, digest: "xyz", action: { kind: "spend", token: TOKEN, to: PAYEE, amount: "1" } }), "invalid_input");
  rejects(() => service.open({ ...base, action: { kind: "spend", token: PAYEE, to: PAYEE, amount: "1" } }), "invalid_input");
  rejects(
    () => service.open({ ...base, config: { ...config, largeThreshold: 1 }, action: { kind: "spend", token: TOKEN, to: PAYEE, amount: "1" } }),
    "invalid_input",
  );
  service.open({ ...base, action: { kind: "spend", token: TOKEN, to: PAYEE, amount: "1" } });
  rejects(() => service.open({ ...base, action: { kind: "spend", token: TOKEN, to: PAYEE, amount: "1" } }), "duplicate_session");
});
