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
  type ConnectionActor,
} from "./connections.ts";
import { aiProfile, saveAiProfile } from "./ai-profiles.ts";

// Central connections (ADR 0013): system connections for administrators,
// organization connections for that organization's owners, and the list a
// project may choose from. 404 while ORBIT_CONNECTIONS is off.

export function isConnectionRoute(url: string) {
  return (
    url.startsWith("/api/admin/connection") ||
    url.startsWith("/api/admin/ai/") ||
    url.startsWith("/api/organizations/:workspaceId/ai/") ||
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
  // What the project may choose from; any member may see the names.
  app.get("/api/projects/:projectId/connections", async (req) => {
    enabled();
    const scope = await scopeFor(auth, req, id(req, "projectId"));
    return projectConnections(scope.workspaceId, scope.projectId);
  });
}
