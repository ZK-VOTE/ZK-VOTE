import test from "node:test";
import assert from "node:assert/strict";
import {
  detectConfusableMixedScript,
  isConfusableName,
} from "../src/utils/confusables.js";

test("flags a Latin name with a Cyrillic look-alike substituted in", () => {
  // "Ьtellar" with a Cyrillic а replacing the Latin a: "Stellаr"
  const spoofed = "Stellаr"; // а = Cyrillic а
  const result = detectConfusableMixedScript(spoofed);
  assert.equal(result.confusable, true);
  assert.equal(result.skeleton, "Stellar");
});

test("flags a Latin name with a Greek look-alike substituted in", () => {
  const spoofed = "Sρlit"; // Greek rho (ρ) instead of Latin p -> "Split" skeleton
  const result = detectConfusableMixedScript(spoofed);
  assert.equal(result.confusable, true);
  assert.equal(result.skeleton, "Split");
});

test("does not flag an all-Latin name", () => {
  const result = detectConfusableMixedScript("ZKVote Governance DAO");
  assert.equal(result.confusable, false);
  assert.equal(result.skeleton, "ZKVote Governance DAO");
});

test("does not flag a name written entirely in Cyrillic", () => {
  const result = detectConfusableMixedScript("Привет");
  assert.equal(result.confusable, false);
});

test("does not flag a name written entirely in Greek", () => {
  const result = detectConfusableMixedScript("Αθήνα");
  assert.equal(result.confusable, false);
});

test("does not flag a plain ASCII name with no confusable characters", () => {
  assert.equal(isConfusableName("Acme Collective"), false);
});

test("isConfusableName matches detectConfusableMixedScript", () => {
  const spoofed = "DаO"; // Cyrillic а (U+0430) in place of Latin 'a'
  assert.equal(
    isConfusableName(spoofed),
    detectConfusableMixedScript(spoofed).confusable,
  );
});
