import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import {
  createLink,
  linksOf,
  linkTargets,
  removeLink,
} from "../../platform/links/links.ts";
import { LINK_RELATIONS, OBJECT_TYPE } from "../../../../../packages/module-contracts/src/index.ts";
import { userActor, uuid, workMembers } from "./common.ts";
import { requireWork } from "./gate.ts";
import {
  createInitiative,
  deleteInitiative,
  initiativeView,
  listInitiatives,
  setInitiativeArchived,
  updateInitiative,
} from "./initiatives.ts";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  milestoneView,
  updateMilestone,
} from "./milestones.ts";
import {
  addAttachment,
  addChecklistItem,
  addComment,
  addDependency,
  commentView,
  deleteComment,
  editComment,
  removeAttachment,
  removeChecklistItem,
  removeDependency,
  setWatching,
  updateChecklistItem,
} from "./parts.ts";
import { WORK_DELETE, WORK_READ, WORK_SETTINGS, WORK_WRITE } from "./permissions.ts";
import {
  initiativeDetail,
  listTasks,
  myTasks,
  overview,
  taskDetail,
} from "./queries.ts";
import { readWorkSettings, saveWorkSettings } from "./settings.ts";
import {
  createTask,
  createTasks,
  deleteTask,
  moveTask,
  setTaskArchived,
  taskView,
  updateTask,
} from "./tasks.ts";

// The project management HTTP API (plan §4.4): a thin layer over the
// services. Every route checks the member's permission in the module, then
// that the module is on in the project (404 WORK_DISABLED), then runs in
// one project transaction. Reads need work.read, changes work.write,
// deletions work.delete and the settings work.settings.

const BASE = "/api/projects/:projectId/work";

type Params = Record<string, string>;
type Req = Parameters<typeof scopeFor>[1];

async function inWork<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireWork(tx, scope);
    return work(tx, scope, params);
  });
}

const id = (p: Params, key = "id") => uuid.parse(p[key]);
const flag = (query: unknown, name: string) =>
  z.object({ [name]: z.enum(["true", "false"]).optional() }).strict().parse(query ?? {})[name] === "true";
const settingsInput = z
  .object({ settings: z.unknown(), version: z.int().min(1) })
  .strict();
const linkInput = z
  .object({
    targetType: z.string().regex(OBJECT_TYPE),
    targetId: uuid,
    relation: z.enum(LINK_RELATIONS),
  })
  .strict();
const targetsQuery = z
  .object({ type: z.string().regex(OBJECT_TYPE), q: z.string().max(200).default("") })
  .strict();
const initiativesQuery = z
  .object({ status: z.string().max(20).optional(), archived: z.enum(["true", "false"]).optional() })
  .strict();
const milestonesQuery = z.object({ initiativeId: uuid.optional() }).strict();

/** Project management routes (plan §4.4). */
export const workRoutes: RoutesContribution = ({ app, auth }) => {
  app.get(`${BASE}/overview`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope) => overview(tx, scope)),
  );
  app.get(`${BASE}/members`, (req) =>
    inWork(auth, req, WORK_READ, async (_tx, scope) => ({ items: await workMembers(scope) })),
  );
  app.get(`${BASE}/settings`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope) => readWorkSettings(tx, scope)),
  );
  app.put(`${BASE}/settings`, (req) =>
    inWork(auth, req, WORK_SETTINGS, async (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      const members = new Set((await workMembers(scope)).map((m) => m.userId));
      return saveWorkSettings(tx, scope, settings, version, members);
    }),
  );

  // Initiatives.
  app.get(`${BASE}/initiatives`, (req) =>
    inWork(auth, req, WORK_READ, async (tx, scope) => {
      const q = initiativesQuery.parse(req.query ?? {});
      return { items: await listInitiatives(tx, scope, { status: q.status, archived: q.archived === "true" }) };
    }),
  );
  app.post(`${BASE}/initiatives`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope) =>
      initiativeView(await createInitiative(tx, scope, req.body, userActor(scope))),
    ),
  );
  app.get(`${BASE}/initiatives/:id`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope, p) => initiativeDetail(tx, scope, id(p))),
  );
  app.patch(`${BASE}/initiatives/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      initiativeView(await updateInitiative(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  for (const [action, archived] of [["archive", true], ["restore", false]] as const)
    app.post(`${BASE}/initiatives/:id/${action}`, (req) =>
      inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
        initiativeView(await setInitiativeArchived(tx, scope, id(p), req.body, archived, userActor(scope))),
      ),
    );
  app.delete(`${BASE}/initiatives/:id`, (req) =>
    inWork(auth, req, WORK_DELETE, async (tx, scope, p) => {
      await deleteInitiative(tx, scope, id(p), flag(req.query, "detachTasks"), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );

  // Milestones.
  app.get(`${BASE}/milestones`, (req) =>
    inWork(auth, req, WORK_READ, async (tx, scope) => ({
      items: await listMilestones(tx, scope, milestonesQuery.parse(req.query ?? {}).initiativeId),
    })),
  );
  app.post(`${BASE}/initiatives/:id/milestones`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      milestoneView(await createMilestone(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  app.patch(`${BASE}/milestones/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      milestoneView(await updateMilestone(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  app.delete(`${BASE}/milestones/:id`, (req) =>
    inWork(auth, req, WORK_DELETE, async (tx, scope, p) => {
      await deleteMilestone(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );

  // Tasks.
  app.get(`${BASE}/tasks`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope) => listTasks(tx, scope, req.query ?? {})),
  );
  app.get(`${BASE}/my`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope) => myTasks(tx, scope)),
  );
  app.post(`${BASE}/tasks`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope) =>
      taskView(await createTask(tx, scope, req.body, userActor(scope))),
    ),
  );
  app.post(`${BASE}/tasks/batch`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope) => {
      const body = z.object({ tasks: z.array(z.unknown()) }).strict().parse(req.body);
      const rows = await createTasks(tx, scope, body.tasks, userActor(scope), "manual");
      return { items: rows.map(taskView) };
    }),
  );
  app.get(`${BASE}/tasks/:id`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope, p) => taskDetail(tx, scope, id(p))),
  );
  app.patch(`${BASE}/tasks/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      taskView(await updateTask(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  app.post(`${BASE}/tasks/:id/move`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      taskView(await moveTask(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  for (const [action, archived] of [["archive", true], ["restore", false]] as const)
    app.post(`${BASE}/tasks/:id/${action}`, (req) =>
      inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
        taskView(await setTaskArchived(tx, scope, id(p), req.body, archived, userActor(scope))),
      ),
    );
  app.delete(`${BASE}/tasks/:id`, (req) =>
    inWork(auth, req, WORK_DELETE, async (tx, scope, p) => {
      await deleteTask(tx, scope, id(p), flag(req.query, "includeSubtasks"), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );

  // Checklist, dependencies, comments, attachments, watching.
  app.post(`${BASE}/tasks/:id/checklist`, (req) =>
    inWork(auth, req, WORK_WRITE, (tx, scope, p) => addChecklistItem(tx, scope, id(p), req.body, userActor(scope))),
  );
  app.patch(`${BASE}/checklist/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, (tx, scope, p) => updateChecklistItem(tx, scope, id(p), req.body, userActor(scope))),
  );
  app.delete(`${BASE}/checklist/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
      await removeChecklistItem(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );
  app.post(`${BASE}/tasks/:id/dependencies`, (req) =>
    inWork(auth, req, WORK_WRITE, (tx, scope, p) => addDependency(tx, scope, id(p), req.body, userActor(scope))),
  );
  app.delete(`${BASE}/dependencies/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
      await removeDependency(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );
  app.post(`${BASE}/tasks/:id/comments`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) =>
      commentView(await addComment(tx, scope, id(p), req.body, userActor(scope))),
    ),
  );
  app.patch(`${BASE}/comments/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => commentView(await editComment(tx, scope, id(p), req.body))),
  );
  app.delete(`${BASE}/comments/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
      await deleteComment(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );
  app.post(`${BASE}/tasks/:id/attachments`, (req) =>
    inWork(auth, req, WORK_WRITE, (tx, scope, p) => addAttachment(tx, scope, id(p), req.body, userActor(scope))),
  );
  app.delete(`${BASE}/attachments/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
      await removeAttachment(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );
  app.post(`${BASE}/tasks/:id/watch`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope, p) => setWatching(tx, scope, id(p), true)),
  );
  app.delete(`${BASE}/tasks/:id/watch`, (req) =>
    inWork(auth, req, WORK_READ, (tx, scope, p) => setWatching(tx, scope, id(p), false)),
  );

  // Links to objects of other modules (ADR 0016).
  for (const kind of ["tasks", "initiatives"] as const) {
    const type = kind === "tasks" ? "work.task" : "work.initiative";
    app.get(`${BASE}/${kind}/:id/links`, (req) =>
      inWork(auth, req, WORK_READ, async (tx, scope, p) => ({
        items: await linksOf(tx, scope, { type, id: id(p) }),
      })),
    );
    app.post(`${BASE}/${kind}/:id/links`, (req) =>
      inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
        const input = linkInput.parse(req.body);
        const row = await createLink(
          tx,
          scope,
          {
            source: { type, id: id(p) },
            target: { type: input.targetType, id: input.targetId },
            relation: input.relation,
          },
          userActor(scope),
        );
        return { id: row.id };
      }),
    );
  }
  app.delete(`${BASE}/links/:id`, (req) =>
    inWork(auth, req, WORK_WRITE, async (tx, scope, p) => {
      await removeLink(tx, scope, id(p), userActor(scope));
      return { id: id(p), deleted: true };
    }),
  );
  app.get(`${BASE}/link-targets`, (req) =>
    inWork(auth, req, WORK_READ, async (tx, scope) => {
      const q = targetsQuery.parse(req.query ?? {});
      return { items: await linkTargets(tx, scope, q.type, q.q) };
    }),
  );
};
