import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.CORS_ORIGIN = "https://app.example.com";

const { csrfGuard } = await import("../src/middleware/csrf.js");

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

function runCsrf({
  method = "POST",
  headers = {},
  path = "/vote",
} = {}) {
  const { response, state } = createResponse();
  let nextCalled = false;

  csrfGuard(
    {
      method,
      headers,
      path,
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

test("safe HTTP methods bypass CSRF origin checks", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const result = runCsrf({
      method,
      headers: {
        origin: "https://attacker.example",
      },
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, 200);
  }
});

test("same-origin write request is accepted", () => {
  const result = runCsrf({
    headers: {
      origin: "https://app.example.com",
    },
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("same-origin Referer is accepted when Origin is absent", () => {
  const result = runCsrf({
    headers: {
      referer: "https://app.example.com/proposals/42",
    },
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("server-to-server request without browser origin headers is accepted", () => {
  const result = runCsrf();

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("hostile Origin is rejected", () => {
  const result = runCsrf({
    headers: {
      origin: "https://attacker.example",
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});

test("hostile Referer is rejected", () => {
  const result = runCsrf({
    headers: {
      referer: "https://attacker.example/exploit",
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});

test("Origin takes precedence over an allowed Referer", () => {
  const result = runCsrf({
    headers: {
      origin: "https://attacker.example",
      referer: "https://app.example.com/proposals/42",
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test("malformed Referer fails closed rather than throwing", () => {
  const result = runCsrf({
    headers: {
      referer: "not a valid absolute URL",
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: "Origin not allowed" });
});
