import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { parseStroops } from "../utils/stellarAmount.js";

const ttlMs = 30_000;
// A restart invalidates quotes if no shared secret is configured: fail closed.
const secret = config.relayerAuthToken || config.authMasterKey || randomBytes(32).toString("hex");

export interface BoundQuote {
  from: "XLM" | "USDC" | "EURC";
  to: "XLM" | "USDC" | "EURC";
  amount: string;
  destAmount: string;
  source: "horizon";
  expiresAt: number;
}

export function signSwapQuote(quote: Omit<BoundQuote, "expiresAt">, now = Date.now()): string {
  parseStroops(quote.destAmount);
  const payload = Buffer.from(JSON.stringify({ ...quote, expiresAt: now + ttlMs })).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifySwapQuote(token: string, from: string, to: string, amount: string, now = Date.now()): BoundQuote {
  if (token.length > 2048) throw new Error("Invalid quote token");
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra) throw new Error("Invalid quote token");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error("Invalid quote signature");
  const quote: BoundQuote = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (quote.source !== "horizon" || quote.from !== from || quote.to !== to || quote.amount !== amount) {
    throw new Error("Quote does not match swap parameters");
  }
  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt < now || quote.expiresAt > now + ttlMs) {
    throw new Error("Quote expired or invalid");
  }
  parseStroops(quote.destAmount);
  return quote;
}
