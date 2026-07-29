import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_AUTH_TOKEN = "correct-test-token";

const { authGuard, extractAuthToken } = await import(
  "../src/middleware/auth.js"
);

function createResponse() {
  const state = {
    statusCode: 200,
    body: undefined,
  };

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

function runAuth(headers = {}) {
  const { response, state } = createResponse();
  let nextCalled = false;

  authGuard(
    {
      headers,
      path: "/vote",
    },
    response,
    () => {
      nextCalled = true;
    },
  );

  return {
    nextCalled,
    statusCode: state.statusCode,
    body: state.body,
  };
}

test("extractAuthToken supports Bearer and x-relayer-auth headers", () => {
  assert.equal(
    extractAuthToken({
      headers: {
        authorization: "Bearer correct-test-token",
      },
    }),
    "correct-test-token",
  );

  assert.equal(
    extractAuthToken({
      headers: {
        "x-relayer-auth": "correct-test-token",
      },
    }),
    "correct-test-token",
  );
});

test("extractAuthToken rejects absent headers", () => {
  assert.equal(extractAuthToken({ headers: {} }), undefined);
});

test("authGuard accepts the exact configured token", () => {
  const result = runAuth({
    authorization: "Bearer correct-test-token",
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, undefined);
});

test("authGuard rejects missing and malformed authorization", () => {
  for (const headers of [
    {},
    { authorization: "Basic correct-test-token" },
    { authorization: "Bearer " },
  ]) {
    const result = runAuth(headers);

    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.body, { error: "Unauthorized" });
  }
});

test("authGuard rejects an incorrect token of equal length", () => {
  const result = runAuth({
    authorization: "Bearer xorrect-test-token",
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: "Unauthorized" });
});

test("authGuard safely rejects shorter and longer tokens repeatedly", () => {
  const invalidTokens = [
    "x",
    "short-token",
    "correct-test-token-extra-content",
  ];

  for (let iteration = 0; iteration < 10; iteration++) {
    for (const token of invalidTokens) {
      const result = runAuth({
        authorization: `Bearer ${token}`,
      });

      assert.equal(result.nextCalled, false);
      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.body, { error: "Unauthorized" });
    }
  }
});
