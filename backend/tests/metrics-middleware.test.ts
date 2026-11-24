/**
 * Regression coverage for #573's `route is not defined` claim.
 *
 * #573 claims `route is not defined` at src/middleware/metrics.ts:50.
 * Reading the current source shows this was already fixed — the file's own
 * doc comment ("Bug fix: the original version referenced `route` before it
 * was defined...") explains the fix directly: the in-flight gauge now uses
 * `inboundRoute` (derived from `req.path` before Express populates
 * `req.route`), while response-side metrics use the resolved
 * `req.route.path` on `finish`. This test exercises that exact code path so
 * a regression back to the old bug shows up as a thrown ReferenceError
 * instead of silently passing.
 *
 * Runs under the backend's node:test runner (tsx), matching
 * tests/logger.test.ts's style.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { metricsMiddleware } from "../src/middleware/metrics.js";
import { httpRequestsInFlight, httpRequestsTotal } from "../src/services/metrics.js";

function makeReqRes(opts: {
  method?: string;
  path?: string;
  routePath?: string;
} = {}) {
  const { method = "GET", path = "/dao/123456789", routePath } = opts;
  const listeners: Record<string, Array<() => void>> = {};
  const req = {
    method,
    path,
    headers: {},
    route: routePath ? { path: routePath } : undefined,
  } as unknown as Request;
  const res = {
    statusCode: 200,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
    },
    getHeader() {
      return undefined;
    },
    end(...args: unknown[]) {
      return args;
    },
  } as unknown as Response;
  return { req, res };
}

describe("metricsMiddleware (#573 route reference)", () => {
  it("does not throw observing httpRequestsInFlight before req.route is populated", () => {
    const { req, res } = makeReqRes({ path: "/dao/123456789" });
    assert.doesNotThrow(() => {
      metricsMiddleware(req, res, (() => {}) as NextFunction);
    });
    httpRequestsInFlight.reset();
  });

  it("labels the in-flight gauge with the route family, not the raw daoId", async () => {
    httpRequestsInFlight.reset();
    const { req, res } = makeReqRes({ path: "/dao/9999999999999999" });
    metricsMiddleware(req, res, (() => {}) as NextFunction);

    // prom-client v15's Gauge/Counter #get() is async.
    const snapshot = await httpRequestsInFlight.get();
    const labelsUsed = snapshot.values.map((v) => v.labels.route);
    // Before routing only the raw path is known, so the in-flight gauge
    // labels the top-level route family (#749).
    assert.ok(
      labelsUsed.every((route) => route === "/dao"),
      `expected only the bounded /dao route family, got: ${JSON.stringify(labelsUsed)}`,
    );
    httpRequestsInFlight.reset();
  });

  it("finalizes on res.end() with the resolved, normalized route", async () => {
    httpRequestsTotal.reset();
    const { req, res } = makeReqRes({
      path: "/dao/42/comment/7",
      routePath: "/dao/:daoId/comment/:commentId",
    });
    metricsMiddleware(req, res, (() => {}) as NextFunction);
    (res as unknown as { end: () => void }).end();

    const snapshot = await httpRequestsTotal.get();
    assert.ok(
      snapshot.values.some((v) => v.labels.route === "/dao/:param/comment/:param"),
      `expected a normalized route label, got: ${JSON.stringify(snapshot.values.map((v) => v.labels))}`,
    );
    httpRequestsTotal.reset();
  });
});
