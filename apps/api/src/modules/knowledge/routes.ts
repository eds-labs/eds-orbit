import { scoped } from "../../../../../packages/db/src/index.ts";
import { listIndexGenerations } from "../../../../../packages/knowledge/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { PROJECT_OWN } from "../../platform/tenancy/permissions.ts";
import { data, list } from "../../shared.ts";

/**
 * The knowledge module's read routes (WP3.3), moved unchanged from
 * server.ts at their existing paths. While the module is off they answer
 * 404 MODULE_DISABLED through the platform's route guard (WP2.4).
 */
export const knowledgeRoutes: RoutesContribution = ({ app, auth }) => {
  app.get("/api/projects/:projectId/knowledge-health", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const facts = await list(tx, scope, "facts"),
        sources = await list(tx, scope, "sources"),
        contents = await list(tx, scope, "content");
      return {
        conflicts: facts.filter((x) => data(x).status === "conflicting"),
        expiredFacts: facts.filter(
          (x) =>
            data(x).validUntil && new Date(data(x).validUntil) <= new Date(),
        ),
        failedImports: (await list(tx, scope, "jobs")).filter(
          (x) => data(x).topic === "ingestion" && data(x).status === "failed",
        ),
        staleSources: sources.filter(
          (x) =>
            !data(x).lastSuccessfulSyncAt ||
            Date.now() - new Date(data(x).lastSuccessfulSyncAt).valueOf() >
              data(x).maxAgeHours * 3600000,
        ),
        missingEvidence: contents.filter(
          (x) => data(x).status === "needs_review",
        ),
        impacts: contents.filter((x) => data(x).status === "needs_review"),
      };
    });
  });
  app.get("/api/projects/:projectId/documents", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      items: await tx.knowledgeDocument.findMany({
        where: { projectId },
        include: {
          versions: { include: { chunks: true }, orderBy: { version: "desc" } },
        },
        take: 200,
      }),
    }));
  });
  app.get("/api/projects/:projectId/indexes", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      items: await listIndexGenerations(tx, scope),
    }));
  });
};
