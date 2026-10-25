import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  approvedOperation,
  readOperation,
} from "../../platform/tasks/operation-tools.ts";
import type { RequestedBy } from "../action-requests.ts";
import { WORK_SCOPE } from "../../platform/mcp/scopes.ts";
import { DomainError } from "../../shared.ts";
import { assignableIds, dateInput, type WorkActor } from "./common.ts";
import {
  createInitiative,
  createInitiativeInput,
  INITIATIVE_STATUSES,
  listInitiatives,
} from "./initiatives.ts";
import { createMilestone } from "./milestones.ts";
import { addComment } from "./parts.ts";
import { WORK_READ, WORK_WRITE } from "./permissions.ts";
import { listTasks, myTasks, overview, taskDetail } from "./queries.ts";
import {
  createTaskInput,
  createTasks,
  loadTask,
  PRIORITIES,
  updateTask,
  updateTaskInput,
} from "./tasks.ts";
import { readWorkSettings, STATUS_CATEGORIES, statusOf } from "./settings.ts";

// The module's assistant and MCP tools (plan §6): five reads and four
// proposals. Proposals become exact approval requests an owner or editor
// decides (ADR 0016 D-7); nothing changes before. Every tool needs the
// module enabled, the member's permission and, over MCP, the explicit
// content scope orbit:work.

const shared = {
  module: "work",
  feature: "work" as const,
  mcpScopes: [WORK_SCOPE],
};
const proposal = {
  ...shared,
  deciderRole: "editor" as const,
  mcpProjectRequired: true,
  // Nothing spends money or needs a publishing policy.
  policyRequired: false,
  requires: [] as const,
  // MCP clients may propose like Support and Finance: with ORBIT_MCP_TASKS
  // (the default of approvedOperation) and the gateway's proposals switch.
};

/** Who an approved proposal acts as: the proposing member's agent or client. */
const actorOf = (scope: Scope, requester?: RequestedBy): WorkActor => ({
  kind: requester?.kind === "mcp" ? "mcp" : "agent",
  id: scope.userId,
});
const sourceOf = (requester?: RequestedBy) => (requester?.kind === "mcp" ? "mcp" : "assistant");

async function taskByNumber(tx: DbTx, scope: Scope, number: number) {
  const row = await tx.workTask.findFirst({
    where: { projectId: scope.projectId, number },
    select: { id: true },
  });
  if (!row) throw new DomainError("WORK_TASK_NOT_FOUND", 404);
  return row.id;
}

async function initiativeByKey(tx: DbTx, scope: Scope, key: string | undefined) {
  if (!key) return undefined;
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, key: key.toUpperCase() },
    select: { id: true },
  });
  if (!row) throw new DomainError("WORK_INITIATIVE_NOT_FOUND", 404);
  return row.id;
}

const initiativeKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/);
const taskNumber = z.int().min(1);

// --------------------------------------------------------------- reads

export const workListInitiatives = readOperation({
  ...shared,
  name: "work_list_initiatives",
  description:
    "List the project's initiatives (Vorhaben) with key, title, status, health, dates and task counts per status category.",
  input: z
    .object({
      status: z.enum(INITIATIVE_STATUSES).optional(),
      limit: z.int().min(1).max(50).optional(),
    })
    .strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    const rows = await listInitiatives(tx, scope, { status: args.status });
    return { items: rows.slice(0, args.limit ?? 20) };
  },
});

export const workSearchTasks = readOperation({
  ...shared,
  name: "work_search_tasks",
  description:
    "Find tasks by words in title or description or by #number, filtered by status category, priority, assignee (me, none or a user id), initiative key and due date (overdue, week, none). Look tasks up before proposing changes.",
  input: z
    .object({
      query: z.string().trim().max(200).optional(),
      category: z.enum(STATUS_CATEGORIES).optional(),
      openOnly: z.boolean().optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: z.string().min(1).max(100).optional(),
      initiativeKey: initiativeKey.optional(),
      due: z.enum(["overdue", "week", "none"]).optional(),
      limit: z.int().min(1).max(50).optional(),
    })
    .strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    const initiative = await initiativeByKey(tx, scope, args.initiativeKey);
    const page = await listTasks(tx, scope, {
      ...(args.query ? { q: args.query } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.openOnly ? { open: "true" } : {}),
      ...(args.priority ? { priority: args.priority } : {}),
      ...(args.assignee ? { assignee: args.assignee } : {}),
      ...(initiative ? { initiative } : {}),
      ...(args.due ? { due: args.due } : {}),
      limit: String(args.limit ?? 20),
    });
    return {
      total: page.total,
      items: page.items.map((t) => ({
        number: t.number,
        title: t.title,
        status: t.status,
        statusCategory: t.statusCategory,
        priority: t.priority,
        assigneeUserId: t.assigneeUserId,
        dueDate: t.dueDate,
        labels: t.labels,
        initiativeId: t.initiativeId,
        version: t.version,
        blockedBy: t.counts.blockedBy,
      })),
    };
  },
});

export const workGetTask = readOperation({
  ...shared,
  name: "work_get_task",
  description:
    "Read one task by number: fields, version, checklist, subtasks, dependencies, linked objects and the latest comments and history.",
  input: z.object({ number: taskNumber }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    const d = await taskDetail(tx, scope, await taskByNumber(tx, scope, args.number));
    return {
      task: { ...d.task, rank: undefined },
      initiative: d.initiative,
      milestone: d.milestone && { id: d.milestone.id, title: d.milestone.title, dueDate: d.milestone.dueDate },
      subtasks: d.subtasks.map((s) => ({ number: s.number, title: s.title, statusCategory: s.statusCategory })),
      checklist: d.checklist.map((c) => ({ text: c.text, done: c.done })),
      waitsFor: d.dependencies.waitsFor.map((x) => x.task?.number ?? null),
      blocks: d.dependencies.blocks.map((x) => x.task?.number ?? null),
      // Titles that may hold personal data stay in Orbit.
      links: d.links.map((l) => ({
        relation: l.relation,
        direction: l.direction,
        type: l.object.type,
        id: l.object.id,
        state: l.object.state,
        title: l.object.state === "ok" && !l.object.sensitive ? l.object.title : undefined,
      })),
      comments: d.timeline
        .filter((e) => e.kind === "comment" && !e.deletedAt)
        .slice(-10)
        .map((e) => ({ at: e.at, author: e.kind === "comment" ? e.authorUserId : null, body: e.kind === "comment" ? e.body : "" })),
      history: d.timeline
        .filter((e) => e.kind === "event")
        .slice(-15)
        .map((e) => ({ at: e.at, type: e.kind === "event" ? e.type : "" })),
    };
  },
});

export const workProgress = readOperation({
  ...shared,
  name: "work_progress",
  description:
    "Progress of the project or one initiative: open, overdue, due-this-week and blocked counts and progress per initiative.",
  input: z.object({ initiativeKey: initiativeKey.optional() }).strict(),
  permission: WORK_READ,
  async run(tx, scope, args) {
    const view = await overview(tx, scope);
    if (!args.initiativeKey) return { counts: view.counts, initiatives: view.initiatives };
    const id = await initiativeByKey(tx, scope, args.initiativeKey);
    const all = await listInitiatives(tx, scope, {});
    return { initiative: all.find((i) => i.id === id) ?? null };
  },
});

export const workMyTasks = readOperation({
  ...shared,
  name: "work_my_tasks",
  description: "The member's own open tasks, grouped as overdue, today, this week, later and without due date.",
  input: z.object({}).strict(),
  permission: WORK_READ,
  async run(tx, scope) {
    const groups = await myTasks(tx, scope);
    return Object.fromEntries(
      Object.entries(groups).map(([group, items]) => [
        group,
        items.map((t) => ({ number: t.number, title: t.title, status: t.status, dueDate: t.dueDate, priority: t.priority })),
      ]),
    );
  },
});

// ----------------------------------------------------------- proposals

const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeUserId: z.string().min(1).max(100).optional(),
  dueDate: dateInput.optional(),
  labels: z.array(z.string().max(40)).max(10).optional(),
  checklist: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
};

const initiativeInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    key: initiativeKey.optional(),
    startDate: dateInput.optional(),
    targetDate: dateInput.optional(),
    milestones: z
      .array(z.object({ title: z.string().trim().min(1).max(200), dueDate: dateInput.optional() }).strict())
      .max(20)
      .optional(),
  })
  .strict();

export const workProposeInitiative = approvedOperation({
  ...proposal,
  name: "work_propose_initiative",
  description:
    "Propose a new initiative (Vorhaben) with optional milestones. Dates are YYYY-MM-DD.",
  input: initiativeInput,
  permission: WORK_WRITE,
  summary: (args) => ({
    operation: { kind: "initiative", title: args.title, milestones: (args.milestones ?? []).map((m: { title: string }) => m.title) },
  }),
  // The service's own checks, before a member is asked to approve.
  async validate(tx, scope, args) {
    const fields = args as z.infer<typeof initiativeInput>;
    createInitiativeInput.parse({
      title: fields.title,
      description: fields.description,
      key: fields.key?.toUpperCase(),
      startDate: fields.startDate,
      targetDate: fields.targetDate,
    });
    if (fields.startDate && fields.targetDate && fields.targetDate < fields.startDate)
      throw new DomainError("WORK_DATES_INVALID", 422);
    if (
      fields.key &&
      (await tx.workInitiative.findFirst({
        where: { projectId: scope.projectId, key: fields.key.toUpperCase() },
        select: { id: true },
      }))
    )
      throw new DomainError("WORK_KEY_TAKEN", 409);
  },
  async run(tx, scope, args, requester) {
    const actor = actorOf(scope, requester);
    const { milestones, ...fields } = args as z.infer<typeof initiativeInput>;
    const initiative = await createInitiative(tx, scope, { ...fields, key: fields.key?.toUpperCase() }, actor);
    for (const m of milestones ?? []) await createMilestone(tx, scope, initiative.id, m, actor);
    return { initiativeId: initiative.id, key: initiative.key };
  },
});

const tasksInput = z
  .object({
    initiativeKey: initiativeKey.optional(),
    milestoneId: z.uuid().optional(),
    tasks: z.array(z.object(taskFields).strict()).min(1).max(25),
  })
  .strict();

export const workProposeTasks = approvedOperation({
  ...proposal,
  name: "work_propose_tasks",
  description:
    "Propose a batch of 1 to 25 new tasks, optionally in an initiative (by key) and milestone. Never invent assignees: use member ids from Orbit or leave them out. Dates are YYYY-MM-DD.",
  input: tasksInput,
  permission: WORK_WRITE,
  summary: (args) => ({
    operation: {
      kind: "tasks",
      initiativeKey: args.initiativeKey ?? null,
      titles: args.tasks.map((t: { title: string }) => t.title),
    },
  }),
  // Every task as the service would take it, before a member is asked.
  async validate(tx, scope, args) {
    const input = args as z.infer<typeof tasksInput>;
    const initiativeId = await initiativeByKey(tx, scope, input.initiativeKey);
    if (input.milestoneId) {
      const milestone = await tx.workMilestone.findFirst({
        where: { projectId: scope.projectId, id: input.milestoneId },
        select: { initiativeId: true },
      });
      if (!milestone) throw new DomainError("WORK_MILESTONE_NOT_FOUND", 422);
      if (milestone.initiativeId !== initiativeId) throw new DomainError("WORK_MILESTONE_MISMATCH", 409);
    }
    const assignable = await assignableIds(scope);
    for (const task of input.tasks) {
      createTaskInput.parse(task);
      if (task.assigneeUserId && !assignable.has(task.assigneeUserId))
        throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
    }
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof tasksInput>;
    const initiativeId = await initiativeByKey(tx, scope, input.initiativeKey);
    const created = await createTasks(
      tx,
      scope,
      input.tasks.map((t) => ({
        ...t,
        ...(initiativeId ? { initiativeId } : {}),
        ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
      })),
      actorOf(scope, requester),
      sourceOf(requester),
    );
    return { numbers: created.map((t) => t.number) };
  },
});

const updateInput = z
  .object({
    number: taskNumber,
    expectedVersion: z.int().min(1),
    changes: z
      .object({
        status: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assigneeUserId: z.string().min(1).max(100).nullable().optional(),
        startDate: dateInput.nullable().optional(),
        dueDate: dateInput.nullable().optional(),
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(50000).nullable().optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
      })
      .strict(),
  })
  .strict();

export const workProposeTaskUpdate = approvedOperation({
  ...proposal,
  name: "work_propose_task_update",
  description:
    "Propose changes to one task by number with the version you read (work_get_task or work_search_tasks): status key, priority, assignee, dates, title, description or labels. Refused if the task changed meanwhile.",
  input: updateInput,
  permission: WORK_WRITE,
  summary: (args) => ({
    operation: { kind: "update", number: args.number, fields: Object.keys(args.changes ?? {}) },
  }),
  // The change as the service would take it, against the task as it is now.
  async validate(tx, scope, args) {
    const input = args as z.infer<typeof updateInput>;
    const task = await loadTask(tx, scope, await taskByNumber(tx, scope, input.number));
    updateTaskInput.parse({ expectedVersion: input.expectedVersion, ...input.changes });
    if (task.version !== input.expectedVersion) throw new DomainError("WORK_VERSION_CONFLICT", 409);
    if (input.changes.status && input.changes.status !== task.status) {
      const { settings } = await readWorkSettings(tx, scope);
      if (!statusOf(settings, input.changes.status)) throw new DomainError("WORK_STATUS_UNKNOWN", 422);
      const allowed = settings.workflow.transitions?.[task.status];
      if (allowed && !allowed.includes(input.changes.status))
        throw new DomainError("WORK_TRANSITION_NOT_ALLOWED", 409);
    }
    if (
      input.changes.assigneeUserId &&
      input.changes.assigneeUserId !== task.assigneeUserId &&
      !(await assignableIds(scope)).has(input.changes.assigneeUserId)
    )
      throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof updateInput>;
    const id = await taskByNumber(tx, scope, input.number);
    const task = await updateTask(tx, scope, id, { expectedVersion: input.expectedVersion, ...input.changes }, actorOf(scope, requester));
    return { number: task.number, version: task.version, status: task.status };
  },
});

const commentInput = z
  .object({ number: taskNumber, body: z.string().trim().min(1).max(4000) })
  .strict();

export const workProposeComment = approvedOperation({
  ...proposal,
  name: "work_propose_comment",
  description: "Propose a comment on one task by number.",
  input: commentInput,
  permission: WORK_WRITE,
  summary: (args) => ({ operation: { kind: "comment", number: args.number, body: args.body } }),
  async validate(tx, scope, args) {
    await taskByNumber(tx, scope, args.number);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof commentInput>;
    const id = await taskByNumber(tx, scope, input.number);
    const comment = await addComment(tx, scope, id, { body: input.body }, actorOf(scope, requester));
    return { commentId: comment.id };
  },
});

const proposals = [workProposeInitiative, workProposeTasks, workProposeTaskUpdate, workProposeComment];

/** The module's tools: reads first, then proposals. */
export const workTools = [
  workSearchTasks,
  workGetTask,
  workListInitiatives,
  workProgress,
  workMyTasks,
  ...proposals.map((p) => p.tool),
];

/** The proposals' approval request types. */
export const workActionTypes = Object.fromEntries(proposals.map((p) => [p.actionType, p.action]));

/** The assistant prompt fragment: short, factual, English. */
export const workInstructions = [
  "Project management (module work): initiatives (Vorhaben) contain milestones and tasks; tasks have a number (#12), a status key in a fixed category (backlog, todo, in_progress, blocked, in_review, done, canceled), priority, assignee and dates (YYYY-MM-DD). Look tasks up with work_search_tasks or work_get_task before proposing changes, propose new tasks in batches with work_propose_tasks, never invent assignees, and pass the version you read. Proposals change nothing until a member approves them in Orbit.",
];
