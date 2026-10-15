import type { FastifyInstance } from "fastify";
import type { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";

/** What a module's routes receive when the API registers them (WP2.1f). */
export type RouteContext = {
  app: FastifyInstance;
  auth: Auth;
  /** The API's configuration, read once at start. */
  config: ReturnType<typeof loadConfig>;
};

/**
 * Registers a module's HTTP routes at their existing absolute paths. The
 * platform's hooks (origin check, rate limits, error mapping, the Orbit
 * Agents gate) apply to them like to every route; each handler checks its
 * permission through `scopeFor`, as before.
 */
export type RoutesContribution = (ctx: RouteContext) => void;
