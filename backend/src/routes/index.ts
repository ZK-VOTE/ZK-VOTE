/**
 * Routes Module Index + declarative route registry.
 *
 * Historically this file was a flat list of re-exports and `index.ts` held a
 * hand-written list of `app.use(...)` calls. The registry below makes the
 * mount order, required services, DI-service prerequisites and startup profile
 * explicit, and `mountRoutes()` validates those requirements **before**
 * mounting anything. The original named re-exports remain as aliases so no
 * existing import site needs to change.
 */

import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import type { AppServices, InitializedServiceName } from "../composition-root.js";
import type {
  ResolvedStartupProfile,
  StartupProfile,
} from "../config.js";

import healthRoutes, { initHealthRoutes } from "./health.js";
import analyticsRoutes from "./analytics.js";
import votingRoutes from "./voting.js";
import daoRoutes from "./daos.js";
import ipfsRoutes from "./ipfs.js";
import commentsRoutes from "./comments.js";
import claimRoutes from "./claim.js";
import indexerRoutes, { initIndexerRoutes } from "./indexer.js";
import bridgeRoutes from "./bridge.js";
import circuitRoutes from "./circuits.js";
import transactionRoutes from "./transactions.js";
import authRoutes from "./auth.js";
import quadraticRoutes from "./quadratic.js";
import metricsRoutes from "./metrics.js";
import remediationRoutes from "./remediation.js";
import novaRoutes from "./nova.js";
import adminRoutes from "./admin.js";
import thresholdRoutes from "./threshold.js";
import auditRoutes from "./audit.js";
import randomnessRoutes from "./randomness.js";
import payRoutes from "./pay.js";
import swapRoutes from "./swap.js";
import rampRoutes from "./ramp.js";

/** Same named aliases as before this refactor. */
export {
  healthRoutes,
  initHealthRoutes,
  analyticsRoutes,
  votingRoutes,
  daoRoutes,
  ipfsRoutes,
  commentsRoutes,
  claimRoutes,
  indexerRoutes,
  initIndexerRoutes,
  bridgeRoutes,
  circuitRoutes,
  transactionRoutes,
  authRoutes,
  quadraticRoutes,
  metricsRoutes,
  remediationRoutes,
  novaRoutes,
  adminRoutes,
  thresholdRoutes,
  auditRoutes,
  randomnessRoutes,
  payRoutes,
  swapRoutes,
  rampRoutes,
};

/** Express mount variants used by the entry point. */
export type RouteVariant = "unversioned" | "v1" | "v2";

/** Declarative description of one mounted router. */
export interface RouteDefinition {
  /** Logical identifier (also used in validation errors). */
  path: string;
  router: Router | RequestHandler;
  /** Keys of `AppServices` that must be present and initialized. */
  requires: ReadonlyArray<keyof AppServices>;
  /** DI services whose `init*` functions must have run in the root. */
  requiresServices?: ReadonlyArray<InitializedServiceName>;
  /** Profiles that include this route; `all` matches every profile. */
  profile: StartupProfile | ReadonlyArray<StartupProfile>;
  /** Mount variants that include this route (default: all). */
  variants?: ReadonlyArray<RouteVariant>;
  /** Optional express mount path (defaults to the router's own paths). */
  mountPath?: string;
  /** Apply the per-route `Cache-Control: no-store` policy. */
  noStore?: boolean;
}

const API: StartupProfile[] = ["api"];
const ALL_PROFILES: StartupProfile[] = ["all"];

/** Ordered route registry — mirrors the historical mount order. */
export const routeRegistry: ReadonlyArray<RouteDefinition> = [
  {
    path: "/metrics",
    router: metricsRoutes,
    requires: ["stellar"],
    profile: ALL_PROFILES,
  },
  {
    path: "/health",
    router: healthRoutes,
    requires: ["stellar"],
    profile: ALL_PROFILES,
  },
  {
    path: "/analytics",
    router: analyticsRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/remediation",
    router: remediationRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/admin",
    router: adminRoutes,
    requires: ["stellar", "scheduler"],
    requiresServices: ["sbt-guard", "job-scheduler"],
    profile: API,
    noStore: true,
  },
  {
    path: "/vote",
    router: votingRoutes,
    requires: ["stellar"],
    requiresServices: ["anti-spam", "circuit-registry"],
    profile: API,
    noStore: true,
  },
  {
    path: "/daos",
    router: daoRoutes,
    requires: ["stellar"],
    requiresServices: ["sync"],
    profile: API,
  },
  {
    path: "/ipfs",
    router: ipfsRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/comments",
    router: commentsRoutes,
    requires: ["stellar"],
    requiresServices: ["anti-spam"],
    profile: API,
  },
  {
    path: "/claim",
    router: claimRoutes,
    requires: ["stellar"],
    requiresServices: ["bridge"],
    profile: API,
  },
  {
    path: "/indexer",
    router: indexerRoutes,
    requires: ["stellar"],
    requiresServices: ["sync"],
    profile: API,
  },
  {
    path: "/bridge",
    router: bridgeRoutes,
    requires: ["stellar"],
    requiresServices: ["bridge"],
    profile: API,
  },
  {
    path: "/circuits",
    router: circuitRoutes,
    requires: ["stellar"],
    requiresServices: ["circuit-registry"],
    profile: API,
  },
  {
    path: "/transactions",
    router: transactionRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/auth",
    router: authRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/quadratic",
    router: quadraticRoutes,
    requires: ["stellar"],
    requiresServices: ["anti-spam"],
    profile: API,
  },
  {
    path: "/api/v1/nova",
    router: novaRoutes,
    requires: ["stellar"],
    profile: API,
    // Unversioned app only: the versioned routers expose their own paths.
    variants: ["unversioned"],
    mountPath: "/api/v1/nova",
  },
  {
    path: "/threshold",
    router: thresholdRoutes,
    requires: ["stellar"],
    profile: API,
    noStore: true,
  },
  {
    path: "/audit",
    router: auditRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/randomness",
    router: randomnessRoutes,
    requires: ["stellar"],
    profile: API,
    noStore: true,
  },
  {
    path: "/pay",
    router: payRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/swap",
    router: swapRoutes,
    requires: ["stellar"],
    profile: API,
  },
  {
    path: "/ramp",
    router: rampRoutes,
    requires: ["stellar"],
    profile: API,
  },
];

/** Thrown when a route's declared prerequisites are not satisfied. */
export class RouteValidationError extends Error {
  constructor(
    readonly route: string,
    readonly missing: readonly string[],
  ) {
    super(
      `Route "${route}" cannot be mounted: missing ${missing.join(", ")}`,
    );
    this.name = "RouteValidationError";
  }
}

/** Resolve a profile value to its role name. */
export function profileName(
  profile: StartupProfile | ResolvedStartupProfile,
): StartupProfile {
  return typeof profile === "string" ? profile : profile.profile;
}

/** Whether a route definition participates in the given profile. */
export function matchesRouteProfile(
  definition: RouteDefinition,
  profile: StartupProfile | ResolvedStartupProfile,
): boolean {
  const active = profileName(profile);
  if (active === "all") return true;
  const allowed = Array.isArray(definition.profile)
    ? definition.profile
    : [definition.profile];
  return allowed.includes("all") || allowed.includes(active);
}

/** Validate a single route definition's prerequisites. */
export function validateRouteRequirements(
  definition: RouteDefinition,
  services: AppServices,
): void {
  const missing: string[] = [];
  for (const key of definition.requires) {
    if (services == null || services[key] == null) {
      missing.push(`AppServices.${key}`);
    }
  }
  for (const name of definition.requiresServices ?? []) {
    if (!services?.initializedServices?.includes(name)) {
      missing.push(`initialized service "${name}"`);
    }
  }
  if (missing.length > 0) throw new RouteValidationError(definition.path, missing);
}

function noStoreMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

export interface MountRoutesOptions {
  /** Which mount variant to populate (default: unversioned). */
  variant?: RouteVariant;
}

/** The subset of Express/Router used for mounting (both satisfy this). */
export interface RouteMountTarget {
  use(...handlers: RequestHandler[]): unknown;
  use(path: string, ...handlers: RequestHandler[]): unknown;
}

/**
 * Validate every selected route first (all-or-nothing), then mount them in
 * registry order. `target` may be the main Express app or a versioned Router.
 *
 * @returns The definitions that were mounted.
 */
export function mountRoutes(
  target: RouteMountTarget,
  services: AppServices,
  profile: StartupProfile | ResolvedStartupProfile,
  options: MountRoutesOptions = {},
): ReadonlyArray<RouteDefinition> {
  const variant = options.variant ?? "unversioned";
  const selected = routeRegistry.filter(
    (definition) =>
      matchesRouteProfile(definition, profile) &&
      (definition.variants === undefined ||
        definition.variants.includes(variant)),
  );

  for (const definition of selected) {
    validateRouteRequirements(definition, services);
  }

  for (const definition of selected) {
    const router = definition.router as RequestHandler;
    if (definition.mountPath) {
      if (definition.noStore) {
        target.use(definition.mountPath, noStoreMiddleware, router);
      } else {
        target.use(definition.mountPath, router);
      }
    } else if (definition.noStore) {
      target.use(noStoreMiddleware, router);
    } else {
      target.use(router);
    }
  }

  return selected;
}
