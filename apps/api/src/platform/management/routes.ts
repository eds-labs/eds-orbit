import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopedRead } from "../../../../../packages/db/src/index.ts";
import { scopeFor, sessionFor, type Auth } from "../tenancy/auth.ts";
import { managementCapabilities } from "./capabilities.ts";
import { integrationCatalog } from "./integration-catalog.ts";
import { projectIntegrationRecords, publicIntegration } from "./project-integrations.ts";

// Settings center (ADR 0027). 404 while ORBIT_SETTINGS_CENTER is off
// (server onRequest hook, before authentication).

export function registerManagementRoutes(app: FastifyInstance, auth: Auth) {
  app.get("/api/management/capabilities", async (req) =>
    managementCapabilities((await sessionFor(auth, req)).user.id),
  );
  // Static facts, the same for every signed-in member: no secrets, no state.
  app.get("/api/management/integrations/catalog", async (req) => {
    await sessionFor(auth, req);
    return { items: integrationCatalog() };
  });
  // Any member (PROJECT_READ); 404 without membership, also for a system
  // administrator. Each item shows only what the member's existing reads show.
  app.get("/api/management/projects/:projectId/integrations", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, z.uuid().parse(projectId));
    const records = await scopedRead(scope.workspaceId, scope.projectId, (tx) =>
      projectIntegrationRecords(tx, scope, (moduleId, error) =>
        // The module id and error name only: a message may carry user data.
        req.log.error(
          { moduleId, errorName: (error as Error | undefined)?.name },
          "project integrations contribution failed",
        ),
      ),
    );
    reply.header("Cache-Control", "no-store");
    return { items: records.map(publicIntegration) };
  });
}
