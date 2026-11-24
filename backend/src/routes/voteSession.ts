/**
 * Vote session lifecycle (#750). See services/voteSession.ts.
 *
 *   POST /vote-session         { key, network } -> 201 { sessionId, expiresAt }
 *   POST /vote-session/revoke  { sessionId }    -> 204
 *
 * Neither endpoint takes a wallet address or signature: sessions must stay
 * unlinkable to the ballots they later carry (#644). Revoke is a POST
 * because CORS only allows GET/POST.
 */

import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { bodyLimit, voteLimiter } from "../middleware/index.js";
import {
  createVoteSession,
  revokeVoteSession,
} from "../services/voteSession.js";

const router = Router();

router.post(
  "/vote-session",
  bodyLimit("1kb"),
  voteLimiter,
  (req: Request, res: Response) => {
    const result = createVoteSession(
      req.body?.key,
      req.body?.network,
      config.networkPassphrase,
    );
    if (!result.ok) {
      const network = result.code === "NETWORK_MISMATCH";
      res.status(network ? 409 : 400).json({
        error: network
          ? "Your wallet is on a different Stellar network than the relayer."
          : "key must be 32 random bytes, base64-encoded",
        code: result.code,
      });
      return;
    }
    res.status(201).json({
      sessionId: result.sessionId,
      expiresAt: new Date(result.expiresAt).toISOString(),
    });
  },
);

router.post(
  "/vote-session/revoke",
  bodyLimit("1kb"),
  (req: Request, res: Response) => {
    revokeVoteSession(req.body?.sessionId);
    res.status(204).end();
  },
);

export default router;
