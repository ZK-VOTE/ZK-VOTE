import test from "node:test";
import assert from "node:assert/strict";
import { hasBidiOverrides, stripBidiOverrides, validateBidiSafe } from "../src/utils/bidi.js";

test("ZV-130: repeated bidi probes do not toggle due to RegExp.lastIndex", () => {
  const spoof = "transfer\u202Eexample.com\u202C";
  assert.equal(hasBidiOverrides(spoof), true);
  assert.equal(hasBidiOverrides(spoof), true);
  assert.equal(validateBidiSafe(spoof), false);
  assert.equal(stripBidiOverrides(spoof), "transferexample.com");
  assert.equal(validateBidiSafe("نص عربي آمن"), true);
});
