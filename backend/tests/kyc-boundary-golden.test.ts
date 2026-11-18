import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enforceMinimizationBoundary } from "../src/services/kycBoundary.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/anchor-responses.json", import.meta.url), "utf8"));

test("anchor response golden inventory", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      if (fixture.accepted) {
        assert.doesNotThrow(() => enforceMinimizationBoundary(fixture.response));
      } else {
        assert.throws(() => enforceMinimizationBoundary(fixture.response), /outside the minimized KYC schema/);
      }
    });
  }
});

test("unknown anchor fields are rejected without strict-mode opt-in", () => {
  const previous = process.env.KYC_STRICT_MODE;
  delete process.env.KYC_STRICT_MODE;
  try {
    assert.throws(() => enforceMinimizationBoundary({ status: "completed", tracking_id: "REDACTED" }), /outside the minimized KYC schema/);
  } finally {
    if (previous === undefined) delete process.env.KYC_STRICT_MODE;
    else process.env.KYC_STRICT_MODE = previous;
  }
});
