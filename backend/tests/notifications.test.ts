/**
 * Notification delivery (ZV-037 / #886).
 *
 * Covers: templates escape user content and never carry a wallet address;
 * WebPush encryption round-trips and VAPID signs per RFC 8292; preferences are
 * honoured per event type and DAO; delivery runs through the durable outbox
 * with SSE stopped; provider failures are retried and dead-lettered (and
 * counted); a gone destination is unsubscribed; expiry and unsubscribe work
 * over HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-notifications-"));
const WALLET = "GDWT6V543ZVXYNECWWUZ34ZHLJJ6OHGQXVYXJWD6WP7NOF65BT7GSUU5";
const CONTRACT = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

const { initDb, getDb } = await import("../src/services/db.ts");
initDb(path.join(TEST_DIR, "notifications.db"));

const notifications = await import("../src/services/notifications/index.ts");
const webpush = await import("../src/services/notifications/webpush.ts");
const { sseService } = await import("../src/services/sse.ts");
const { register } = await import("../src/services/metrics.ts");
const notificationRoutes = (await import("../src/routes/notifications.ts")).default;

const {
  subscriptionStore,
  registerProvider,
  resetProviders,
  publishNotificationEvent,
  processNotificationBatch,
  renderNotification,
  notificationFromIndexedEvent,
  notificationFromDisputeResolution,
  REDACTED_ADDRESS,
  NOTIFICATION_JOB_TYPE,
} = notifications;

type Sent = { destination: string; subject: string; text: string; html: string };

function fakeProvider(channel: "email" | "webpush", behaviour: (n: number) => void = () => undefined) {
  const sent: Sent[] = [];
  let calls = 0;
  registerProvider({
    name: `fake-${channel}`,
    channel,
    async send(destination, message) {
      calls += 1;
      behaviour(calls);
      sent.push({ destination, subject: message.subject, text: message.text, html: message.html });
    },
  });
  return { sent, calls: () => calls };
}

function reset(): void {
  getDb().prepare("DELETE FROM notification_subscriptions").run();
  getDb().prepare("DELETE FROM jobs WHERE job_type = ?").run(NOTIFICATION_JOB_TYPE);
  resetProviders();
}

/** Makes retrying jobs due now, instead of waiting out the back-off. */
function makeRetriesDue(): void {
  getDb().prepare("UPDATE jobs SET run_after = 0 WHERE job_type = ? AND status = 'retrying'").run(NOTIFICATION_JOB_TYPE);
}

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = (await register.getMetricsAsJSON()).find((m) => m.name === name);
  const value = metric?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l));
  return Number(value?.value ?? 0);
}

const started = (id = "1", daoId = "7") =>
  notificationFromIndexedEvent({
    daoId,
    type: "proposal_created",
    data: { proposal_id: id, creator: WALLET, end_time: 1_900_000_000 },
  })!;

// ── Templates ───────────────────────────────────────────────────────────────

test("templates escape user content and never include a wallet or contract address", () => {
  const message = renderNotification(
    {
      id: "e1",
      type: "dispute_outcome",
      daoId: "7",
      data: {
        daoName: `<script>alert(1)</script> owned by ${WALLET}`,
        outcome: `Refund to ${WALLET} via ${CONTRACT} & "close"`,
      },
    },
    { publicUrl: "https://vote.example.org", token: "a".repeat(64) },
  );
  for (const part of [message.subject, message.text, message.html, message.push.title, message.push.body]) {
    assert.ok(!part.includes(WALLET), "wallet address leaked");
    assert.ok(!part.includes(CONTRACT), "contract address leaked");
  }
  assert.ok(message.text.includes(REDACTED_ADDRESS));
  assert.ok(!message.html.includes("<script>"), "HTML not escaped");
  assert.ok(message.html.includes("&lt;script&gt;"));
  assert.ok(message.html.includes("&amp; &quot;close&quot;"));
  assert.equal(
    message.unsubscribeUrl,
    `https://vote.example.org/api/v1/notifications/unsubscribe?token=${"a".repeat(64)}`,
  );
});

test("indexed proposal events map to election notifications without the creator", () => {
  const event = started("12", "3");
  assert.equal(event.type, "election_started");
  assert.equal(event.id, "proposal_created:3:12");
  assert.equal(event.data.at, new Date(1_900_000_000 * 1000).toISOString());
  assert.ok(!JSON.stringify(event).includes(WALLET));
  assert.equal(
    notificationFromIndexedEvent({ daoId: 3, type: "proposal_closed", data: { proposalId: 12 } })?.type,
    "election_ended",
  );
  assert.equal(notificationFromIndexedEvent({ daoId: 3, type: "vote_cast", data: {} }), null);
  assert.equal(notificationFromDisputeResolution({ caseId: "c1", resolution: "upheld" }).type, "dispute_outcome");
});

// ── WebPush ─────────────────────────────────────────────────────────────────

test("WebPush payloads are RFC 8291 encrypted for the subscriber's keys", () => {
  const subscriber = crypto.createECDH("prime256v1");
  subscriber.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = {
    endpoint: "https://push.example.net/send/abc",
    keys: { p256dh: webpush.b64url.encode(subscriber.getPublicKey()), auth: webpush.b64url.encode(auth) },
  };
  const plaintext = Buffer.from(JSON.stringify({ title: "Voting is open" }));
  const body = webpush.encryptPayload(plaintext, subscription);

  assert.equal(body.readUInt32BE(16), 4096, "record size");
  assert.equal(body.readUInt8(20), 65, "keyid is the sender's public key");
  assert.ok(!body.includes(plaintext), "payload must not appear in clear");
  assert.deepEqual(webpush.decryptPayload(body, subscriber, auth), plaintext);
});

test("VAPID authorization is an ES256 JWT for the push service origin", () => {
  const keys = webpush.generateVapidKeys("mailto:ops@example.org");
  const header = webpush.vapidAuthorization("https://push.example.net/send/abc", keys, 1_700_000_000_000);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  const [, h, c, sig, k] = match!;
  assert.equal(k, keys.publicKey);
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.aud, "https://push.example.net");
  assert.equal(claims.sub, "mailto:ops@example.org");
  assert.equal(claims.exp, 1_700_000_000 + 12 * 60 * 60);
  const pub = webpush.b64url.decode(keys.publicKey);
  const verifier = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: webpush.b64url.encode(pub.subarray(1, 33)), y: webpush.b64url.encode(pub.subarray(33)) },
    format: "jwk",
  });
  assert.ok(
    crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: verifier, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")),
  );
});

// ── Preferences ─────────────────────────────────────────────────────────────

test("subscriptions validate input and expire", () => {
  reset();
  assert.throws(() => subscriptionStore.create({ channel: "sms", destination: "x" }), /channel/);
  assert.throws(() => subscriptionStore.create({ channel: "email", destination: WALLET }), /email/);
  assert.throws(
    () => subscriptionStore.create({ channel: "email", destination: "a@b.org", eventTypes: ["vote_cast"] }),
    /Unknown event type/,
  );
  assert.throws(() => subscriptionStore.create({ channel: "webpush", destination: { endpoint: "http://x" } }), /push/);

  const sub = subscriptionStore.create({ channel: "email", destination: "Voter@Example.org " }, 1_000);
  assert.match(sub.token, /^[0-9a-f]{64}$/);
  assert.equal(sub.destination, "voter@example.org");
  assert.ok(subscriptionStore.get(sub.token, 2_000));
  assert.equal(subscriptionStore.get(sub.token, sub.expiresAt), null, "expired subscriptions are invisible");
  assert.equal(subscriptionStore.purgeExpired(sub.expiresAt), 1);
});

test("preferences are honoured per event type and per DAO", async () => {
  reset();
  const email = fakeProvider("email");
  const all = subscriptionStore.create({ channel: "email", destination: "all@example.org" });
  subscriptionStore.create({ channel: "email", destination: "disputes@example.org", eventTypes: ["dispute_outcome"] });
  subscriptionStore.create({ channel: "email", destination: "dao9@example.org", daoIds: ["9"] });
  const dao7 = subscriptionStore.create({ channel: "email", destination: "dao7@example.org", daoIds: ["7"], eventTypes: ["election_started"] });

  assert.equal(publishNotificationEvent(started("1", "7")), 2);
  await processNotificationBatch();
  assert.deepEqual(email.sent.map((s) => s.destination).sort(), [all.destination, dao7.destination].sort());

  // Changing preferences takes effect for the next event.
  subscriptionStore.update(dao7.token, { eventTypes: ["election_ended"] });
  email.sent.length = 0;
  publishNotificationEvent(started("2", "7"));
  await processNotificationBatch();
  assert.deepEqual(email.sent.map((s) => s.destination), [all.destination]);
});

// ── Delivery ────────────────────────────────────────────────────────────────

test("delivery runs from the durable outbox with the SSE process stopped", async () => {
  reset();
  sseService.stop();
  const email = fakeProvider("email");
  subscriptionStore.create({ channel: "email", destination: "voter@example.org" });

  publishNotificationEvent(started("5", "7"));
  publishNotificationEvent(started("5", "7")); // re-indexed: one delivery, not two
  const queued = getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_type = ?").get(NOTIFICATION_JOB_TYPE) as { n: number };
  assert.equal(queued.n, 1, "the outbox dedupes per event and destination");

  const result = await processNotificationBatch();
  assert.equal(result.sent, 1);
  assert.equal(email.sent[0].destination, "voter@example.org");
  assert.match(email.sent[0].subject, /Voting is open: Proposal #5/);
  assert.ok(!email.sent[0].text.includes(WALLET));
});

test("an unsubscribe between publishing and sending is honoured", async () => {
  reset();
  const email = fakeProvider("email");
  const sub = subscriptionStore.create({ channel: "email", destination: "gone@example.org" });
  publishNotificationEvent(started("6"));
  subscriptionStore.remove(sub.token);
  const result = await processNotificationBatch();
  assert.equal(result.skipped, 1);
  assert.equal(email.sent.length, 0);
});

test("provider failures are retried, then dead-lettered and counted", async () => {
  reset();
  const failing = fakeProvider("email", (n) => {
    if (n <= 2) throw new Error("relay unavailable");
  });
  subscriptionStore.create({ channel: "email", destination: "retry@example.org" });

  publishNotificationEvent(started("7"));
  assert.equal((await processNotificationBatch()).retried, 1);
  makeRetriesDue();
  assert.equal((await processNotificationBatch()).retried, 1);
  makeRetriesDue();
  assert.equal((await processNotificationBatch()).sent, 1, "third attempt succeeds");
  assert.equal(failing.sent.length, 1);

  // A destination that never accepts ends in the dead-letter queue.
  reset();
  fakeProvider("email", () => {
    throw new Error("relay down");
  });
  subscriptionStore.create({ channel: "email", destination: "dead@example.org" });
  const before = await counter("zkvote_notification_dead_letter_total", { channel: "email" });
  publishNotificationEvent(started("8"));
  let dead = 0;
  for (let i = 0; i < 10 && dead === 0; i += 1) {
    dead = (await processNotificationBatch()).deadLettered;
    makeRetriesDue();
  }
  assert.equal(dead, 1);
  const row = getDb().prepare("SELECT status FROM jobs WHERE job_type = ?").get(NOTIFICATION_JOB_TYPE) as { status: string };
  assert.equal(row.status, "dead");
  assert.equal(await counter("zkvote_notification_dead_letter_total", { channel: "email" }), before + 1);
});

test("a destination that is gone for good is unsubscribed, not retried", async () => {
  reset();
  registerProvider(
    notifications.createWebPushProvider({
      vapid: webpush.generateVapidKeys(),
      fetchImpl: (async () => new Response(null, { status: 410 })) as typeof fetch,
    }),
  );
  const subscriber = crypto.createECDH("prime256v1");
  subscriber.generateKeys();
  const sub = subscriptionStore.create({
    channel: "webpush",
    destination: {
      endpoint: "https://push.example.net/send/expired",
      keys: { p256dh: webpush.b64url.encode(subscriber.getPublicKey()), auth: webpush.b64url.encode(crypto.randomBytes(16)) },
    },
  });
  publishNotificationEvent(started("9"));
  const result = await processNotificationBatch();
  assert.equal(result.gone, 1);
  assert.equal(subscriptionStore.get(sub.token), null);
});

test("the email relay receives an escaped message with one-click unsubscribe headers", async () => {
  reset();
  let body: { to: string; html: string; headers: Record<string, string> } | null = null;
  registerProvider(
    notifications.createHttpEmailProvider({
      url: "https://mail.example.org/send",
      token: "secret",
      from: "ZK-VOTE <no-reply@example.org>",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        assert.equal((init.headers as Record<string, string>).authorization, "Bearer secret");
        body = JSON.parse(String(init.body));
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    }),
  );
  const sub = subscriptionStore.create({ channel: "email", destination: "voter@example.org" });
  publishNotificationEvent(notificationFromDisputeResolution({ caseId: "case-1", resolution: `<b>refund</b> ${WALLET}` }));
  assert.equal((await processNotificationBatch()).sent, 1);
  assert.equal(body!.to, "voter@example.org");
  assert.match(body!.headers["List-Unsubscribe"], new RegExp(sub.token));
  assert.equal(body!.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(!JSON.stringify(body).includes(WALLET));
  assert.ok(body!.html.includes("&lt;b&gt;refund&lt;/b&gt;"));
});

// ── HTTP ────────────────────────────────────────────────────────────────────

test("subscribe, read, change and unsubscribe over HTTP", async () => {
  reset();
  fakeProvider("email");
  const app = express().use(express.json()).use(notificationRoutes);

  const channels = await request(app).get("/notifications/channels");
  assert.deepEqual(channels.body.channels, ["email"]);

  assert.equal(
    (await request(app).post("/notifications/subscriptions").send({ channel: "webpush", destination: {} })).status,
    400,
    "an unconfigured channel is refused",
  );

  const created = await request(app)
    .post("/notifications/subscriptions")
    .send({ channel: "email", destination: "voter@example.org", eventTypes: ["election_started"] });
  assert.equal(created.status, 201);
  const { token } = created.body;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(created.body.destinationHint, "v***@example.org");
  assert.ok(!JSON.stringify(created.body).includes("voter@example.org"));

  const changed = await request(app).patch(`/notifications/subscriptions/${token}`).send({ daoIds: ["7"] });
  assert.deepEqual(changed.body.daoIds, ["7"]);
  assert.deepEqual(changed.body.eventTypes, ["election_started"]);

  const unsubscribed = await request(app).get(`/notifications/unsubscribe?token=${token}`).set("accept", "text/html");
  assert.equal(unsubscribed.status, 200);
  assert.match(unsubscribed.text, /unsubscribed/);
  assert.equal((await request(app).get(`/notifications/subscriptions/${token}`)).status, 404);
  assert.equal((await request(app).delete(`/notifications/subscriptions/${"0".repeat(64)}`)).status, 200, "unknown tokens reveal nothing");
});
