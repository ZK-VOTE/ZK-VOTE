import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getAllowedOrigins,
  createCorsOptions,
} from "../src/cors-config.js";

describe("CORS Configuration", () => {
  test("getAllowedOrigins parses comma-separated origins", () => {
    assert.deepEqual(
      getAllowedOrigins("https://a.example.com, https://b.example.com"),
      ["https://a.example.com", "https://b.example.com"]
    );
    assert.deepEqual(getAllowedOrigins("https://single.example.com"), [
      "https://single.example.com",
    ]);
    assert.deepEqual(getAllowedOrigins("  "), []);
    assert.deepEqual(getAllowedOrigins(["https://array.example.com"]), [
      "https://array.example.com",
    ]);
  });

  test("getAllowedOrigins returns '*' by default", () => {
    assert.deepEqual(getAllowedOrigins(), ["*"]);
  });

  test("createCorsOptions allows exact origin", () => {
    const options = createCorsOptions(["https://app.example.com"]);
    const callback = (err: Error | null, allow?: boolean) => {
      assert.equal(err, null);
      assert.equal(allow, true);
    };
    options.origin("https://app.example.com", callback as Function);
  });

  test("createCorsOptions rejects disallowed origin with error", () => {
    const options = createCorsOptions(["https://app.example.com"]);
    const callback = (err: Error | null, allow?: boolean) => {
      assert.ok(err);
      assert.equal(allow, undefined);
    };
    options.origin("https://evil.example.com", callback as Function);
  });

  test("createCorsOptions allows no origin (non-browser)", () => {
    const options = createCorsOptions(["https://app.example.com"]);
    const callback = (err: Error | null, allow?: boolean) => {
      assert.equal(err, null);
      assert.equal(allow, true);
    };
    options.origin(undefined, callback as Function);
  });

  test("createCorsOptions restricts methods, headers, and maxAge", () => {
    const options = createCorsOptions(["https://app.example.com"]);
    assert.deepEqual(options.methods, ["GET", "POST", "OPTIONS"]);
    assert.deepEqual(options.allowedHeaders, [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
    ]);
    assert.equal(options.maxAge, 3600);
  });

  test("createCorsOptions throws in production with '*'", () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => createCorsOptions(["*"]), /must be a specific origin/);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});