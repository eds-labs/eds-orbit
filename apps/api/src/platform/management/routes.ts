import type { FastifyInstance } from "fastify";
import { sessionFor, type Auth } from "../tenancy/auth.ts";
import { managementCapabilities } from "./capabilities.ts";

// Settings center (ADR 0027). 404 while ORBIT_SETTINGS_CENTER is off
// (server onRequest hook, before authentication).

export function registerManagementRoutes(app: FastifyInstance, auth: Auth) {
  app.get("/api/management/capabilities", async (req) =>
    managementCapabilities((await sessionFor(auth, req)).user.id),
  );
}
