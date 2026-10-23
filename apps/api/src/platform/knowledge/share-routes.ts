import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { DomainError } from "../shared.ts";
import { workspaceOwnerFor } from "../administration/authz.ts";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import {
  createLibrary,
  createShare,
  listShares,
  revokeShare,
  sharesEnabled,
  updateShare,
} from "./shares.ts";

// Organization knowledge libraries and their shares (ADR 0014, E1):
// managed by the organization's owners; a project sees which libraries it
// may search. 404 while ORBIT_KNOWLEDGE_SHARES is off.

export function isShareRoute(url: string) {
  return (
    url.startsWith("/api/organizations/:workspaceId/knowledge-") ||
    url === "/api/projects/:projectId/knowledge-shares"
  );
}

const id = (req: FastifyRequest, name: string) =>
  z.uuid().parse((req.params as Record<string, string>)[name]);

export function registerShareRoutes(app: FastifyInstance, auth: Auth) {
  const owner = async (req: FastifyRequest) => {
    if (!sharesEnabled()) throw new DomainError("NOT_FOUND", 404);
    return workspaceOwnerFor(auth, req, id(req, "workspaceId"));
  };
  const base = "/api/organizations/:workspaceId";
  app.post(`${base}/knowledge-libraries`, async (req, reply) =>
    reply.code(201).send(await createLibrary(await owner(req), req.body)),
  );
  app.get(`${base}/knowledge-shares`, async (req) =>
    listShares((await owner(req)).workspaceId),
  );
  app.post(`${base}/knowledge-shares`, async (req, reply) =>
    reply.code(201).send(await createShare(await owner(req), req.body)),
  );
  app.patch(`${base}/knowledge-shares/:shareId`, async (req) =>
    updateShare(await owner(req), id(req, "shareId"), req.body),
  );
  app.delete(`${base}/knowledge-shares/:shareId`, async (req, reply) => {
    await revokeShare(await owner(req), id(req, "shareId"));
    return reply.code(204).send();
  });
  // The libraries this project may search (names and modules only).
  app.get("/api/projects/:projectId/knowledge-shares", async (req) => {
    if (!sharesEnabled()) throw new DomainError("NOT_FOUND", 404);
    const scope = await scopeFor(auth, req, id(req, "projectId"));
    const shares = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.knowledgeShare.findMany({
        where: { consumerProjectId: scope.projectId, revokedAt: null },
      }),
    );
    // Library names from the control plane: the consumer cannot read them.
    const names = new Map(
      (
        await authDb.project.findMany({
          where: { id: { in: shares.map((s) => s.libraryProjectId) } },
          select: { id: true, name: true },
        })
      ).map((p) => [p.id, p.name]),
    );
    return {
      items: shares.map((s) => ({
        id: s.id,
        libraryName: names.get(s.libraryProjectId) ?? null,
        modules: s.modules,
        sources: s.sourceIds.length || null,
      })),
    };
  });
}
