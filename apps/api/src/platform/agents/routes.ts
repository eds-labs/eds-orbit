/**
 * HTTP routes of the agent platform (ADR 0021, plan WP1.5). All answer 404
 * NOT_FOUND while ORBIT_AGENT_PLATFORM is off. Writes to definitions are
 * for owners through the web session; runs and cancels for owners and
 * editors; every read also needs read access to the agent's modules.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { RoutesContribution } from "../http/routes.ts";
import { DomainError } from "../shared.ts";
import { scopeFor, userFor, type Auth } from "../tenancy/auth.ts";
import { highestRole } from "../tenancy/module-roles.ts";
import {
  AGENTS_MANAGE,
  AGENTS_READ,
  AGENTS_RUN,
  can,
} from "../tenancy/permissions.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import { registeredAgentTemplates } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { agentModuleCatalog, agentToolCatalog } from "./definitions/catalog.ts";
import { AgentDefinition } from "./definitions/schema.ts";
import {
  activateAgent,
  agentVersion,
  agentVersions,
  agentView,
  createAgent,
  duplicateAgent,
  listAgents,
  readVisibleAgent,
  setAgentStatus,
  updateAgentDraft,
} from "./definitions/service.ts";
import { managedAgentGroups } from "./managed.ts";
import { triggerableEvents } from "./triggers/declarations.ts";
import {
  agentPlatformEnabled,
  cancelWorkOrder,
  listWorkOrders,
  readWorkOrder,
  retryWorkOrder,
  startManualWorkOrder,
  workOrderView,
} from "./work-orders/service.ts";

const BASE = "/api/projects/:projectId";
const uuid = z.uuid();

/** Runs `work` for the member in the project's transaction with the permission checked. */
async function inProject<T>(
  auth: Auth,
  req: FastifyRequest,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Record<string, string>) => Promise<T>,
) {
  if (!agentPlatformEnabled()) throw new DomainError("NOT_FOUND", 404);
  const params = req.params as Record<string, string>;
  const scope = await scopeFor(auth, req, uuid.parse(params.projectId), required);
  return scoped(scope.workspaceId, scope.projectId, (tx) => work(tx, scope, params));
}

const id = (params: Record<string, string>, key = "id") => uuid.parse(params[key]);

export const agentRoutes: RoutesContribution = ({ app, auth }) => {
  app.get(`${BASE}/agents`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope) => ({ items: await listAgents(tx, scope) })),
  );
  app.post(`${BASE}/agents`, (req) =>
    inProject(auth, req, AGENTS_MANAGE, async (tx, scope) => agentView(await createAgent(tx, scope, req.body))),
  );
  // Static paths before the :id routes.
  app.get(`${BASE}/agents/catalog`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope) => ({
      tools: await agentToolCatalog(tx, scope),
      modules: await agentModuleCatalog(tx, scope),
      events: triggerableEvents(),
    })),
  );
  app.get(`${BASE}/agents/templates`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope) => {
      const enabled = await enabledModules(tx, scope);
      return {
        items: registeredAgentTemplates(enabled).map((t) => ({
          key: t.key,
          module: t.module,
          title: t.title,
          summary: t.summary,
          defaults: t.defaults,
          guard: t.guard,
        })),
      };
    }),
  );
  // Agents the enabled modules manage themselves (Marketing's assignments), read only (WP1.9).
  app.get(`${BASE}/agents/managed`, (req) =>
    inProject(auth, req, AGENTS_READ, (tx, scope) => managedAgentGroups(tx, scope)),
  );
  app.get(`${BASE}/agents/:id`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope, p) => agentView(await readVisibleAgent(tx, scope, id(p)))),
  );
  app.patch(`${BASE}/agents/:id`, (req) =>
    inProject(auth, req, AGENTS_MANAGE, async (tx, scope, p) => agentView(await updateAgentDraft(tx, scope, id(p), req.body))),
  );
  app.post(`${BASE}/agents/:id/duplicate`, (req) =>
    inProject(auth, req, AGENTS_MANAGE, async (tx, scope, p) => agentView(await duplicateAgent(tx, scope, id(p)))),
  );
  app.post(`${BASE}/agents/:id/activate`, (req) =>
    inProject(auth, req, AGENTS_MANAGE, async (tx, scope, p) => agentView(await activateAgent(tx, scope, id(p), req.body))),
  );
  for (const action of ["pause", "resume", "disable"] as const)
    app.post(`${BASE}/agents/:id/${action}`, (req) =>
      inProject(auth, req, AGENTS_MANAGE, async (tx, scope, p) =>
        agentView(await setAgentStatus(tx, scope, id(p), action, req.body)),
      ),
    );
  app.get(`${BASE}/agents/:id/versions`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope, p) => ({ items: await agentVersions(tx, scope, id(p)) })),
  );
  app.get(`${BASE}/agents/:id/versions/:version`, (req) =>
    inProject(auth, req, AGENTS_READ, (tx, scope, p) =>
      agentVersion(tx, scope, id(p), z.coerce.number().int().positive().parse(p.version)),
    ),
  );
  app.post(`${BASE}/agents/:id/runs`, (req) =>
    inProject(auth, req, AGENTS_RUN, (tx, scope, p) => startManualWorkOrder(tx, scope, id(p), req.body)),
  );
  app.get(`${BASE}/agent-work-orders`, (req) =>
    inProject(auth, req, AGENTS_READ, (tx, scope) => listWorkOrders(tx, scope, req.query ?? {})),
  );
  app.get(`${BASE}/agent-work-orders/:id`, (req) =>
    inProject(auth, req, AGENTS_READ, async (tx, scope, p) => workOrderView(await readWorkOrder(tx, scope, id(p)))),
  );
  app.post(`${BASE}/agent-work-orders/:id/cancel`, (req) =>
    inProject(auth, req, AGENTS_RUN, (tx, scope, p) => cancelWorkOrder(tx, scope, id(p))),
  );
  app.post(`${BASE}/agent-work-orders/:id/retry`, (req) =>
    inProject(auth, req, AGENTS_RUN, (tx, scope, p) => retryWorkOrder(tx, scope, id(p), req.body)),
  );

  /**
   * Per-project counts for the organization overview: one scoped
   * transaction per accessible project, never another project's content.
   */
  app.get("/api/agents/summary", async (req) => {
    if (!agentPlatformEnabled()) throw new DomainError("NOT_FOUND", 404);
    const user = await userFor(auth, req);
    const projects = await authDb.project.findMany({
      where: {
        kind: "project",
        OR: [
          { workspace: { members: { some: { userId: user.id, role: "owner" } } } },
          { members: { some: { userId: user.id } } },
        ],
      },
      select: { id: true, name: true, workspaceId: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const since = new Date(Date.now() - 86_400_000);
    const items = [];
    for (const project of projects) {
      const scope = await scopeFor(auth, req, project.id).catch(() => null);
      if (!scope || !can({ role: highestRole(scope) }, AGENTS_READ)) continue;
      const counts = await scoped(scope.workspaceId, project.id, async (tx) => {
        const rows = await tx.entity.findMany({
          where: { workspaceId: scope.workspaceId, projectId: project.id, kind: "agent_definitions" },
          select: { data: true },
        });
        const statuses = rows
          .map((row) => AgentDefinition.safeParse(row.data))
          .filter((parsed) => parsed.success)
          .map((parsed) => parsed.data!.status);
        const failing = await tx.agentWorkOrder.groupBy({
          by: ["agentId"],
          where: { projectId: project.id, target: "agent", status: { in: ["failed", "blocked", "outcome_unknown"] }, finishedAt: { gte: since } },
        });
        return {
          active: statuses.filter((s) => s === "active").length,
          paused: statuses.filter((s) => s === "paused" || s === "budget_exhausted").length,
          failing24h: failing.length,
        };
      });
      if (!counts.active && !counts.paused && !counts.failing24h) continue;
      items.push({ projectId: project.id, projectName: project.name, workspaceId: project.workspaceId, ...counts });
    }
    return { items };
  });
};
