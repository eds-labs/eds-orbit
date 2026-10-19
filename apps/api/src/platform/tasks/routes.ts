import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeFor, type Auth } from "../tenancy/auth.ts";
import { readTask, listTasks, cancelTask } from "./tasks.ts";
import { PROJECT_WRITE } from "../tenancy/permissions.ts";
import { mcp2Enabled } from "./operation-tools.ts";
import { DomainError } from "../shared.ts";

/** Work orders in the existing native assistant; never a project-management module. */
export function registerTaskRoutes(app: FastifyInstance, auth: Auth) {
  const base = "/api/projects/:projectId/assistant-tasks";
  app.get(base, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    if (!mcp2Enabled())
      return { schemaVersion: 1, items: [], nextCursor: null };
    const query = z
      .object({
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(25).optional(),
      })
      .strict()
      .parse(req.query ?? {});
    return listTasks(scope, query);
  });
  app.get(`${base}/:taskId`, async (req) => {
    const { projectId, taskId } = req.params as {
      projectId: string;
      taskId: string;
    };
    const scope = await scopeFor(auth, req, projectId);
    return readTask(scope, z.uuid().parse(taskId));
  });
  app.post(`${base}/:taskId/cancel`, async (req) => {
    const { projectId, taskId } = req.params as {
      projectId: string;
      taskId: string;
    };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    return cancelTask(scope, z.uuid().parse(taskId));
  });
}
