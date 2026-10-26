import { z } from "zod";
import { workspaceSummary, owner, getKnowledgePreview } from "./workspace.ts";
import { githubStatus, githubRepositories, finishGithub } from "./github.ts";
import { scoped } from "../../../../../packages/db/src/index.ts";
import {
  sourceExpiry,
  tracksFreshness,
} from "../../../../../packages/knowledge/src/freshness.ts";
import { describeIndexGenerations } from "../../../../../packages/knowledge/src/index.ts";
import { knowledgeIndexStatus } from "../../platform/knowledge/index-status.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { PROJECT_OWN } from "../../platform/tenancy/permissions.ts";
import { data, list, entity } from "../../shared.ts";

/**
 * The knowledge module's read routes (WP3.3), moved unchanged from
 * server.ts at their existing paths. While the module is off they answer
 * 404 MODULE_DISABLED through the platform's route guard (WP2.4).
 */
export const knowledgeRoutes: RoutesContribution = ({ app, auth }) => {
  app.get("/api/projects/:projectId/knowledge-workspace", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return workspaceSummary(await scopeFor(auth, req, projectId));
  });
  app.get("/api/projects/:projectId/knowledge/github", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    await owner(scope);
    return githubStatus(scope);
  });
  app.get(
    "/api/projects/:projectId/knowledge/github/repositories",
    async (req) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      await owner(scope);
      return githubRepositories(
        scope,
        z.object({ connectionId: z.uuid() }).parse(req.query).connectionId,
      );
    },
  );
  app.get(
    "/api/projects/:projectId/knowledge/github/callback",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      await owner(scope);
      const query = z
        .object({
          code: z.string().min(1).max(500),
          state: z.string().min(20).max(200),
        })
        .parse(req.query);
      const draftId = await finishGithub(scope, query.state, query.code);
      return reply.redirect(
        `/p/${projectId}/knowledge/import?github=connected${draftId ? `&draft=${draftId}` : ""}`,
      );
    },
  );
  app.get(
    "/api/projects/:projectId/knowledge/proposals/:id/history",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId);
      return scoped(scope.workspaceId, projectId, async (tx) => {
        await entity(tx, scope, "knowledge_proposals", z.uuid().parse(id));
        return {
          items: await tx.entityVersion.findMany({
            where: { entityId: id, projectId, workspaceId: scope.workspaceId },
            orderBy: { version: "desc" },
            take: 100,
          }),
        };
      });
    },
  );
  app.get("/api/projects/:projectId/knowledge/previews/:id", async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    return getKnowledgePreview(
      await scopeFor(auth, req, projectId, PROJECT_OWN),
      z.uuid().parse(id),
    );
  });
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
            tracksFreshness(data(x)) &&
            sourceExpiry(data(x), Date.now()).state === "stale",
        ),
        missingEvidence: contents.filter(
          (x) => data(x).status === "needs_review",
        ),
        impacts: contents.filter((x) => data(x).status === "needs_review"),
        // Per source: can its documents be found now, and why not
        // (plans/knowledge-indexing-repair.md).
        indexStatus: await knowledgeIndexStatus(tx, scope),
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
      items: await describeIndexGenerations(tx, scope),
    }));
  });
};
