// @ts-nocheck
import { Router } from "express";
import { sep6Deposit, sep6Withdraw } from "../services/anchor.js";
import {
  queryLimiter,
  csrfOriginGuard,
  masterKeyGuard,
} from "../middleware/index.js";
import {
  parseMuxedAddress,
  validateDepositDestination,
  recordMuxedDeposit,
} from "../services/muxed-deposit-router.js";
import {
  createSEP24Session,
  validateSEP24Session,
  rotateSEP24Token,
  validatePopupParent,
  validatePopupOrigin,
  verifyPopupNonce,
} from "../services/sep24-session-security.js";
import originPolicy from "../../../frontend/src/config/message-origin-policy.json";

const router = Router();

function parseRampQuery(query: Record<string, unknown>) {
  const asset = query.asset;
  const account = query.account;
  const amount = query.amount;
  if (asset !== "USDC" && asset !== "EURC") {
    throw new Error("asset must be USDC or EURC");
  }
  if (typeof account !== "string" || !(/^G[A-Z2-7]{55}$/.test(account) || /^M[A-Z2-7]{68}$/.test(account))) {
    throw new Error("account must be a valid Stellar G or M address");
  }
  if (typeof amount !== "string" || !/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error("amount must be a positive decimal string with up to 7 decimals");
  }
  return { asset, account, amount };
}

router.get("/ramp/deposit", masterKeyGuard, queryLimiter, async (req, res) => {
  let input: ReturnType<typeof parseRampQuery>;
  try {
    input = parseRampQuery(req.query as Record<string, unknown>);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  try {
    // SPIKE-094: Validate muxed account routing for proper deposit attribution
    const route = parseMuxedAddress(input.account);
    const destValidation = await validateDepositDestination(input.account, input.asset);

    if (!destValidation.valid) {
      return res.status(400).json({
        error: destValidation.reason,
        account: input.account,
      });
    }

    // Create SEP-24 session for interactive flows (#762)
    const origin = req.headers.origin || "unknown";
    const session = createSEP24Session(input.asset, route.baseAccount, origin);

    const r = await sep6Deposit(input.asset, input.account, input.amount);

    // Attach session info to response for client-side popup handling
    res.json({
      ...r,
      session: {
        sessionId: session.sessionId,
        token: session.token,
        popupNonce: session.popupNonce,
      },
      muxRoute: {
        destination: route.destination,
        isMuxed: route.isMuxed,
        attributionId: route.attributionId,
      },
    });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

router.get(
  "/ramp/withdraw",
  masterKeyGuard,
  csrfOriginGuard,
  queryLimiter,
  async (req, res) => {
    let input: ReturnType<typeof parseRampQuery>;
    try {
      input = parseRampQuery(req.query as Record<string, unknown>);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
    try {
      // Validate muxed account routing for withdrawals
      const route = parseMuxedAddress(input.account);
      const destValidation = await validateDepositDestination(input.account, input.asset);

      if (!destValidation.valid) {
        return res.status(400).json({
          error: destValidation.reason,
          account: input.account,
        });
      }

      // Create secure SEP-24 session for withdrawal flow
      const origin = req.headers.origin || "unknown";
      const session = createSEP24Session(input.asset, route.baseAccount, origin);

      const dest = typeof req.query.dest === "string" ? req.query.dest : "bank";
      const r = await sep6Withdraw(
        input.asset,
        input.account,
        input.amount,
        dest,
      );

      res.json({
        ...r,
        session: {
          sessionId: session.sessionId,
          token: session.token,
          popupNonce: session.popupNonce,
        },
        muxRoute: {
          destination: route.destination,
          isMuxed: route.isMuxed,
          attributionId: route.attributionId,
        },
      });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  },
);


/**
 * Consume the SEP-24 popup nonce after the browser validates source, origin,
 * and message schema. The nonce is one-use and bound to the session parent.
 */
router.post(
  "/ramp/session/nonce/consume",
  masterKeyGuard,
  csrfOriginGuard,
  queryLimiter,
  (req, res) => {
    const { sessionId, token, popupNonce, popupOrigin } = req.body ?? {};
    if (
      typeof sessionId !== "string" ||
      typeof token !== "string" ||
      typeof popupNonce !== "string" ||
      typeof popupOrigin !== "string"
    ) {
      return res.status(400).json({ error: "Invalid popup verification payload" });
    }

    const session = validateSEP24Session(sessionId, token);
    if (!session.valid) return res.status(401).json({ error: "Invalid SEP-24 session" });

    const parentOrigin = req.headers.origin;
    if (
      typeof parentOrigin !== "string" ||
      !validatePopupParent(sessionId, parentOrigin) ||
      !validatePopupOrigin(new Set(originPolicy.flows.sep24), popupOrigin)
    ) {
      return res.status(403).json({ error: "Untrusted popup or parent origin" });
    }

    if (!verifyPopupNonce(sessionId, popupNonce)) {
      return res.status(409).json({ error: "Popup nonce is stale or already used" });
    }
    return res.json({ accepted: true });
  },
);

// Route for SEP-24 session token rotation (prevent session fixation)
router.post(
  "/ramp/session/rotate",
  masterKeyGuard,
  async (req, res) => {
    try {
      const { sessionId, currentToken } = req.body;

      if (!sessionId || !currentToken) {
        return res.status(400).json({
          error: "sessionId and currentToken are required",
        });
      }

      // Validate current token first
      const validation = validateSEP24Session(sessionId, currentToken);
      if (!validation.valid) {
        return res.status(401).json({
          error: validation.reason,
        });
      }

      // Rotate to new token
      const rotated = rotateSEP24Token(sessionId, currentToken);
      if (!rotated) {
        return res.status(401).json({
          error: "Failed to rotate token",
        });
      }

      res.json({
        sessionId,
        newToken: rotated.newToken,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);

export default router;
