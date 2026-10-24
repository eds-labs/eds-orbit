import { taskSnapshotSchema } from "../../tasks/schemas.ts";
import { mcp2Enabled } from "../../tasks/operation-tools.ts";
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import {
  taskInput,
  createTask,
  readTask,
  listTasks,
  cancelTask,
} from "../../tasks/tasks.ts";
import { data, DomainError } from "../../shared.ts";
import { principalModules } from "../visibility.ts";
import { lacksModuleConsent } from "../scopes.ts";
import { projectScope } from "../principal.ts";
import type { NativeTool } from "../native-tools.ts";
import type { McpPrincipal } from "../principal.ts";

const project = z.object({ projectId: z.uuid() });
const target = project.extend({ taskId: z.uuid() }).strict();
const result = z
  .object({ schemaVersion: z.literal(1), task: taskSnapshotSchema })
  .strict();
async function scopeForTask(
  p: McpPrincipal,
  projectId: string,
  taskId: string,
) {
  const scope = await projectScope(p, projectId);
  const task = await readTask(scope, taskId, p.clientId);
  const allowed = await principalModules(p, scope);
  if (
    (task.modules as string[]).some((m) => !allowed.includes(m)) ||
    ((task.modules as string[]).includes("support") &&
      !p.scopes.has("orbit:support")) ||
    lacksModuleConsent(task.modules as string[], p.scopes)
  )
    throw new DomainError("NOT_FOUND", 404);
  return scope;
}

export const taskTools: readonly NativeTool[] = [
  {
    name: "orbit_create_task",
    proposal: true,
    available: mcp2Enabled,
    description:
      "Create a durable work order for the existing Orbit Assistant. Returns a task ID and exact start approval; no paid work starts before owner approval. Reuse the same idempotencyKey on retry. Modules must be explicitly granted. Draft mode prepares further approvals; execute mode additionally needs orbit:write and never approves itself.",
    risk: "P_proposal",
    inputSchema: project.extend(taskInput.shape).strict(),
    outputSchema: z
      .object({
        taskId: z.string(),
        actionRequestId: z.string(),
        deduplicated: z.boolean(),
        approveUrl: z.string(),
      })
      .strict(),
    async run(p, args, ctx) {
      ctx.setAuditProject(String(args.projectId));
      const { projectId, ...input } = args;
      return createTask(p, String(projectId), input);
    },
  },
  {
    name: "orbit_get_task",
    available: mcp2Enabled,
    description:
      "Read a work order's durable phase, run, blockers and approval IDs. Only this user's tasks created through this client are returned.",
    risk: "R0_read",
    inputSchema: target,
    outputSchema: result,
    async run(p, args, ctx) {
      const a = target.parse(args);
      ctx.setAuditProject(a.projectId);
      const scope = await scopeForTask(p, a.projectId, a.taskId);
      return {
        schemaVersion: 1,
        task: await readTask(scope, a.taskId, p.clientId),
      };
    },
  },
  {
    name: "orbit_get_task_result",
    available: mcp2Enabled,
    description:
      "Read the assistant result and generated artifact references for this connection's work order; pending approvals and blockers remain explicit.",
    risk: "R0_read",
    inputSchema: target,
    outputSchema: result,
    async run(p, args, ctx) {
      const a = target.parse(args);
      ctx.setAuditProject(a.projectId);
      const scope = await scopeForTask(p, a.projectId, a.taskId);
      return {
        schemaVersion: 1,
        task: await readTask(scope, a.taskId, p.clientId),
      };
    },
  },
  {
    name: "orbit_list_tasks",
    available: mcp2Enabled,
    description:
      "List this connection's work orders in a granted project, with bounded pagination and no result bodies.",
    risk: "R0_read",
    inputSchema: project
      .extend({
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      })
      .strict(),
    outputSchema: z
      .object({
        schemaVersion: z.literal(1),
        items: z.array(taskSnapshotSchema.omit({ result: true })),
        nextCursor: z.string().nullable(),
      })
      .strict(),
    async run(p, args, ctx) {
      const a = this.inputSchema.parse(args) as any;
      ctx.setAuditProject(a.projectId);
      const scope = await projectScope(p, a.projectId);
      const found = await listTasks(scope, { ...a, clientId: p.clientId });
      const items = [];
      for (const t of found.items) {
        try {
          await scopeForTask(p, a.projectId, t.taskId);
          items.push({ ...t, description: t.description.slice(0, 160) });
        } catch (e) {
          if (!(e instanceof DomainError) || e.code !== "NOT_FOUND") throw e;
        }
      }
      return { ...found, items };
    },
  },
  {
    name: "orbit_cancel_task",
    available: mcp2Enabled,
    description:
      "Cooperatively cancel this connection's queued/running work order and pending approvals. Already transmitted requests or previously approved child work cannot be undone.",
    risk: "P_proposal",
    inputSchema: target,
    outputSchema: result,
    async run(p, args, ctx) {
      const a = target.parse(args);
      ctx.setAuditProject(a.projectId);
      const scope = await scopeForTask(p, a.projectId, a.taskId);
      return {
        schemaVersion: 1,
        task: await cancelTask(scope, a.taskId, p.clientId),
      };
    },
  },
];
