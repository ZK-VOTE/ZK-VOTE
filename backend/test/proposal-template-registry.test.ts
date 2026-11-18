import { strict as assert } from "node:assert";
import { test } from "node:test";
import { proposalMetadataSchema } from "../src/validation/schemas.js";

test("ZV-128 accepts a supported template/version in proposal metadata", () => {
  const result = proposalMetadataSchema.safeParse({
    version: 1, body: "## A valid proposal", template: { id: "quick-poll", version: 1 },
  });
  assert.equal(result.success, true);
});

test("ZV-128 rejects unknown versions, malicious video URLs and oversized bodies", () => {
  for (const value of [
    { version: 1, body: "valid", template: { id: "quick-poll", version: 999 } },
    { version: 1, body: "valid", template: { id: "unknown", version: 1 } },
    { version: 1, body: "valid", videoUrl: "javascript:alert(1)" },
    { version: 1, body: "a".repeat(100001) },
  ]) {
    assert.equal(proposalMetadataSchema.safeParse(value).success, false);
  }
});
