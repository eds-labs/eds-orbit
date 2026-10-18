import type { FastifyInstance } from "fastify";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { AttentionContributionError, projectAttention } from "./attention.ts";

// What needs the member's attention in the project (UI restructure §4.1).
// Any project member may read it; every module adds only what the member's
// role in it may see. Read-only: no audit row.

export function registerAttentionRoutes(app: FastifyInstance, auth: Auth) {
  app.get("/api/projects/:projectId/attention", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    reply.header("Cache-Control", "no-store");
    try {
      return await projectAttention(scope);
    } catch (error) {
      // A throwing contribution fails the whole read (500) instead of being
      // left out: hidden items would look like nothing is due. The module id
      // is logged, never the error's message (it may carry user data).
      if (error instanceof AttentionContributionError)
        req.log.error(
          {
            moduleId: error.moduleId,
            errorName: (error.cause as Error | undefined)?.name,
          },
          "attention contribution failed",
        );
      throw error;
    }
  });
}
