/**
 * HTTP routes of the personal assistant (ADR 0022, plan WP3.4 and WP3.7).
 * All answer 404 NOT_FOUND while ORBIT_PERSONAL_ASSISTANT is off. Every
 * route acts on the signed-in user's own personal space in one organization
 * (`workspaceId` in the query, or the user's first organization); there is
 * no route that names someone else's space. Conversations run on the
 * existing project chat routes with the personal space as the project.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { RoutesContribution } from "../http/routes.ts";
import { registeredRegistry } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { userFor, type Auth } from "../tenancy/auth.ts";
import {
  addContext,
  deleteContext,
  exportContext,
  listContext,
  patchContext,
  readAssistantSettings,
  saveAssistantSettings,
} from "./personal-context.ts";
import {
  ensurePersonalSpace,
  personalAssistantEnabled,
  personalAssistantRefusal,
} from "./personal-space.ts";
import { personalSpendRecord } from "../ai/spend-mandate.ts";

const uuid = z.uuid();
const query = z.object({ workspaceId: uuid.optional() }).passthrough();

/** The organization a request means: the given one, or the user's first. */
async function workspaceFor(userId: string, req: FastifyRequest) {
  const { workspaceId } = query.parse(req.query ?? {});
  const member = await authDb.workspaceMember.findFirst({
    where: { userId, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { workspace: { createdAt: "asc" } },
    select: { workspaceId: true },
  });
  if (!member) throw new DomainError("NOT_FOUND", 404);
  return member.workspaceId;
}

/** Runs `work` in the user's own personal space, created on first use. */
async function inPersonalSpace<T>(
  auth: Auth,
  req: FastifyRequest,
  work: (tx: DbTx, scope: Scope) => Promise<T>,
) {
  if (!personalAssistantEnabled()) throw new DomainError("NOT_FOUND", 404);
  const user = await userFor(auth, req);
  const workspaceId = await workspaceFor(user.id, req);
  const space = await ensurePersonalSpace(workspaceId, user.id, registeredRegistry());
  const scope: Scope = {
    workspaceId,
    projectId: space.projectId,
    userId: user.id,
    role: "owner",
  };
  return scoped(workspaceId, space.projectId, (tx) => work(tx, scope));
}

export const assistantRoutes: RoutesContribution = ({ app, auth }) => {
  app.get("/api/assistant", async (req) => {
    if (!personalAssistantEnabled()) throw new DomainError("NOT_FOUND", 404);
    const user = await userFor(auth, req);
    const workspaceId = await workspaceFor(user.id, req);
    const refusal = await personalAssistantRefusal(workspaceId, user.id);
    if (refusal === "WORKSPACE_FORBIDDEN" || refusal === "ASSISTANT_DISABLED")
      throw new DomainError("NOT_FOUND", 404);
    if (refusal) return { enabled: false, workspaceId, reason: refusal };
    return inPersonalSpace(auth, req, async (tx, scope) => {
      const spend = await personalSpendRecord(tx, scope);
      const cap = spend ? (spend.data as { monthlyBudgetMicros: number }).monthlyBudgetMicros : null;
      return {
        enabled: true,
        workspaceId,
        personalSpaceId: scope.projectId,
        capMicros: cap,
        autoMemory: (await readAssistantSettings(tx, scope)).autoMemory,
      };
    });
  });

  app.get("/api/assistant/context", (req) =>
    inPersonalSpace(auth, req, async (tx, scope) => ({
      items: await listContext(tx, scope),
      autoMemory: (await readAssistantSettings(tx, scope)).autoMemory,
    })),
  );
  app.post("/api/assistant/context", async (req, reply) => {
    const entry = await inPersonalSpace(auth, req, (tx, scope) =>
      addContext(tx, scope, req.body, "user"),
    );
    return reply.code(201).send(entry);
  });
  // Static paths before the :id routes.
  app.get("/api/assistant/context/export", async (req, reply) => {
    const body = await inPersonalSpace(auth, req, (tx, scope) => exportContext(tx, scope));
    return reply
      .header("content-disposition", 'attachment; filename="orbit-personal-context.json"')
      .header("cache-control", "no-store")
      .send(body);
  });
  app.put("/api/assistant/context/settings", (req) =>
    inPersonalSpace(auth, req, (tx, scope) => saveAssistantSettings(tx, scope, req.body)),
  );
  app.patch("/api/assistant/context/:id", (req) =>
    inPersonalSpace(auth, req, (tx, scope) =>
      patchContext(tx, scope, uuid.parse((req.params as { id: string }).id), req.body),
    ),
  );
  app.delete("/api/assistant/context/:id", async (req, reply) => {
    await inPersonalSpace(auth, req, (tx, scope) =>
      deleteContext(tx, scope, uuid.parse((req.params as { id: string }).id)),
    );
    return reply.code(204).send();
  });
};
