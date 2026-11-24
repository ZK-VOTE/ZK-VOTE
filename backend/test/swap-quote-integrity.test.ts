import test from "node:test";
import assert from "node:assert/strict";
import { signSwapQuote, verifySwapQuote } from "../src/services/swap-quote-integrity.js";

const quote = { from: "XLM" as const, to: "USDC" as const, amount: "10.0000000", destAmount: "9.5000000", source: "horizon" as const };

test("quote signature binds pair, amount, price and short expiry", () => {
  const token = signSwapQuote(quote, 1000);
  assert.deepEqual(verifySwapQuote(token, quote.from, quote.to, quote.amount, 2000), { ...quote, expiresAt: 31000 });
  assert.throws(() => verifySwapQuote(token, "EURC", quote.to, quote.amount, 2000), /does not match/);
  assert.throws(() => verifySwapQuote(token, quote.from, quote.to, "11.0000000", 2000), /does not match/);
  assert.throws(() => verifySwapQuote(token, quote.from, quote.to, quote.amount, 31001), /expired/);
  const payload = token.split(".")[0];
  assert.throws(() => verifySwapQuote(payload + ".invalid", quote.from, quote.to, quote.amount, 2000), /signature/);
});
