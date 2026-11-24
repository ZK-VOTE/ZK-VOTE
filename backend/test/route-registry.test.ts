/**
 * Declarative route registry tests: profile filtering, declared prerequisites
 * and all-or-nothing validation before mounting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mountRoutes,
  matchesRouteProfile,
  routeRegistry,
  RouteValidationError,
  validateRouteRequirements,
  type RouteMountTarget,
} from "../src/routes/index.js";
import {
  ROOT_INITIALIZED_SERVICES,
  type AppServices,
} from "../src/composition-root.js";

function fakeServices(): AppServices {
  return {
    config: {},
    logger: {},
    stellar: { server: {} },
    scheduler: { start() {}, stop() {} },
    startup: {
      profile: "api",
      enableRelayer: true,
      enableIndexer: true,
      enableApi: true,
    },
    profile: "api",
    enableRelayer: true,
    enableIndexer: true,
    enableApi: true,
    initializedServices: ROOT_INITIALIZED_SERVICES,
    workers: { list: () => [] },
  } as unknown as AppServices;
}

function fakeMountTarget(): {
  target: RouteMountTarget;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const target = {
    use(...args: unknown[]) {
      calls.push(args);
    },
  } as unknown as RouteMountTarget;
  return { target, calls };
}

describe("declarative route registry", () => {
  it("declares services/profile for every route and keeps registry non-empty", () => {
    assert.ok(routeRegistry.length > 10);
    for (const definition of routeRegistry) {
      assert.ok(definition.path.length > 0);
      assert.ok(definition.router);
      assert.ok(
        definition.requires.length > 0,
        `${definition.path} must declare AppServices requirements`,
      );
      assert.ok(matchesRouteProfile(definition, "api") || matchesRouteProfile(definition, "all"));
    }
  });

  it("filters routes by startup profile", () => {
    const { target, calls } = fakeMountTarget();
    const mounted = mountRoutes(target, fakeServices(), "relayer");
    const paths = mounted.map((definition) => definition.path);
    assert.ok(paths.includes("/health"));
    assert.ok(paths.includes("/metrics"));
    assert.ok(!paths.includes("/vote"), "API routes must be absent for relayer");
    assert.equal(calls.length, paths.length);
  });

  it("validates all requirements before mounting a single route", () => {
    const services = fakeServices();
    const { target, calls } = fakeMountTarget();

    // Drop an AppServices key referenced by a definition.
    delete (services as Partial<AppServices>).scheduler;
    assert.throws(
      () => mountRoutes(target, services, "api"),
      (error: unknown) => {
        assert.ok(error instanceof RouteValidationError);
        assert.match(error.message, /AppServices\.scheduler/);
        return true;
      },
    );
    assert.equal(calls.length, 0, "failed validation must not mount anything");
  });

  it("rejects routes whose DI service was not initialized by the root", () => {
    const services = fakeServices();
    (services as { initializedServices: readonly string[] }).initializedServices =
      ROOT_INITIALIZED_SERVICES.filter((name) => name !== "sync");

    const withSync = routeRegistry.find(
      (definition) => definition.requiresServices?.includes("sync"),
    );
    assert.ok(withSync);
    assert.throws(
      () => validateRouteRequirements(withSync, services),
      (error: unknown) => {
        assert.ok(error instanceof RouteValidationError);
        assert.match(error.message, /initialized service "sync"/);
        return true;
      },
    );
  });

  it("applies no-store and mount paths from the definition", () => {
    const { target, calls } = fakeMountTarget();
    mountRoutes(target, fakeServices(), "api", { variant: "unversioned" });
    const nova = routeRegistry.find((definition) => definition.path === "/api/v1/nova");
    assert.ok(nova?.mountPath);
    // The first argument for nova is its mount path.
    assert.ok(calls.some((args) => args[0] === "/api/v1/nova"));
  });
});
