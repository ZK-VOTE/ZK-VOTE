/**
 * /vote session guard (#750). See services/voteSession.ts for the model.
 *
 * Headers:
 *   X-Vote-Session      session id from POST /vote-session
 *   X-Vote-Session-Mac  hex HMAC-SHA256(session key, canonicalVoteBinding)
 *   X-Vote-Network      hex SHA-256 of the network passphrase the vote was built for
 *
 * A request that carries a session is always verified, so a stale or
 * captured artifact cannot be replayed. A request without one is accepted
 * only while VOTE_SESSION_REQUIRED is false (rollout: ship the frontend,
 * then turn it on).
 */

import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { decryptProofPayload } from "../services/proof-encryption.js";
import {
  nullifierSpender,
  recordNullifierOwner,
  verifyVoteBinding,
  type VoteBindingFields,
} from "../services/voteSession.js";

export const VOTE_SESSION_HEADERS = [
  "X-Vote-Session",
  "X-Vote-Session-Mac",
  "X-Vote-Network",
] as const;

const MESSAGES: Record<string, string> = {
  VOTE_SESSION_REQUIRED:
    "This vote must be submitted from an active wallet session.",
  VOTE_SESSION_STALE:
    "The wallet session this vote was built in has ended. Reconnect the same account to submit it.",
  VOTE_SESSION_INVALID: "The vote does not match the wallet session it claims.",
  NETWORK_MISMATCH:
    "This vote was built for a different Stellar network than the relayer.",
};

function bindingFields(
  body: Record<string, unknown>,
): VoteBindingFields | null {
  let fields = body;
  if (fields.encryptedPayload) {
    try {
      fields = decryptProofPayload(fields.encryptedPayload as never) as Record<
        string,
        unknown
      >;
    } catch {
      return null; // the vote handler answers the decryption failure itself
    }
  }
  if (typeof fields.nullifier !== "string" || typeof fields.root !== "string")
    return null;
  return {
    daoId: Number(fields.daoId),
    proposalId: Number(fields.proposalId),
    choice: fields.choice === true,
    nullifier: fields.nullifier,
    root: fields.root,
  };
}

export function voteSessionGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const sessionId = req.header("X-Vote-Session") || undefined;

  if (!sessionId) {
    if (config.voteSessionRequired) {
      res.status(401).json({
        error: MESSAGES.VOTE_SESSION_REQUIRED,
        code: "VOTE_SESSION_REQUIRED",
      });
      return;
    }
    next();
    return;
  }

  const fields = bindingFields(req.body ?? {});
  if (!fields) {
    next();
    return;
  }

  const result = verifyVoteBinding(
    sessionId,
    req.header("X-Vote-Session-Mac"),
    req.header("X-Vote-Network"),
    fields,
  );
  if (!result.ok) {
    log("warn", "vote_session_rejected", { code: result.code });
    res
      .status(result.status)
      .json({ error: MESSAGES[result.code], code: result.code });
    return;
  }

  // Attribute nullifier conflicts: tell the client whether *its* session
  // spent this nullifier or another one did (possible credential theft).
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode === 409 && body && typeof body === "object") {
      const spender = nullifierSpender(fields.nullifier, sessionId);
      if (spender) (body as Record<string, unknown>).conflictSource = spender;
    }
    return json(body);
  }) as Response["json"];

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      recordNullifierOwner(fields.nullifier, sessionId);
    }
  });

  next();
}
