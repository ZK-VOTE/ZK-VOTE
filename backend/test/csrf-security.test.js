/**
 * CSRF Security Tests (csrf-security.test.js)
 *
 * Tests the csrfGuard middleware decision logic described in issue #333:
 *
 *   1. GET/HEAD/OPTIONS → always pass through
 *   2. No Origin AND no Referer → pass through (server-to-server)
 *   3. Wildcard CORS → block
 *   4. origin === "null" → block
 *   5. Malformed Referer → block
 *   6. Origin NOT in allow-list → block
 *   7. Allowed origin + no X-CSRF-Token → block
 *   8. Allowed origin + invalid X-CSRF-Token → block
 *   9. Allowed origin + valid X-CSRF-Token → allow
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.CORS_ORIGIN = "https://app.example.com";

// ---- Import middleware and token utilities after env is set ----
const { csrfGuard } = await import("../src/middleware/csrf.js");
const { generateCsrfToken } = await import("../src/utils/csrf.js");

// ---- Test helpers ----

/**
 * Build a minimal Express-compatible mock request object.
 */
function createRequest({ method = "POST", headers = {}, path = "/vote" } = {}) {
  // Normalise header keys to lower-case (Express does this internally)
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return {
    method,
    headers: normalized,
    path,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  };
}

/**
 * Create a minimal Express-compatible mock response object.
 */
function createResponse() {
  const state = { statusCode: 200, body: undefined };
  const response = {
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(body) {
      state.body = body;
      return response;
    },
  };
  return { response, state };
}

/**
 * Run csrfGuard and return { nextCalled, statusCode, body }.
 */
function runCsrf(reqOpts = {}) {
  const req = createRequest(reqOpts);
  const { response, state } = createResponse();
  let nextCalled = false;

  csrfGuard(req, response, () => {
    nextCalled = true;
  });

  return { nextCalled, statusCode: state.statusCode, body: state.body };
}

/**
 * Run csrfGuard with a pre-seeded CSRF token that was generated for the
 * same request fingerprint.  The token is injected into the request headers
 * so the validator finds the matching entry in the in-memory store.
 */
function runCsrfWithValidToken(baseHeaders = {}, extraReqOpts = {}) {
  // Build the base request to capture the session fingerprint
  const baseReq = createRequest({ ...extraReqOpts, headers: baseHeaders });
  // Generate a token stored under that fingerprint
  const token = generateCsrfToken(baseReq);
  // Now run the guard with the same request + the generated token header
  const req = createRequest({
    ...extraReqOpts,
    headers: { ...baseHeaders, "x-csrf-token": token },
  });
  const { response, state } = createResponse();
  let nextCalled = false;
  csrfGuard(req, response, () => { nextCalled = true; });
  return { nextCalled, statusCode: state.statusCode, body: state.body };
}

// =====================================================================
// 1. Safe HTTP methods bypass CSRF checks entirely
// =====================================================================

test("GET requests bypass CSRF checks regardless of origin", () => {
  const result = runCsrf({
    method: "GET",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("HEAD requests bypass CSRF checks", () => {
  const result = runCsrf({ method: "HEAD" });
  assert.equal(result.nextCalled, true);
});

test("OPTIONS requests bypass CSRF checks", () => {
  const result = runCsrf({ method: "OPTIONS" });
  assert.equal(result.nextCalled, true);
});

// =====================================================================
// 2. Server-to-server bypass (no browser Origin/Referer)
// =====================================================================

test("server-to-server request without Origin and Referer is accepted", () => {
  // No browser headers → cannot be a CSRF attack
  const result = runCsrf({ method: "POST", headers: {} });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("server-to-server PUT request without Origin and Referer is accepted", () => {
  const result = runCsrf({ method: "PUT", headers: {} });
  assert.equal(result.nextCalled, true);
});

test("server-to-server DELETE request without Origin and Referer is accepted", () => {
  const result = runCsrf({ method: "DELETE", headers: {} });
  assert.equal(result.nextCalled, true);
});

// =====================================================================
// 3. Allowed origin + valid CSRF token → accept
// =====================================================================

test("browser request from allowed origin with valid CSRF token is accepted", () => {
  const result = runCsrfWithValidToken({
    origin: "https://app.example.com",
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("browser request using Referer from allowed origin with valid CSRF token is accepted", () => {
  const result = runCsrfWithValidToken({
    referer: "https://app.example.com/proposals/42",
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

// =====================================================================
// 4. Allowed origin + missing CSRF token → reject
// =====================================================================

test("browser request from allowed origin WITHOUT CSRF token is rejected", () => {
  const result = runCsrf({
    headers: { origin: "https://app.example.com" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Invalid or missing CSRF token" });
});

test("browser Referer from allowed origin WITHOUT CSRF token is rejected", () => {
  const result = runCsrf({
    headers: { referer: "https://app.example.com/proposals/42" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Invalid or missing CSRF token" });
});

// =====================================================================
// 5. Allowed origin + invalid CSRF token → reject
// =====================================================================

test("browser request from allowed origin with invalid CSRF token is rejected", () => {
  const result = runCsrf({
    headers: {
      origin: "https://app.example.com",
      "x-csrf-token": "not-a-real-token-deadbeef",
    },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Invalid or missing CSRF token" });
});

// =====================================================================
// 6. Hostile / mismatched Origin → reject
// =====================================================================

test("hostile Origin is rejected", () => {
  const result = runCsrf({
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});

test("hostile Referer is rejected", () => {
  const result = runCsrf({
    headers: { referer: "https://attacker.example/exploit" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});

test("Origin header takes precedence over a legitimate Referer", () => {
  // Even if Referer is allowed, a hostile Origin header wins
  const result = runCsrf({
    headers: {
      origin: "https://attacker.example",
      referer: "https://app.example.com/proposals/42",
    },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});

// =====================================================================
// 7. Edge cases
// =====================================================================

test('origin "null" (sandboxed iframe / data URI) is rejected', () => {
  const result = runCsrf({
    headers: { origin: "null" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Null origin not allowed" });
});

test("malformed Referer fails closed rather than throwing", () => {
  const result = runCsrf({
    headers: { referer: "not a valid absolute URL" },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});
