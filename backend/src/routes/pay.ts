// @ts-nocheck
import { Router } from "express";
import {
  sendPayment,
  sendBatch,
  getTrustlineStatus,
  type PaymentAsset,
} from "../services/payments.js";
import { bodyLimit, queryLimiter, csrfOriginGuard, paymentBatchCostLimiter, masterKeyGuard } from "../middleware/index.js";
import { Histogram } from "prom-client";
// metrics.ts does not currently export paymentOpsPerMinute; keep the metric on
// the route so importing this router does not fail module instantiation.
const paymentOpsPerMinute = new Histogram({
  name: "zkvote_payment_ops_per_batch",
  help: "Number of payment operations submitted per batch",
  buckets: [1, 5, 10, 25, 50, 100],
});
import { payRequestSchema, payBatchRequestSchema } from "../validation/schemas.js";
import { mapContractError } from "../utils/errors.js";
import { log } from "../services/logger.js";
import { config } from "../config.js";
import { timingSafeEqual } from "node:crypto";
import { extractAuthToken } from "../middleware/auth.js";
import { relayerKeypair } from "../services/stellar.js";
import { submitSponsoredVote } from "../services/payments.js";
import {
  assertRelayerReserve,
  estimateVoteFee,
  getMetrics as getRelayerSponsorshipMetrics,
  normalizedChoice,
  recordRejection,
  recordSponsoredVote,
  recordSubmissionFailure,
  replayGuard,
  RelayerError,
  replayKey,
  sponsorshipBudget,
  sponsorshipTokenKey,
  tokenBucket,
  verifyVoteAuthorization,
  voteAuthorizationSchema,
  type Quota,
  type RelayerRejectionCode,
  type SponsorshipQuota,
  type VoteAuthorization,
} from "../services/relayer-fee-economics.js";

log("info", "pay_routes_loaded", {});

// In-memory idempotency store (keyed by idempotency header)
const paymentIdempotency = new Map<string, { hash: string; timestamp: number }>();

// Clean up old entries every minute
setInterval(() => {
  const now = Date.now();
  const expired = [];
  for (const [key, value] of paymentIdempotency.entries()) {
    if (now - value.timestamp > 60000) { // 1 minute
      expired.push(key);
    }
  }
  for (const key of expired) {
    paymentIdempotency.delete(key);
  }
}, 60000);

const router = Router();

router.get("/pay/trustline", queryLimiter, async (req, res) => {
  const account = typeof req.query.account === "string" ? req.query.account : "";
  const asset = typeof req.query.asset === "string" ? req.query.asset : "";
  if (!account || !["XLM", "USDC", "EURC"].includes(asset)) {
    return res.status(400).json({ error: "account and valid asset are required" });
  }
  try {
    const status = await getTrustlineStatus(account, asset as PaymentAsset);
    return res.json(status);
  } catch (e: any) {
    log("warn", "trustline_preflight_error", {
      asset,
      error: e.message,
    });
    return res.status(502).json({ error: "Unable to verify destination trustline" });
  }
});

router.post("/pay", masterKeyGuard, csrfOriginGuard, bodyLimit("5kb"), async (req, res) => {
  log("info", "pay_hit", {});
  
  // Check idempotency key
  const idempotencyKey = req.header("Idempotency-Key");
  if (idempotencyKey) {
    const existing = paymentIdempotency.get(idempotencyKey);
    if (existing) {
      log("info", "payment_idempotent_hit", { idempotencyKey: idempotencyKey.slice(0, 16), hash: existing.hash });
      return res.status(200).json({ hash: existing.hash, idempotent: true });
    }
  }
  
  try {
    const parsed = payRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid payment request" });
    }
    const { asset, destination, amount, memo } = parsed.data;
    const r = await sendPayment({ asset, destination, amount, memo });
    
    // Store idempotency result
    if (idempotencyKey) {
      paymentIdempotency.set(idempotencyKey, { hash: r.hash, timestamp: Date.now() });
    }
    
    res.json(r);
  } catch (e: any) {
    log("error", "pay_error", { error: e.message });
    const mapped = mapContractError(e);
    if (mapped) {
      return res.status(mapped.statusCode).json({ error: mapped.message, code: mapped.code });
    }
    const trustlineError = /trustline|issuer authorization/i.test(String(e.message));
    res.status(trustlineError ? 409 : 500).json({
      error: trustlineError ? e.message : "Payment failed",
    });
  }
});

import {
  batch_partial_failure_total,
  abuseDetectionTotal,
  abusePatternConfidence,
  suspiciousPaymentVolume,
  paymentDestinationFanout,
  paymentHoldsTotal,
} from "../services/metrics.js";
import {
  analyzeBatchPayment,
  recordAbuseDetection,
  determineAction,
  placeOnHold,
  AbuseAction,
  AbusePattern,
} from "../services/abuseDetection.js";

router.post("/pay/batch", csrfOriginGuard, bodyLimit("256kb"), async (req, res) => {
  try {
    const parsed = payBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "ops array required" });
    }
    const { ops } = parsed.data;

    // Record ops per minute metric
    paymentOpsPerMinute.observe(ops.length);
    
    // Record destination fanout for mule detection
    const uniqueDestinations = new Set(ops.map((op: any) => op.destination)).size;
    paymentDestinationFanout.observe(uniqueDestinations);
    
    // Apply cost-based rate limiting
    const costFn = (req as any).rateLimit?.cost;
    if (costFn && costFn(ops.length)) {
      // Already sent 429 response
      return;
    }

    const headerTenant = req.headers["x-tenant-id"];
    const tenantId =
      typeof headerTenant === "string" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(headerTenant)
        ? headerTenant
        : "default";
    
    // Abuse detection analysis (metadata-only, privacy-bounded)
    const abuseResult = analyzeBatchPayment(tenantId, ops);
    
    if (abuseResult.suspicious) {
      // Record metrics
      for (const pattern of abuseResult.patterns) {
        const confidenceLevel = abuseResult.confidence >= 0.8 ? "high" 
          : abuseResult.confidence >= 0.5 ? "medium" : "low";
        abuseDetectionTotal.inc({ pattern, confidence_level: confidenceLevel });
        abusePatternConfidence.observe({ pattern }, abuseResult.confidence);
      }
      
      // Record total volume of suspicious payments
      const totalAmount = ops.reduce(
        (sum: bigint, op: any) => sum + BigInt(Math.floor(parseFloat(op.amount) * 1e7)),
        BigInt(0)
      );
      for (const pattern of abuseResult.patterns) {
        suspiciousPaymentVolume.observe({ pattern }, Number(totalAmount));
      }
      
      // Log to audit trail
      recordAbuseDetection(abuseResult, tenantId, {
        endpoint: "/pay/batch",
        opsCount: ops.length,
        uniqueDestinations,
      });

      // Graduated enforcement (ZV-111): flag -> hold -> block. A hold/block
      // opens a linked dispute case with a metadata-only evidence bundle so
      // a reviewer can act on it without re-running detection from scratch.
      const action = determineAction(abuseResult.suspicious, abuseResult.confidence);
      if (action === AbuseAction.HOLD || action === AbuseAction.BLOCK) {
        const paymentRef = idempotencyKey || `batch:${Date.now()}:${tenantId}`;
        const enforcement = placeOnHold({
          tenantId,
          paymentRef,
          action,
          patterns: abuseResult.patterns,
          confidence: abuseResult.confidence,
          evidence: {
            opsCount: ops.length,
            uniqueDestinations,
            structuring: abuseResult.metadata.structuring,
            wash: abuseResult.metadata.wash,
            mule: abuseResult.metadata.mule,
          },
        });

        for (const pattern of abuseResult.patterns) {
          paymentHoldsTotal.inc({ pattern, action });
        }

        const statusCode = action === AbuseAction.BLOCK ? 403 : 423;
        return res.status(statusCode).json({
          error:
            action === AbuseAction.BLOCK
              ? "Payment batch blocked due to suspicious patterns"
              : "Payment batch held pending dual-control review",
          patterns: abuseResult.patterns,
          reviewRequired: true,
          holdId: enforcement?.holdId,
          disputeCaseId: enforcement?.disputeCaseId,
        });
      }
    }
    
    const r = await sendBatch(ops, tenantId);

    // Store idempotency result
    if (idempotencyKey) {
      paymentIdempotency.set(idempotencyKey, { hash: r.hash, timestamp: Date.now() });
    }

    res.json(r);
  } catch (e: any) {
    batch_partial_failure_total.inc({
      batch_type: "payments",
      reason: String(e.message || "unknown"),
    });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Sponsored (zero-fee) vote submission — relayer fee bump
// ============================================================

function applySponsorshipHeaders(
  res: any,
  sponsorship: SponsorshipQuota,
  rate: Quota,
): void {
  res.setHeader("X-Sponsorship-Limit", String(sponsorship.limitStroops));
  res.setHeader("X-Sponsorship-Remaining", String(sponsorship.remainingStroops));
  res.setHeader("X-Sponsorship-Reset", String(sponsorship.resetSeconds));
  res.setHeader("X-RateLimit-Limit", String(rate.limit));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  res.setHeader("X-RateLimit-Reset", String(rate.resetSeconds));
  // draft-6 RateLimit-* headers mirror the legacy X-RateLimit-* values.
  res.setHeader("RateLimit-Limit", String(rate.limit));
  res.setHeader("RateLimit-Remaining", String(rate.remaining));
  res.setHeader("RateLimit-Reset", String(Math.max(0, rate.resetSeconds - Math.floor(Date.now() / 1000))));
}

const ABUSE_REJECTIONS = new Set<RelayerRejectionCode>([
  "INVALID_AUTHORIZATION",
  "UNSUPPORTED_VERSION",
  "DOMAIN_MISMATCH",
  "EXPIRED_AUTHORIZATION",
  "INVALID_SIGNATURE",
  "RELAYER_MISMATCH",
  "NONCE_REPLAY",
]);

/**
 * POST /pay/vote
 *
 * The voter supplies no funded transaction and pays no fee. They sign a short
 * lived authorization; the relayer verifies it, charges abuse costs to a
 * (daoId, commitment, relayer) token bucket, reserves budget, consumes the
 * nonce, and submits a fee-bump transaction whose fee source is the relayer.
 */
router.post("/pay/vote", csrfOriginGuard, bodyLimit("16kb"), async (req, res) => {
  const startedAt = Date.now();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const headerDaoId =
    typeof body.daoId === "number" || typeof body.daoId === "string"
      ? String(body.daoId)
      : "0";
  const provisionalAuth = {
    daoId: headerDaoId,
    voter: typeof body.voter === "string" ? body.voter : "unknown",
    relayer: typeof body.relayer === "string" ? body.relayer : relayerKeypair.publicKey(),
    commitment: typeof body.commitment === "string" ? body.commitment : undefined,
  } as unknown as VoteAuthorization;
  const provisionalKey = sponsorshipTokenKey(provisionalAuth);
  let rate = tokenBucket.quota(provisionalKey);
  applySponsorshipHeaders(res, sponsorshipBudget.quota(headerDaoId), rate);

  let reservation: ReturnType<typeof sponsorshipBudget.reserve> | null = null;
  try {
    const parsed = voteAuthorizationSchema.safeParse(body);
    if (!parsed.success) {
      tokenBucket.chargeAbuse(provisionalKey);
      throw new RelayerError(
        "INVALID_AUTHORIZATION",
        400,
        parsed.error.issues[0]?.message ?? "Invalid vote authorization",
      );
    }
    const auth = parsed.data;
    const tokenKey = sponsorshipTokenKey(auth);
    rate = tokenBucket.quota(tokenKey);
    applySponsorshipHeaders(res, sponsorshipBudget.quota(auth.daoId), rate);

    verifyVoteAuthorization(auth, {
      expectedRelayer: relayerKeypair.publicKey(),
      expectedChainId: process.env.VOTE_AUTH_CHAIN_ID || config.networkPassphrase,
    });

    // Reserve before submitting; gracefully degrade when the relayer cannot
    // cover the estimated fee instead of submitting and failing on-chain.
    const estimate = estimateVoteFee();
    assertRelayerReserve(estimate.totalStroops);
    rate = tokenBucket.consume(tokenKey, 1);
    reservation = sponsorshipBudget.reserve(auth.daoId, estimate.totalStroops);
    await replayGuard.consume(replayKey(auth));

    applySponsorshipHeaders(res, sponsorshipBudget.quota(auth.daoId), rate);

    const submission = await submitSponsoredVote(auth, {
      feeStroops: estimate.totalStroops,
    });
    sponsorshipBudget.commit(reservation);
    reservation = null;
    recordSponsoredVote(submission.feeStroops, Date.now() - startedAt);

    applySponsorshipHeaders(res, sponsorshipBudget.quota(auth.daoId), rate);
    res.setHeader("X-Sponsorship-Fee-Stroops", String(submission.feeStroops));
    return res.status(200).json({
      success: true,
      txHash: submission.hash,
      innerTxHash: submission.innerHash,
      feeStroops: submission.feeStroops,
      feeXlm: submission.feeXlm,
      dryRun: submission.dryRun,
      choice: normalizedChoice(auth.choice),
      sponsorship: sponsorshipBudget.quota(auth.daoId),
      rateLimit: rate,
    });
  } catch (err) {
    if (reservation) sponsorshipBudget.release(reservation);
    if (err instanceof RelayerError) {
      recordRejection(err.code);
      if (ABUSE_REJECTIONS.has(err.code)) tokenBucket.chargeAbuse(provisionalKey);
      if (err.retryable) {
        res.setHeader(
          "Retry-After",
          err.code === "RATE_LIMITED" || err.code === "BUDGET_EXHAUSTED" ? "60" : "300",
        );
      }
      log("warn", "sponsored_vote_rejected", {
        code: err.code,
        daoId: headerDaoId,
        dryRun: config.testMode,
      });
      return res
        .status(err.statusCode)
        .json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    recordRejection("SUBMISSION_FAILED");
    recordSubmissionFailure();
    log("error", "sponsored_vote_submission_error", {
      error: (err as Error).message,
      daoId: headerDaoId,
    });
    return res.status(500).json({
      error: "Sponsored vote submission failed",
      code: "SUBMISSION_FAILED",
    });
  }
});

/** GET /pay/metrics — sponsorship counters/histograms (auth-gated like /metrics). */
router.get("/pay/metrics", (req, res) => {
  const token = extractAuthToken(req);
  const expected = config.relayerAuthToken;
  if (expected) {
    const a = Buffer.from(token ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  return res.json(getRelayerSponsorshipMetrics());
});

export default router;
