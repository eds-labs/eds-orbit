import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { DomainError } from "../shared.ts";
import { connectionsEnabled } from "../connections/central.ts";
import { systemAdminFor, workspaceOwnerFor } from "./authz.ts";
import {
  checkConnection,
  connectionUsage,
  createConnection,
  grantConnection,
  listConnections,
  projectConnections,
  removeConnection,
  revokeConnectionGrant,
  rotateSecret,
  setConnectionDisabled,
  updateConnection,
  bindWorkflow,
  listWorkflows,
  unbindWorkflow,
  type ConnectionActor,
} from "./connections.ts";
import {
  executionStatus,
  listRuns,
  projectBindings,
  receiveCallback,
  triggerWorkflow,
} from "../automation/workflows.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import {
  assignChannels,
  channelAssignments,
} from "../connections/channel-assignment.ts";
import { aiProfile, saveAiProfile } from "./ai-profiles.ts";
import { aiDefaults, clearAiDefaults, saveAiDefaults } from "./ai-defaults.ts";
import {
  listModelPrices,
  resetModelPrice,
  setModelPrice,
} from "./ai-catalog.ts";

// Central connections (ADR 0014): system connections for administrators,
// organization connections for that organization's owners, and the list a
// project may choose from. 404 while ORBIT_CONNECTIONS is off.

export function isConnectionRoute(url: string) {
  return (
    url.startsWith("/api/admin/connection") ||
    url.startsWith("/api/admin/ai/") ||
    url.startsWith("/api/organizations/:workspaceId/ai/") ||
    url.startsWith("/api/projects/:projectId/workflow-") ||
    url.startsWith("/api/automation/") ||
    url.startsWith("/api/organizations/:workspaceId/connection") ||
    url === "/api/projects/:projectId/connections"
  );
}

const id = (req: FastifyRequest, name: string) =>
  z.uuid().parse((req.params as Record<string, string>)[name]);

export function registerConnectionRoutes(app: FastifyInstance, auth: Auth) {
  const enabled = () => {
    if (!connectionsEnabled()) throw new DomainError("NOT_FOUND", 404);
  };
  const admin = async (req: FastifyRequest): Promise<ConnectionActor> => {
    enabled();
    return { userId: (await systemAdminFor(auth, req)).userId, role: "admin" };
  };
  const owner = async (req: FastifyRequest): Promise<ConnectionActor> => {
    enabled();
    const o = await workspaceOwnerFor(auth, req, id(req, "workspaceId"));
    return { ...o, role: "owner" };
  };

  for (const [base, actor] of [
    ["/api/admin/connections", admin],
    ["/api/organizations/:workspaceId/connections", owner],
  ] as const) {
    app.get(base, async (req) => {
      const a = await actor(req);
      const q = z
        .object({
          scope: z.enum(["system", "workspace"]).optional(),
          workspaceId: z.uuid().optional(),
        })
        .strict()
        .parse(a.role === "admin" ? req.query : {});
      return listConnections(a, q);
    });
    app.post(base, async (req, reply) =>
      reply.code(201).send(await createConnection(await actor(req), req.body)),
    );
    app.patch(`${base}/:connectionId`, async (req) =>
      updateConnection(await actor(req), id(req, "connectionId"), req.body),
    );
    app.delete(`${base}/:connectionId`, async (req, reply) => {
      await removeConnection(await actor(req), id(req, "connectionId"));
      return reply.code(204).send();
    });
    app.post(`${base}/:connectionId/secret`, async (req) =>
      rotateSecret(await actor(req), id(req, "connectionId"), req.body),
    );
    app.post(`${base}/:connectionId/check`, async (req) =>
      checkConnection(await actor(req), id(req, "connectionId")),
    );
    app.post(`${base}/:connectionId/disable`, async (req) =>
      setConnectionDisabled(await actor(req), id(req, "connectionId"), true),
    );
    app.post(`${base}/:connectionId/enable`, async (req) =>
      setConnectionDisabled(await actor(req), id(req, "connectionId"), false),
    );
    app.get(`${base}/:connectionId/usage`, async (req) =>
      connectionUsage(await actor(req), id(req, "connectionId")),
    );
    app.get(`${base}/:connectionId/workflows`, async (req) =>
      listWorkflows(await actor(req), id(req, "connectionId")),
    );
    app.post(`${base}/:connectionId/workflows`, async (req, reply) =>
      reply
        .code(201)
        .send(await bindWorkflow(await actor(req), id(req, "connectionId"), req.body)),
    );
    // Channels of a connection, one project each (Postiz accounts).
    app.get(`${base}/:connectionId/channels`, async (req) => {
      const a = await actor(req);
      const q = z
        .object({ workspaceId: z.uuid().optional() })
        .strict()
        .parse(a.role === "admin" ? req.query : {});
      return channelAssignments(a, id(req, "connectionId"), q.workspaceId);
    });
    app.put(`${base}/:connectionId/channels`, async (req) =>
      assignChannels(await actor(req), id(req, "connectionId"), req.body),
    );
    app.post(`${base}/:connectionId/grants`, async (req, reply) =>
      reply
        .code(201)
        .send(
          await grantConnection(
            await actor(req),
            id(req, "connectionId"),
            req.body,
          ),
        ),
    );
  }
  app.delete("/api/admin/connection-grants/:grantId", async (req, reply) => {
    await revokeConnectionGrant(await admin(req), id(req, "grantId"));
    return reply.code(204).send();
  });
  app.delete(
    "/api/organizations/:workspaceId/connection-grants/:grantId",
    async (req, reply) => {
      await revokeConnectionGrant(await owner(req), id(req, "grantId"));
      return reply.code(204).send();
    },
  );
  app.delete("/api/admin/connection-workflows/:bindingId", async (req, reply) => {
    await unbindWorkflow(await admin(req), id(req, "bindingId"));
    return reply.code(204).send();
  });
  app.delete(
    "/api/organizations/:workspaceId/connection-workflows/:bindingId",
    async (req, reply) => {
      await unbindWorkflow(await owner(req), id(req, "bindingId"));
      return reply.code(204).send();
    },
  );
  // Automation workflows of a project (WP3.7): members see bindings and
  // runs; owners trigger and read an execution's state.
  const member = async (req: FastifyRequest, required?: typeof PROJECT_OWN) => {
    enabled();
    return scopeFor(auth, req, id(req, "projectId"), required);
  };
  app.get("/api/projects/:projectId/workflow-bindings", async (req) =>
    projectBindings(await member(req)),
  );
  app.get("/api/projects/:projectId/workflow-runs", async (req) =>
    listRuns(await member(req)),
  );
  app.post("/api/projects/:projectId/workflow-runs", async (req, reply) =>
    reply.code(201).send(await triggerWorkflow(await member(req, PROJECT_OWN), req.body)),
  );
  app.get("/api/projects/:projectId/workflow-runs/:runId/execution", async (req) =>
    executionStatus(await member(req, PROJECT_OWN), id(req, "runId")),
  );
  // Signed workflow outcomes; the raw body is what the signature covers.
  void app.register(async (child) => {
    child.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, done) => done(null, body),
    );
    child.post(
      "/api/automation/callbacks/:projectId/:runId",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req) => {
        enabled();
        return receiveCallback(
          id(req, "projectId"),
          id(req, "runId"),
          req.headers as Record<string, unknown>,
          typeof req.body === "string" ? req.body : "",
        );
      },
    );
  });
  // AI profiles: the system's (administrators) and an organization's (owners).
  app.get("/api/admin/ai/profile", async (req) => {
    await admin(req);
    return aiProfile({ scope: "system" });
  });
  app.put("/api/admin/ai/profile", async (req) =>
    saveAiProfile((await admin(req)).userId, { scope: "system" }, req.body),
  );
  app.get("/api/organizations/:workspaceId/ai/profile", async (req) => {
    await owner(req);
    return aiProfile({ scope: "workspace", workspaceId: id(req, "workspaceId") });
  });
  app.put("/api/organizations/:workspaceId/ai/profile", async (req) =>
    saveAiProfile(
      (await owner(req)).userId,
      { scope: "workspace", workspaceId: id(req, "workspaceId") },
      req.body,
    ),
  );
  // "Modelle & Preise" (plans/ai-central-management.md, phase A): the
  // system's catalog overrides (administrators) and an organization's (owners).
  const modelId = (req: FastifyRequest) =>
    z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,120}$/)
      .parse((req.params as Record<string, string>).modelId);
  app.get("/api/admin/ai/models", async (req) => {
    await admin(req);
    return listModelPrices({ scope: "system" });
  });
  app.put("/api/admin/ai/models/:modelId", async (req) =>
    setModelPrice((await admin(req)).userId, { scope: "system" }, modelId(req), req.body),
  );
  app.delete("/api/admin/ai/models/:modelId", async (req) =>
    resetModelPrice((await admin(req)).userId, { scope: "system" }, modelId(req)),
  );
  app.get("/api/organizations/:workspaceId/ai/models", async (req) => {
    await owner(req);
    return listModelPrices({ scope: "workspace", workspaceId: id(req, "workspaceId") });
  });
  app.put("/api/organizations/:workspaceId/ai/models/:modelId", async (req) =>
    setModelPrice(
      (await owner(req)).userId,
      { scope: "workspace", workspaceId: id(req, "workspaceId") },
      modelId(req),
      req.body,
    ),
  );
  app.delete("/api/organizations/:workspaceId/ai/models/:modelId", async (req) =>
    resetModelPrice(
      (await owner(req)).userId,
      { scope: "workspace", workspaceId: id(req, "workspaceId") },
      modelId(req),
    ),
  );
  // "Standard-Modelle" (phase B): the system's (administrators) and an
  // organization's (owners) provider and level, image model and task routes.
  app.get("/api/admin/ai/defaults", async (req) => {
    await admin(req);
    return aiDefaults({ scope: "system" });
  });
  app.put("/api/admin/ai/defaults", async (req) =>
    saveAiDefaults((await admin(req)).userId, { scope: "system" }, req.body),
  );
  app.delete("/api/admin/ai/defaults", async (req) =>
    clearAiDefaults((await admin(req)).userId, { scope: "system" }),
  );
  app.get("/api/organizations/:workspaceId/ai/defaults", async (req) => {
    await owner(req);
    return aiDefaults({ scope: "workspace", workspaceId: id(req, "workspaceId") });
  });
  app.put("/api/organizations/:workspaceId/ai/defaults", async (req) =>
    saveAiDefaults(
      (await owner(req)).userId,
      { scope: "workspace", workspaceId: id(req, "workspaceId") },
      req.body,
    ),
  );
  app.delete("/api/organizations/:workspaceId/ai/defaults", async (req) =>
    clearAiDefaults(
      (await owner(req)).userId,
      { scope: "workspace", workspaceId: id(req, "workspaceId") },
    ),
  );
  // What the project may choose from; any member may see the names.
  app.get("/api/projects/:projectId/connections", async (req) => {
    enabled();
    const scope = await scopeFor(auth, req, id(req, "projectId"));
    return projectConnections(scope.workspaceId, scope.projectId);
  });
}
