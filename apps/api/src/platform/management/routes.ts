import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scoped, scopedRead } from "../../../../../packages/db/src/index.ts";
import { scopeFor, sessionFor, type Auth } from "../tenancy/auth.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import { administrationEnabled, workspaceOwnerFor } from "../administration/authz.ts";
import { DomainError } from "../shared.ts";
import { projectAiEffective } from "./ai-effective.ts";
import { managementCapabilities } from "./capabilities.ts";
import { integrationCatalog } from "./integration-catalog.ts";
import { organizationIntegrations } from "./organization-integrations.ts";
import {
  projectIntegrationRecords,
  publicIntegration,
  unavailableIntegrations,
} from "./project-integrations.ts";

// Settings center (ADR 0027). 404 while ORBIT_SETTINGS_CENTER is off
// (server onRequest hook, before authentication).

export function registerManagementRoutes(app: FastifyInstance, auth: Auth) {
  app.get("/api/management/capabilities", async (req) =>
    managementCapabilities((await sessionFor(auth, req)).user.id),
  );
  // Facts about the code and this installation's switches, the same for every
  // signed-in member: no secrets, no state.
  app.get("/api/management/integrations/catalog", async (req) => {
    await sessionFor(auth, req);
    return { items: integrationCatalog() };
  });
  // Any member (PROJECT_READ); 404 without membership, also for a system
  // administrator. Each item shows only what the member's existing reads show;
  // `unavailable` names the catalog entries this member cannot use here.
  app.get("/api/management/projects/:projectId/integrations", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, z.uuid().parse(projectId));
    const { records, unavailable } = await scopedRead(scope.workspaceId, scope.projectId, async (tx) => ({
      records: await projectIntegrationRecords(tx, scope, (moduleId, error) =>
        // The module id and error name only: a message may carry user data.
        req.log.error(
          { moduleId, errorName: (error as Error | undefined)?.name },
          "project integrations contribution failed",
        ),
      ),
      unavailable: await unavailableIntegrations(tx, scope),
    }));
    reply.header("Cache-Control", "no-store");
    return { items: records.map(publicIntegration), unavailable };
  });
  // Project owners only (PROJECT_OWN, the guard of GET
  // /api/projects/:projectId/openai-configuration): 403 for other members,
  // 404 without membership. The effective AI values with their origins and a
  // readiness per provider, built field by field: never a key or a profile.
  app.get("/api/management/projects/:projectId/ai/effective", async (req, reply) => {
    const { projectId } = z.object({ projectId: z.uuid() }).strict().parse(req.params);
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    const view = await scoped(scope.workspaceId, projectId, (tx) => projectAiEffective(tx, scope));
    reply.header("Cache-Control", "no-store");
    return view;
  });
  // Organization owners only (D-4): 404 for everyone else, system
  // administrators included, and for everyone while administration is off.
  app.get("/api/management/organizations/:workspaceId/integrations", async (req, reply) => {
    if (!administrationEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { workspaceId } = req.params as { workspaceId: string };
    const owner = await workspaceOwnerFor(auth, req, z.uuid().parse(workspaceId));
    const usage = await organizationIntegrations(owner.userId, owner.workspaceId, (projectId, moduleId, error) =>
      // Ids and the error name only: a message may carry user data.
      req.log.error(
        { projectId, moduleId, errorName: (error as Error | undefined)?.name },
        "organization integrations contribution failed",
      ),
    );
    reply.header("Cache-Control", "no-store");
    return usage;
  });
}
