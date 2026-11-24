// Rotation-under-load harness and drills for the relayer key lifecycle (#746).
//
// FakeLedger enforces what makes relayer rotation hard: every account has its
// own sequence chain, a transaction must carry the next sequence of its
// source account, and it must be signed by that account's key. Submissions
// are tagged with a request id (memo) so the harness can count lost and
// duplicated requests across rotations, compromises and rollbacks.

import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

import { RelayerKeyManager } from "../src/services/relayerKeyManager.js";
import {
  DEFAULT_TIER_LIMITS,
  SigningPolicy,
  SigningRefusedError,
  issueActionApproval,
  issueApproval,
  parseTierLimits,
} from "../src/services/relayer-signing-policy.js";
import {
  MemoryKeyLifecycleStore,
  RelayerRotationOrchestrator,
  RotationError,
  type RotationSettings,
} from "../src/services/relayer-rotation.js";

const PASSPHRASE = StellarSdk.Networks.TESTNET;
const COSIGNERS = {
  "ops-a": "cosigner-secret-a-0123456789abcdef0123456789",
  "ops-b": "cosigner-secret-b-0123456789abcdef0123456789",
};
const BREAK_GLASS = "break-glass-secret-0123456789abcdef0123456789";
const DESTINATION = StellarSdk.Keypair.random().publicKey();
const SAFE_ACCOUNT = StellarSdk.Keypair.random().publicKey();

// ── Fake ledger ───────────────────────────────────────────────────────────

class LedgerError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

class FakeLedger {
  accounts = new Map<string, { seq: bigint; balance: number; merged?: boolean }>();
  appliedByMemo = new Map<string, number>();
  appliedSources = new Map<string, string>();
  sweeps: Array<{ type: string; destination: string }> = [];
  rejections = new Map<string, number>();

  fund(publicKey: string, xlm: number): void {
    this.accounts.set(publicKey, { seq: 1000n, balance: xlm });
  }

  loadAccount(publicKey: string): StellarSdk.Account {
    const acct = this.accounts.get(publicKey);
    if (!acct || acct.merged) throw new LedgerError("account_not_found");
    return new StellarSdk.Account(publicKey, acct.seq.toString());
  }

  private reject(code: string): never {
    this.rejections.set(code, (this.rejections.get(code) ?? 0) + 1);
    throw new LedgerError(code);
  }

  submit(tx: StellarSdk.Transaction): { hash: string } {
    const acct = this.accounts.get(tx.source);
    if (!acct || acct.merged) this.reject("tx_no_account");
    if (BigInt(tx.sequence) !== acct!.seq + 1n) this.reject("tx_bad_seq");
    const signer = StellarSdk.Keypair.fromPublicKey(tx.source);
    const signed = tx.signatures.some((s) => signer.verify(tx.hash(), s.signature()));
    if (!signed) this.reject("tx_bad_auth");

    acct!.seq += 1n;
    for (const op of tx.operations as any[]) {
      if (op.type === "accountMerge" || (op.type === "payment" && op.destination === SAFE_ACCOUNT)) {
        this.sweeps.push({ type: op.type, destination: op.destination });
      }
      if (op.type === "accountMerge") acct!.merged = true;
    }
    const memo = tx.memo.value?.toString();
    if (memo) {
      this.appliedByMemo.set(memo, (this.appliedByMemo.get(memo) ?? 0) + 1);
      this.appliedSources.set(memo, tx.source);
    }
    return { hash: tx.hash().toString("hex") };
  }
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    this.held++;
    await previous;
    try {
      return await fn();
    } finally {
      this.held--;
      release();
    }
  }

  get idle(): boolean {
    return this.held === 0;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  km: RelayerKeyManager;
  policy: SigningPolicy;
  ledger: FakeLedger;
  lock: Mutex;
  store: MemoryKeyLifecycleStore;
  orch: RelayerRotationOrchestrator;
  keys: { a: StellarSdk.Keypair; b: StellarSdk.Keypair; c: StellarSdk.Keypair };
  failVerifyFor: Set<string>;
}

function fixture(
  options: {
    fund?: Partial<Record<"a" | "b" | "c", number | null>>;
    settings?: Partial<RotationSettings>;
    drainWindowMs?: number;
  } = {},
): Fixture {
  const keys = {
    a: StellarSdk.Keypair.random(),
    b: StellarSdk.Keypair.random(),
    c: StellarSdk.Keypair.random(),
  };
  const km = new RelayerKeyManager();
  km.initialize({ secretKey: keys.a.secret(), secondarySecretKey: keys.b.secret(), testMode: false });
  km.registerKey({ id: "relayer-tertiary", secretKey: keys.c.secret() });
  km.setDrainWindowMs(options.drainWindowMs ?? 60_000);

  const policy = new SigningPolicy({
    limits: parseTierLimits(DEFAULT_TIER_LIMITS),
    cosigners: COSIGNERS,
    breakGlassSecret: BREAK_GLASS,
    sweepSafeAccount: SAFE_ACCOUNT,
  });
  km.setSigningPolicy(policy);

  const ledger = new FakeLedger();
  const fund = { a: 500, b: 500, c: 500, ...options.fund };
  for (const name of ["a", "b", "c"] as const) {
    if (fund[name] !== null && fund[name] !== undefined) ledger.fund(keys[name].publicKey(), fund[name]!);
  }
  ledger.fund(DESTINATION, 1);

  const lock = new Mutex();
  const store = new MemoryKeyLifecycleStore();
  const failVerifyFor = new Set<string>();
  const orch = new RelayerRotationOrchestrator({
    keyManager: km,
    policy,
    store,
    fence: (fn) => lock.run(fn),
    isQuiescent: () => lock.idle,
    getBalanceXlm: async (pk) => {
      const acct = ledger.accounts.get(pk);
      return acct && !acct.merged ? acct.balance : null;
    },
    verifyIdentity: async (pk) => {
      if (failVerifyFor.has(pk)) throw new Error("sequence resync failed");
      ledger.loadAccount(pk);
    },
    loadSweepAccount: async (pk) => ({
      account: ledger.loadAccount(pk),
      nativeBalance: ledger.accounts.get(pk)!.balance.toFixed(7),
      subentryCount: 0,
    }),
    submit: async (tx) => ledger.submit(tx),
    networkPassphrase: PASSPHRASE,
    settings: {
      drainWindowMs: options.drainWindowMs ?? 60_000,
      minFundingXlm: 10,
      compromiseSloSeconds: 300,
      compromiseCooldownMs: 600_000,
      sweepSafeAccount: SAFE_ACCOUNT,
      maxKeyAgeDays: 90,
      ...options.settings,
    },
  });
  return { km, policy, ledger, lock, store, orch, keys, failVerifyFor };
}

function paymentTx(source: StellarSdk.Account, memo: string, amount = "1"): StellarSdk.Transaction {
  return new StellarSdk.TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: DESTINATION,
        asset: StellarSdk.Asset.native(),
        amount,
      }),
    )
    .addMemo(StellarSdk.Memo.text(memo))
    .setTimeout(30)
    .build();
}

/**
 * Relayer-style load: each request builds against the currently active
 * account, signs and submits inside the sequence lock, and retries (rebuild
 * under whatever identity is active) on any failure — like a vote job.
 */
async function runLoad(
  f: Fixture,
  total: number,
  concurrency: number,
  onProgress: (done: number) => Promise<void> | void = () => {},
): Promise<{ failed: string[]; errors: Map<string, number> }> {
  const pending = Array.from({ length: total }, (_, i) => `req-${i}`);
  const failed: string[] = [];
  const errors = new Map<string, number>();
  let done = 0;

  const worker = async () => {
    for (let id = pending.shift(); id; id = pending.shift()) {
      let ok = false;
      for (let attempt = 0; attempt < 10 && !ok; attempt++) {
        try {
          await f.lock.run(async () => {
            const tx = paymentTx(f.ledger.loadAccount(f.km.getPublicKey()), id!);
            await tick(); // simulate / RPC latency inside the critical section
            await f.km.signTransaction(tx);
            f.ledger.submit(tx);
          });
          ok = true;
        } catch (err) {
          const code = (err as any).reason ?? (err as any).code ?? (err as Error).message;
          errors.set(code, (errors.get(code) ?? 0) + 1);
          await tick();
        }
      }
      if (!ok) failed.push(id);
      done++;
      await onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { failed, errors };
}

function assertExactlyOnce(f: Fixture, total: number): void {
  for (let i = 0; i < total; i++) {
    const n = f.ledger.appliedByMemo.get(`req-${i}`) ?? 0;
    assert.equal(n, 1, `req-${i} applied ${n} times`);
  }
}

// ── Identity fencing ──────────────────────────────────────────────────────

test("identity fencing: a tx built before rotation is signed by its own account after it", async () => {
  const f = fixture();
  const inFlight = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "straddle");

  await f.km.rotateActiveKey(f.keys.b.publicKey(), "planned");
  assert.equal(f.km.getPublicKey(), f.keys.b.publicKey());

  await f.km.signTransaction(inFlight);
  assert.doesNotThrow(() => f.ledger.submit(inFlight), "old-account tx must verify");
  assert.equal(f.km.findKey(f.keys.a.publicKey())?.status, "draining");
});

test("identity fencing: the old identity stops signing when its drain window closes", async () => {
  const f = fixture({ drainWindowMs: 1 });
  await f.km.rotateActiveKey(f.keys.b.publicKey(), "planned");
  await new Promise((r) => setTimeout(r, 5));

  const late = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "late");
  await assert.rejects(f.km.signTransaction(late), (e: any) => e.reason === "drain_window_closed");
  assert.equal(f.km.findKey(f.keys.a.publicKey())?.status, "standby");
});

test("identity fencing: an idle standby never signs for its own account", async () => {
  const f = fixture();
  const tx = paymentTx(f.ledger.loadAccount(f.keys.c.publicKey()), "standby");
  await assert.rejects(f.km.signTransaction(tx), (e: any) => e.reason === "identity_inactive");
});

// ── Planned rotation under load ───────────────────────────────────────────

test("rotation under load: two planned rotations lose and duplicate nothing", async () => {
  const f = fixture({ drainWindowMs: 150 });
  const TOTAL = 240;
  let rotations = 0;

  const { failed, errors } = await runLoad(f, TOTAL, 12, async (done) => {
    if (done === 60 && rotations === 0) {
      rotations++;
      const r = await f.orch.rotate({ target: f.keys.b.publicKey(), actor: "drill" });
      assert.equal(r.phase, "draining");
      // Work is still flowing, so the window cannot be closed early.
      assert.throws(() => f.orch.finalize({ actor: "drill" }), (e: any) => e.code === "not_quiescent");
    }
    if (done === 150 && rotations === 1) {
      rotations++;
      // The second rotation waits for the first identity's drain window.
      while (f.orch.getStatus().current) await new Promise((r) => setTimeout(r, 20));
      const r = await f.orch.rotate({ target: f.keys.c.publicKey(), actor: "drill" });
      assert.equal(r.phase, "draining");
    }
  });

  assert.equal(rotations, 2);
  assert.deepEqual(failed, []);
  assert.equal(errors.size, 0, `unexpected errors: ${[...errors]}`);
  assert.equal(f.ledger.rejections.size, 0, `ledger rejected: ${[...f.ledger.rejections]}`);
  assertExactlyOnce(f, TOTAL);
  const sources = new Set(f.ledger.appliedSources.values());
  assert.deepEqual(
    sources,
    new Set([f.keys.a.publicKey(), f.keys.b.publicKey(), f.keys.c.publicKey()]),
  );
});

test("rotation refuses while the previous identity is still draining (bounded window)", async () => {
  const f = fixture();
  await f.orch.rotate({ target: f.keys.b.publicKey(), actor: "drill" });
  await assert.rejects(
    f.orch.rotate({ target: f.keys.c.publicKey(), actor: "drill" }),
    (e: any) => e.code === "drain_in_progress",
  );
});

// ── Funding gap ───────────────────────────────────────────────────────────

test("funding-gap drill: cutover to an unfunded account is refused before anything changes", async () => {
  const f = fixture({ fund: { b: null, c: 3 } });
  const TOTAL = 80;
  let attempted = false;

  const { failed } = await runLoad(f, TOTAL, 6, async (done) => {
    if (done === 20 && !attempted) {
      attempted = true;
      await assert.rejects(
        f.orch.rotate({ actor: "drill" }),
        (e: any) =>
          e instanceof RotationError &&
          e.code === "funding_gap" &&
          /does not exist/.test(e.message) &&
          /3 XLM < required 10/.test(e.message),
      );
    }
  });

  assert.equal(f.km.getPublicKey(), f.keys.a.publicKey(), "active identity unchanged");
  assert.deepEqual(failed, []);
  assertExactlyOnce(f, TOTAL);
  assert.equal(f.orch.getStatus().history[0].phase, "failed");
});

// ── Rollback ──────────────────────────────────────────────────────────────

test("rollback drill: a failed cutover returns to the old identity without losing work", async () => {
  const f = fixture();
  f.failVerifyFor.add(f.keys.b.publicKey());
  const TOTAL = 120;
  let tried = false;

  const { failed } = await runLoad(f, TOTAL, 8, async (done) => {
    if (done === 40 && !tried) {
      tried = true;
      await assert.rejects(
        f.orch.rotate({ target: f.keys.b.publicKey(), actor: "drill" }),
        (e: any) => e.code === "cutover_failed",
      );
    }
  });

  assert.equal(f.km.getPublicKey(), f.keys.a.publicKey());
  assert.equal(f.orch.getStatus().history[0].phase, "rolled_back");
  assert.deepEqual(failed, []);
  assertExactlyOnce(f, TOTAL);
  assert.ok(f.store.events.some((e) => e.event === "rotation_rolled_back"));
});

test("rollback drill: manual rollback inside the drain window restores the previous identity", async () => {
  const f = fixture();
  await f.orch.rotate({ target: f.keys.b.publicKey(), actor: "drill" });
  const signedByB = paymentTx(f.ledger.loadAccount(f.keys.b.publicKey()), "b-inflight");

  const r = await f.orch.rollback({ actor: "drill", reason: "new identity misbehaving" });
  assert.equal(r.phase, "rolled_back");
  assert.equal(f.km.getPublicKey(), f.keys.a.publicKey());
  // B now drains in turn: its in-flight work can still be signed.
  await f.km.signTransaction(signedByB);
  f.ledger.submit(signedByB);
});

// ── Compromise response ───────────────────────────────────────────────────

test("compromise drill under load: revoked at once, rotated inside the SLO, nothing lost or duplicated", async () => {
  const f = fixture();
  const TOTAL = 200;
  let record: any;

  const { failed, errors } = await runLoad(f, TOTAL, 12, async (done) => {
    if (done === 70 && !record) {
      record = await f.orch.declareCompromise({
        key: f.keys.a.publicKey(),
        declaredBy: "oncall-1",
        reason: "secret found in public paste",
      });
    }
  });

  assert.equal(record.phase, "completed");
  assert.equal(record.sloMet, true);
  assert.ok(record.timeToRotatedMs < 300_000);
  assert.equal(record.revocationPersisted, true);
  assert.notEqual(f.km.getPublicKey(), f.keys.a.publicKey());
  assert.deepEqual(failed, []);
  assertExactlyOnce(f, TOTAL);
  assert.equal(f.ledger.rejections.get("tx_bad_auth") ?? 0, 0);
  // Nothing new is signed by the compromised account after declaration.
  const late = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "after");
  await assert.rejects(f.km.signTransaction(late), (e: any) => e.reason === "identity_revoked");
  assert.ok(f.store.revocations.has(f.keys.a.publicKey()));
  // Only the critical section in flight at declaration can hit the revoked
  // key; the compromise flip does not wait behind the queued backlog.
  assert.ok((errors.get("identity_revoked") ?? 0) <= 1, `revoked errors: ${errors.get("identity_revoked")}`);
});

test("compromise with no funded standby halts signing instead of activating an unfunded key", async () => {
  const f = fixture({ fund: { b: null, c: 2 } });
  const record = await f.orch.declareCompromise({
    key: f.keys.a.publicKey(),
    declaredBy: "oncall-1",
    reason: "drill",
  });
  assert.equal(record.halted, true);
  assert.equal(record.sloMet, false);
  assert.equal(f.km.getActiveKey(), null);
  const tx = paymentTx(new StellarSdk.Account(f.keys.b.publicKey(), "1"), "x");
  await assert.rejects(f.km.signTransaction(tx));
});

test("compromise reports in-flight signatures of the revoked key as invalidated", async () => {
  const f = fixture();
  const tx = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "pending");
  await f.km.signTransaction(tx);
  const record = await f.orch.declareCompromise({
    key: f.keys.a.publicKey(),
    declaredBy: "oncall-1",
    reason: "drill",
  });
  assert.deepEqual(record.invalidatedSignatures, [tx.hash().toString("hex")]);
});

test("persisted revocation survives restart: compromised secret still configured stays revoked", async () => {
  const f = fixture();
  await f.orch.declareCompromise({ key: f.keys.a.publicKey(), declaredBy: "oncall-1", reason: "drill" });

  const restarted = new RelayerKeyManager();
  restarted.initialize({
    secretKey: f.keys.a.secret(),
    secondarySecretKey: f.keys.b.secret(),
    testMode: false,
  });
  restarted.applyPersistedRevocations(f.store.loadRevocations());

  assert.equal(restarted.getPublicKey(), f.keys.b.publicKey());
  await assert.rejects(restarted.rotateActiveKey(f.keys.a.publicKey()), /revoked/);
  assert.throws(() => restarted.registerKey({ secretKey: f.keys.a.secret() }), /revoked/);
});

// ── Sweep & griefing ──────────────────────────────────────────────────────

const approve = (id: keyof typeof COSIGNERS, action: string, ttl = 60_000) =>
  issueActionApproval(id, COSIGNERS[id], action, Date.now() + ttl);

test("sweep requires a second person's co-signer approval for this exact key", async () => {
  const f = fixture();
  const pk = f.keys.a.publicKey();
  await f.orch.declareCompromise({ key: pk, declaredBy: "ops-a", reason: "drill" });

  await assert.rejects(f.orch.sweep({ key: pk, requestedBy: "ops-a" }), (e: any) => e.code === "two_person_rule");
  // The declarer cannot confirm their own declaration.
  await assert.rejects(
    f.orch.sweep({ key: pk, requestedBy: "oncall", confirmation: approve("ops-a", `sweep:${pk}`) }),
    (e: any) => e.code === "two_person_rule",
  );
  // An approval for another key is not transferable.
  await assert.rejects(
    f.orch.sweep({ key: pk, requestedBy: "ops-a", confirmation: approve("ops-b", `sweep:${f.keys.b.publicKey()}`) }),
    (e: any) => e.code === "two_person_rule",
  );

  const result = await f.orch.sweep({
    key: pk,
    requestedBy: "ops-a",
    confirmation: approve("ops-b", `sweep:${pk}`),
  });
  assert.equal(result.mode, "merge");
  assert.equal(result.confirmedBy, "ops-b");
  assert.deepEqual(f.ledger.sweeps, [{ type: "accountMerge", destination: SAFE_ACCOUNT }]);
});

test("fake-declaration drill: declaring a standby burns that key only; no funds move, no rotation", async () => {
  const f = fixture();
  const before = f.km.getPublicKey();
  const record = await f.orch.declareCompromise({
    key: f.keys.c.publicKey(),
    declaredBy: "attacker-with-admin-token",
    reason: "fake",
  });
  assert.equal(record.toKeyId, null);
  assert.equal(f.km.getPublicKey(), before);
  assert.equal(f.ledger.sweeps.length, 0);
  // A second declaration inside the cooldown needs a different co-signer.
  await assert.rejects(
    f.orch.declareCompromise({ key: before, declaredBy: "attacker-with-admin-token", reason: "fake" }),
    (e: any) => e.code === "cooldown_requires_confirmation",
  );
  assert.equal(f.km.getPublicKey(), before);
  // Sweeping the burned key still needs a real second co-signer.
  await assert.rejects(
    f.orch.sweep({ key: f.keys.c.publicKey(), requestedBy: "attacker-with-admin-token" }),
    (e: any) => e.code === "two_person_rule",
  );
});

test("repeated declaration of the same key is idempotent", async () => {
  const f = fixture();
  const first = await f.orch.declareCompromise({ key: f.keys.a.publicKey(), declaredBy: "x", reason: "r" });
  const again = await f.orch.declareCompromise({ key: f.keys.a.publicKey(), declaredBy: "x", reason: "r" });
  assert.equal(again.id, first.id);
});

// ── Reconstitution ────────────────────────────────────────────────────────

test("reconstitution rehearsal: replace the burned key, refund, and rotate normally again", async () => {
  const f = fixture({ fund: { c: null } });
  await f.orch.declareCompromise({ key: f.keys.a.publicKey(), declaredBy: "ops-a", reason: "drill" });
  assert.equal(f.km.getPublicKey(), f.keys.b.publicKey());
  assert.equal(f.orch.getStatus().readiness.fundedStandbyKeys, 0);

  const fresh = StellarSdk.Keypair.random();
  f.km.registerKey({ id: "reconstituted", secretKey: fresh.secret() });
  f.ledger.fund(fresh.publicKey(), 100);
  const rotated = await f.orch.rotate({ target: "reconstituted", actor: "ops-a" });
  assert.equal(rotated.toPublicKey, fresh.publicKey());
  assert.notEqual(f.km.getPublicKey(), f.keys.a.publicKey());
});

// ── Tiered signing ────────────────────────────────────────────────────────

test("tiers: hot payments sign alone; warm needs one co-signer; cold needs two distinct", async () => {
  const f = fixture();
  const acct = () => f.ledger.loadAccount(f.keys.a.publicKey());

  await f.km.signTransaction(paymentTx(acct(), "hot", "500"));

  const warm = paymentTx(acct(), "warm", "50000");
  await assert.rejects(f.km.signTransaction(warm), (e: any) => e.reason === "tier_approval_missing");
  const warmHash = warm.hash().toString("hex");
  await f.km.signTransaction(warm, {
    approvals: [issueApproval("ops-a", COSIGNERS["ops-a"], warmHash, "warm", Date.now() + 60_000)],
  });

  const cold = paymentTx(acct(), "cold", "500000");
  const coldHash = cold.hash().toString("hex");
  const a = issueApproval("ops-a", COSIGNERS["ops-a"], coldHash, "cold", Date.now() + 60_000);
  const b = issueApproval("ops-b", COSIGNERS["ops-b"], coldHash, "cold", Date.now() + 60_000);
  await assert.rejects(f.km.signTransaction(cold, { approvals: [a, a] }), SigningRefusedError);
  await f.km.signTransaction(cold, { approvals: [a, b] });
});

test("tier bypass: approvals are bound to one tx hash, unexpired, from known co-signers", async () => {
  const f = fixture();
  const acct = () => f.ledger.loadAccount(f.keys.a.publicKey());
  const approved = paymentTx(acct(), "approved", "50000");
  const other = paymentTx(acct(), "other", "50000");
  const token = issueApproval("ops-a", COSIGNERS["ops-a"], approved.hash().toString("hex"), "warm", Date.now() + 60_000);
  await assert.rejects(f.km.signTransaction(other, { approvals: [token] }), SigningRefusedError);

  const expired = issueApproval("ops-a", COSIGNERS["ops-a"], other.hash().toString("hex"), "warm", Date.now() - 1);
  await assert.rejects(f.km.signTransaction(other, { approvals: [expired] }), SigningRefusedError);

  const forged = issueApproval("ops-z", "guessed-secret", other.hash().toString("hex"), "warm", Date.now() + 60_000);
  await assert.rejects(f.km.signTransaction(other, { approvals: [forged] }), SigningRefusedError);

  // An approval for a lower tier does not authorise a higher one.
  const big = paymentTx(acct(), "big", "500000");
  const warmOnBig = issueApproval("ops-a", COSIGNERS["ops-a"], big.hash().toString("hex"), "warm", Date.now() + 60_000);
  await assert.rejects(f.km.signTransaction(big, { approvals: [warmOnBig] }), SigningRefusedError);
});

test("tier bypass: privileged ops are cold regardless of amount", async () => {
  const f = fixture();
  const tx = new StellarSdk.TransactionBuilder(f.ledger.loadAccount(f.keys.a.publicKey()), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.setOptions({ signer: { ed25519PublicKey: DESTINATION, weight: 255 } }))
    .setTimeout(30)
    .build();
  assert.equal(f.policy.classify(tx).tier, "cold");
  await assert.rejects(f.km.signTransaction(tx), (e: any) => e.reason === "tier_approval_missing");
});

test("tier bypass: splitting value across operations does not lower the tier", async () => {
  const f = fixture();
  const builder = new StellarSdk.TransactionBuilder(f.ledger.loadAccount(f.keys.a.publicKey()), {
    fee: "1000",
    networkPassphrase: PASSPHRASE,
  });
  for (let i = 0; i < 10; i++) {
    builder.addOperation(
      StellarSdk.Operation.payment({ destination: DESTINATION, asset: StellarSdk.Asset.native(), amount: "9000" }),
    );
  }
  const tx = builder.setTimeout(30).build();
  assert.equal(f.policy.classify(tx).tier, "warm");
});

test("tier bypass: break-glass covers warm but never cold", async () => {
  const f = fixture();
  const acct = () => f.ledger.loadAccount(f.keys.a.publicKey());
  const warm = paymentTx(acct(), "bg-warm", "50000");
  const cold = paymentTx(acct(), "bg-cold", "500000");
  const glass = (tx: StellarSdk.Transaction) =>
    issueApproval("break-glass", BREAK_GLASS, tx.hash().toString("hex"), "warm", Date.now() + 60_000);
  await f.km.signTransaction(warm, { breakGlass: glass(warm) });
  await assert.rejects(f.km.signTransaction(cold, { breakGlass: glass(cold) }), SigningRefusedError);
});

test("tier bypass: sweep purpose cannot sign anything but a payout to the safe account", async () => {
  const f = fixture();
  await f.orch.declareCompromise({ key: f.keys.c.publicKey(), declaredBy: "x", reason: "r" });
  const acct = f.ledger.loadAccount(f.keys.c.publicKey());
  // Destination is pinned by config, so a payout elsewhere is refused.
  const disguised = paymentTx(acct, "steal", "400");
  await assert.rejects(
    f.km.signTransaction(disguised, { purpose: "sweep" }),
    (e: any) => e.reason === "sweep_shape_invalid",
  );
  // The sweep purpose never applies to a non-compromised identity.
  const big = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "big", "500000");
  await assert.rejects(
    f.km.signTransaction(big, { purpose: "sweep" }),
    (e: any) => e.reason === "sweep_unauthorized",
  );
});

test("halt: co-signer stop signal refuses all signing until resumed", async () => {
  const f = fixture();
  f.orch.halt("suspicious activity", "ops-b");
  const tx = paymentTx(f.ledger.loadAccount(f.keys.a.publicKey()), "halted");
  await assert.rejects(f.km.signTransaction(tx), (e: any) => e.reason === "halted");
  assert.equal(f.orch.getStatus().readiness.halted, true);
  f.orch.resume("ops-b");
  await f.km.signTransaction(tx);
});

// ── Key age ───────────────────────────────────────────────────────────────

test("readiness flags an active key older than the max age", () => {
  const f = fixture({ settings: { maxKeyAgeDays: 30 } });
  f.km.getActiveKey()!.activatedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const { readiness } = f.orch.getStatus();
  assert.equal(readiness.rotationOverdue, true);
  assert.ok(readiness.activeKeyAgeDays! > 30);
});

test("compromise under a queued backlog: requests are not retried, so at most the in-flight one fails", async () => {
  // Routes don't retry. A compromise flip that queued behind the FIFO lock
  // would leave the revoked key active for every request ahead of it, and
  // each of those would fail. The flip must not wait for the backlog.
  const TOTAL = 40;
  const g = fixture();
  const runs = Array.from({ length: TOTAL }, (_, i) =>
    g.lock.run(async () => {
      const tx = paymentTx(g.ledger.loadAccount(g.km.getPublicKey()), `q-${i}`);
      await tick();
      await g.km.signTransaction(tx);
      g.ledger.submit(tx);
    }),
  );
  await tick();
  const record = await g.orch.declareCompromise({
    key: g.keys.a.publicKey(),
    declaredBy: "oncall-1",
    reason: "drill",
  });
  const settled = await Promise.allSettled(runs);
  const failures = settled.filter((s) => s.status === "rejected").length;
  assert.equal(record.halted ?? false, false);
  assert.ok(failures <= 1, `${failures} of ${TOTAL} queued requests failed`);
  assert.ok(record.timeToRotatedMs < 1_000, `rotated in ${record.timeToRotatedMs}ms`);
});

test("funding gap: a missing standby account reads as 0 XLM, not unknown", async () => {
  const { config } = await import("../src/config.js");
  const f = fixture({ fund: { b: null } });
  const prev = config.testMode;
  config.testMode = false; // checkBalance short-circuits in test mode
  try {
    const rpc = {
      getAccount: async (pk: string) => {
        if (!f.ledger.accounts.has(pk)) throw new Error(`Account not found: ${pk}`);
        return { balances: [{ asset_type: "native", balance: "500.0000000" }] };
      },
    };
    assert.equal(await f.km.checkBalance(f.keys.b.publicKey(), rpc), 0);
    assert.equal(f.km.findKey(f.keys.b.publicKey())!.balanceXlm, 0);
    // Ranked behind the funded standby instead of tied with it as "unknown".
    await f.km.checkBalance(f.keys.c.publicKey(), rpc);
    assert.equal(f.km.standbyCandidates()[0].publicKey, f.keys.c.publicKey());
  } finally {
    config.testMode = prev;
  }
});

test("low-balance failover goes through the orchestrator: no cutover to an unfunded standby", async () => {
  const f = fixture({ fund: { b: null, c: 2 } });
  f.km.getActiveKey()!.balanceXlm = 1;
  const result = await f.km.checkAndHandleLowBalance(5, undefined, () =>
    f.orch.rotate({ actor: "system", reason: "low_balance" }),
  );
  assert.equal(result.rotated, false);
  assert.equal(f.km.getPublicKey(), f.keys.a.publicKey());

  // Once a standby is funded, the same failover rotates through the fence.
  f.ledger.fund(f.keys.c.publicKey(), 500);
  const ok = await f.km.checkAndHandleLowBalance(5, undefined, () =>
    f.orch.rotate({ actor: "system", reason: "low_balance" }),
  );
  assert.equal(ok.rotated, true);
  assert.equal(f.km.getPublicKey(), f.keys.c.publicKey());
});

test("key-age gauge keeps ageing with no key events, so the overdue alert can fire", async () => {
  const { relayerKeyManager } = await import("../src/services/relayerKeyManager.js");
  const { relayerActiveKeyAgeSeconds } = await import("../src/services/metrics.js");
  relayerKeyManager.reset();
  relayerKeyManager.initialize({ testMode: true });
  // Only the activation time changes; nothing calls updateMetrics().
  relayerKeyManager.getActiveKey()!.activatedAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
  const age = (await relayerActiveKeyAgeSeconds.get()).values[0].value;
  assert.ok(age >= 100 * 86_400 - 5, `gauge reported ${age}s`);

  // A fixture's own manager must not hijack the process-wide gauge.
  const f = fixture();
  f.km.getActiveKey()!.activatedAt = new Date().toISOString();
  const after = (await relayerActiveKeyAgeSeconds.get()).values[0].value;
  assert.ok(after >= 100 * 86_400 - 5);
});
