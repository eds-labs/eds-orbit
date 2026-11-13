/**
 * The personal Orbit Assistant's user tools (ADR 0022 §4, plan
 * agent-platform-phase-3 §2.2, WP3.2): platform tools with `scopeShape:
 * "user"` that act for the signed-in user across the business projects they
 * may reach. Each reads one project at a time in that project's own
 * transaction with the user's current scope there (agents/project-reads.ts)
 * and labels every item with `{projectId, projectName}`; a project or part
 * without access contributes only a refusal code. They are offered only in
 * personal mode (`exposure: { assistant: false, personal: true }`): never in
 * project chat, over MCP or to configured agents.
 *
 * Extension point (WP3.7): `context_list` and `context_remember` join this
 * list as further user tools (`USER_TOOLS`), with the same shape.
 *
 * `action_status` is a project tool (one target project), offered in
 * personal mode only; it shares its reader with MCP `orbit_action_status`
 * (governance/action-requests.ts `actionRequestStatus`).
 */
import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  dropNullFields,
  defineTool,
  type OrbitTool,
  type ToolContext,
} from "../agents/tools/registry.ts";
import { listAgents } from "../agents/definitions/service.ts";
import {
  agentPlatformEnabled,
  listWorkOrders,
  maySeeWorkOrder,
  readWorkOrder,
  workOrderView,
} from "../agents/work-orders/service.ts";
import { moduleAttentionItems, sortAttention } from "../attention/attention.ts";
import {
  actionRequestStatus,
  decidableBy,
  openDecidableRequests,
} from "../governance/action-requests.ts";
import {
  moduleAvailable,
  registeredAssistantOverviews,
  registeredRegistry,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { scoped } from "../../../../../packages/db/src/index.ts";
import {
  accessibleBusinessProjects,
  isRefusal,
  readEachProject,
  type PerProject,
} from "../agents/project-reads.ts";
import { ProjectCallRefused } from "../agents/project-calls.ts";
import { data, DomainError } from "../shared.ts";
import type { ChatCard } from "./cards.ts";
import { actionRequestCard } from "./personal-mode.ts";
import { agentDelegate } from "./delegation.ts";
import { appendNotice } from "./notices.ts";
import {
  addContext,
  contextCategories,
  groundedInUserText,
  readAssistantSettings,
  screenContextText,
} from "./personal-context.ts";
import { userScoped } from "../tenancy/scope.ts";
import {
  isProjectRefusal,
  projectMemberScope,
} from "../agents/project-calls.ts";
import {
  hiddenModules,
  highestRole,
  moduleScope,
  visibleModules,
} from "../tenancy/module-roles.ts";
import {
  AGENTS_READ,
  can,
  PROJECT_READ,
  PROJECT_WRITE,
} from "../tenancy/permissions.ts";
import { inProject } from "../management/links.ts";

const USER_EXPOSURE = { assistant: false, personal: true } as const;
/** Cards one tool result carries at most (the message keeps 20). */
const MAX_CARDS = 10;
/** Items of one kind a project contributes to an answer at most. */
const PER_PROJECT_ITEMS = 5;
const DAY = 86_400_000;

const projectIdsParam = z
  .array(z.string())
  .max(50)
  .nullable()
  .describe("Project ids from projects_list; null for every project");
const projectIdsInput = z.array(z.uuid()).max(50).nullish();

/** The user whose tools these are: the personal turn's member. */
const who = (context: ToolContext) => ({
  workspaceId: context.scope.workspaceId,
  userId: context.scope.userId,
});

/** The projects whose data a result returns, for the turn's taint. */
function note<T>(context: ToolContext, entries: PerProject<T>[]) {
  context.personal?.noteProjects(
    entries.filter((entry) => !isRefusal(entry)).map((entry) => entry.projectId),
  );
}

/** A per-project entry as tools return it: the label, then the value or the refusal. */
const labelled = <T extends object>(entry: PerProject<T>) =>
  isRefusal(entry)
    ? entry
    : { projectId: entry.projectId, projectName: entry.projectName, ...entry.value };

/** The modules the member may use in the project, in registry order. */
async function memberModules(tx: DbTx, scope: Scope) {
  const enabled = visibleModules(scope, await enabledModules(tx, scope));
  return registeredRegistry().order.filter(
    (id) => moduleAvailable(id) && (!enabled || enabled.has(id)),
  );
}

// ---------------------------------------------------------------------------

export const projectsListOutput = z
  .object({
    workspace: z.object({ id: z.string(), name: z.string() }).strict(),
    projects: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          role: z.enum(["owner", "editor", "viewer"]),
          modules: z.array(z.string()),
        })
        .strict(),
    ),
    truncated: z.boolean(),
  })
  .strict();

/**
 * The business projects the user may reach in the organization, by name,
 * with their role and the modules they may use there (at most 50; more
 * exist when `truncated`). Replaces MCP `orbit_projects` for the assistant;
 * the MCP name stays a native alias with its grant rules.
 */
export const projectsList = defineTool({
  name: "projects_list",
  namespace: "project",
  description:
    "List the Orbit projects you may use in this organization, with your role and each project's modules. Pass a project's id as projectId to project tools and load_project_tools.",
  parameters: z.object({}).strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  outputSchema: projectsListOutput,
  async execute(context) {
    const { workspaceId, userId } = who(context);
    const workspace = await authDb.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) throw new DomainError("NOT_FOUND", 404);
    const { truncated } = await accessibleBusinessProjects(workspaceId, userId);
    const entries = await readEachProject({ workspaceId, userId }, async (tx, scope) => ({
      role: highestRole(scope),
      modules: await memberModules(tx, scope),
    }));
    const projects = entries.flatMap((entry) =>
      isRefusal(entry)
        ? []
        : [
            {
              id: entry.projectId,
              name: entry.projectName,
              role: entry.value.role,
              modules: entry.value.modules,
            },
          ],
    );
    return { output: { workspace, projects, truncated }, cards: [] };
  },
});

// ---------------------------------------------------------------------------

/**
 * One project's overview for the member. Every part is read with the
 * member's role: open approvals only for those who may decide, a module's
 * part only while it is enabled (PERMISSION_DENIED when the member's module
 * role hides it or may not read it), failed work orders only with agent
 * read access.
 */
async function projectOverview(
  tx: DbTx,
  scope: Scope,
  project: { id: string },
  options: { modules: readonly string[] | null; now: Date },
) {
  const { now } = options;
  const enabled = await enabledModules(tx, scope);
  const hidden = hiddenModules(scope);
  const attention = sortAttention(
    await moduleAttentionItems(tx, scope, now, { enabled }),
  )
    .filter(
      (item) => !options.modules || options.modules.includes(item.moduleId),
    )
    .slice(0, PER_PROJECT_ITEMS)
    .map((item) => ({
      moduleId: item.moduleId,
      kind: item.kind,
      severity: item.severity,
      ...(item.count !== undefined ? { count: item.count } : {}),
      ...(item.dueAt ? { dueAt: item.dueAt } : {}),
      params: item.params,
      link: inProject(project.id, item.link),
    }));

  let approvals: Record<string, unknown>;
  if (!can({ role: highestRole(scope) }, PROJECT_WRITE))
    approvals = { refusal: "PERMISSION_DENIED" };
  else {
    const rows = await openDecidableRequests(tx, scope, now);
    approvals = {
      count: rows.length,
      items: rows.slice(0, PER_PROJECT_ITEMS).map((row) => ({
        id: row.id,
        actionType: String(data(row).actionType),
        riskClass: String(data(row).riskClass ?? ""),
      })),
      link: `/p/${project.id}/decisions`,
    };
  }

  const modules: Record<string, unknown> = {};
  for (const [moduleId, read] of registeredAssistantOverviews()) {
    if (options.modules && !options.modules.includes(moduleId)) continue;
    if (!moduleAvailable(moduleId)) continue;
    if (enabled && !enabled.has(moduleId)) continue;
    if (hidden.includes(moduleId)) {
      modules[moduleId] = { refusal: "PERMISSION_DENIED" };
      continue;
    }
    const part = await read(tx, moduleScope(scope, moduleId), now);
    modules[moduleId] = part
      ? linkInProject(project.id, part)
      : { refusal: "PERMISSION_DENIED" };
  }

  let workOrders: Record<string, unknown> | undefined;
  if (agentPlatformEnabled()) {
    if (!can(scope, AGENTS_READ)) workOrders = { refusal: "PERMISSION_DENIED" };
    else {
      const rows = await tx.agentWorkOrder.findMany({
        where: {
          projectId: scope.projectId,
          // Agent work only: MCP tasks (target assistant) are user-private.
          target: "agent",
          status: { in: ["failed", "blocked", "outcome_unknown"] },
          finishedAt: { gte: new Date(now.getTime() - DAY) },
        },
        orderBy: { finishedAt: "desc" },
        take: 50,
      });
      const visible = rows.filter((row) => maySeeWorkOrder(scope, row));
      workOrders = {
        failed24h: visible.length,
        items: visible.slice(0, PER_PROJECT_ITEMS).map((row) => ({
          id: row.id,
          agentId: row.agentId,
          status: row.status,
          errorCode: row.errorCode,
        })),
      };
    }
  }
  return {
    attention,
    approvals,
    modules,
    ...(workOrders ? { workOrders } : {}),
  };
}

/** A module part's in-app links (below /p/:id) made absolute paths of the project. */
function linkInProject(projectId: string, part: Record<string, unknown>) {
  const fix = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fix);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          key,
          key === "link" && typeof field === "string" && field.startsWith("/")
            ? inProject(projectId, field)
            : fix(field),
        ]),
      );
    return value;
  };
  return fix(part) as Record<string, unknown>;
}

export const myOverview = defineTool({
  name: "my_overview",
  namespace: "project",
  description:
    "Your overview across projects: what needs attention, open approvals you may decide, your open tasks, support counts and failed agent runs of the last 24 hours. Every item names its project; a project or module you may not use shows only a refusal code.",
  parameters: z
    .object({
      projectIds: projectIdsParam,
      modules: z
        .array(z.string())
        .max(10)
        .nullable()
        .describe("Only these modules (for example work, support); null for all"),
    })
    .strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  async execute(context, args) {
    const input = z
      .object({
        projectIds: projectIdsInput,
        modules: z.array(z.string().max(40)).max(10).nullish(),
      })
      .strict()
      .parse(dropNullFields(args ?? {}));
    const now = new Date();
    const entries = await readEachProject(
      { ...who(context), projectIds: input.projectIds },
      (tx, scope, project) =>
        projectOverview(tx, scope, project, {
          modules: input.modules ?? null,
          now,
        }),
    );
    note(context, entries);
    return { output: { projects: entries.map(labelled) }, cards: [] };
  },
});

// ---------------------------------------------------------------------------

export const pendingApprovals = defineTool({
  name: "pending_approvals",
  namespace: "proposals",
  description:
    "Open approvals you may decide, across your projects: type, effect class and the link to the project's decisions page. Deciding stays in each project.",
  parameters: z.object({ projectIds: projectIdsParam }).strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  async execute(context, args) {
    const input = z
      .object({ projectIds: projectIdsInput })
      .strict()
      .parse(dropNullFields(args ?? {}));
    const now = new Date();
    const cards: ChatCard[] = [];
    const entries = await readEachProject(
      { ...who(context), projectIds: input.projectIds },
      async (tx, scope, project) => {
        // As the approvals summary: only members who may decide anything.
        if (!can({ role: highestRole(scope) }, PROJECT_WRITE))
          throw new ProjectCallRefused("PERMISSION_DENIED");
        const rows = await openDecidableRequests(tx, scope, now);
        // One decision card per request (WP3.5), bound to its version and
        // hash; deciding stays on the project's decide route.
        for (const row of rows.slice(0, 5))
          if (cards.length < MAX_CARDS)
            cards.push({
              kind: "status",
              label: String(data(row).actionType).slice(0, 160),
              status: "confirmation_required",
              href: `/p/${project.id}/decisions`,
              projectId: project.id,
              projectName: project.name,
              actionRequest: actionRequestCard(scope, row, now),
            });
        return {
          count: rows.length,
          requests: rows.slice(0, 10).map((row) => ({
            id: row.id,
            actionType: String(data(row).actionType),
            riskClass: String(data(row).riskClass ?? ""),
            expiresAt: String(data(row).expiresAt),
          })),
          link: `/p/${project.id}/decisions`,
        };
      },
    );
    // Without a project list, members without decisions stay out.
    const shown = input.projectIds?.length
      ? entries
      : entries.filter((entry) => !isRefusal(entry) && entry.value.count > 0);
    note(context, shown);
    return { output: { projects: shown.map(labelled) }, cards };
  },
});

// ---------------------------------------------------------------------------

export const agentsListTool = defineTool({
  name: "agents_list",
  namespace: "agents",
  description:
    "Configured agents you may view or run, per project: name and status. Projects where you may not view agents show a refusal code.",
  parameters: z.object({ projectIds: projectIdsParam }).strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  async execute(context, args) {
    const input = z
      .object({ projectIds: projectIdsInput })
      .strict()
      .parse(dropNullFields(args ?? {}));
    if (!agentPlatformEnabled())
      return { output: { projects: [], error: "AGENT_PLATFORM_DISABLED" }, cards: [] };
    const entries = await readEachProject(
      { ...who(context), projectIds: input.projectIds },
      async (tx, scope) => {
        if (!can(scope, AGENTS_READ))
          throw new ProjectCallRefused("PERMISSION_DENIED");
        const agents = await listAgents(tx, scope);
        return {
          agents: agents.slice(0, 20).map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
          })),
        };
      },
    );
    note(context, entries);
    return { output: { projects: entries.map(labelled) }, cards: [] };
  },
});

// ---------------------------------------------------------------------------

const WORK_ORDER_STATUSES = [
  "queued",
  "awaiting_start",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "blocked",
  "canceled",
  "outcome_unknown",
] as const;

const OPEN_WORK = new Set(["queued", "awaiting_start", "running", "waiting_approval"]);

/**
 * A delegation batch's status from its work orders (plan §2.5 step 3, as
 * `taskSnapshot` derives a task's): running while any is open, succeeded
 * when all succeeded, failed when none did, else partially_failed.
 */
export function batchStatus(statuses: readonly string[]) {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  const succeeded = counts.succeeded ?? 0;
  const status = !statuses.length
    ? "unknown"
    : statuses.some((s) => OPEN_WORK.has(s))
      ? "running"
      : succeeded === statuses.length
        ? "succeeded"
        : succeeded === 0
          ? "failed"
          : "partially_failed";
  return { status, total: statuses.length, counts };
}

/** What the assistant sees of a work order: status and result, never raw steps. */
function workOrderSummary(view: ReturnType<typeof workOrderView>) {
  return {
    id: view.id,
    agentId: view.agentId,
    origin: view.origin,
    goal: view.goal,
    status: view.status,
    errorCode: view.errorCode,
    result: view.result,
    createdAt: view.createdAt,
    finishedAt: view.finishedAt,
  };
}

/**
 * `agent_work_order_status` (the plan's `work_order_status`): renamed
 * because `work_` is the Work module's tool prefix (MCP names, catalogue
 * and contract tests group tools by it).
 */
export const workOrderStatus = defineTool({
  name: "agent_work_order_status",
  namespace: "agents",
  description:
    "Status and result of agent work orders you requested or may view: one by id, a delegation batch by its batchId (with the batch status derived from its work orders), or the latest per project.",
  parameters: z
    .object({
      projectId: z.string().nullable().describe("The work order's project; null for all projects"),
      workOrderId: z.string().nullable(),
      batchId: z.string().nullable().describe("A batch id agent_delegate returned"),
      status: z.enum(WORK_ORDER_STATUSES).nullable(),
    })
    .strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  async execute(context, args) {
    const input = z
      .object({
        projectId: z.uuid().nullish(),
        workOrderId: z.uuid().nullish(),
        batchId: z.uuid().nullish(),
        status: z.enum(WORK_ORDER_STATUSES).nullish(),
      })
      .strict()
      .parse(dropNullFields(args ?? {}));
    if ((input.workOrderId || input.batchId) && !input.projectId)
      throw new DomainError("PROJECT_REQUIRED", 400);
    if (!agentPlatformEnabled())
      return { output: { projects: [], error: "AGENT_PLATFORM_DISABLED" }, cards: [] };
    const entries = await readEachProject(
      { ...who(context), projectIds: input.projectId ? [input.projectId] : null },
      async (tx, scope) => {
        if (!can(scope, AGENTS_READ))
          throw new ProjectCallRefused("PERMISSION_DENIED");
        if (input.batchId) {
          const rows = await tx.agentWorkOrder.findMany({
            where: {
              projectId: scope.projectId,
              target: "agent",
              origin: "assistant",
              requestedBy: { path: ["batchId"], equals: input.batchId },
            },
            orderBy: { createdAt: "asc" },
            take: 10,
          });
          const visible = rows.filter((row) => maySeeWorkOrder(scope, row));
          return {
            batch: { batchId: input.batchId, ...batchStatus(visible.map((row) => row.status)) },
            workOrders: visible.map((row) => workOrderSummary(workOrderView(row))),
          };
        }
        if (input.workOrderId) {
          const row = await readWorkOrder(tx, scope, input.workOrderId).catch(
            (error: unknown) => {
              if (error instanceof DomainError && error.status === 404)
                return null;
              throw error;
            },
          );
          return {
            workOrders: row ? [workOrderSummary(workOrderView(row))] : [],
            ...(row ? {} : { error: "NOT_FOUND" }),
          };
        }
        const page = await listWorkOrders(tx, scope, {
          limit: PER_PROJECT_ITEMS,
          ...(input.status ? { status: input.status } : {}),
        });
        return { workOrders: page.items.map(workOrderSummary) };
      },
    );
    note(context, entries);
    return { output: { projects: entries.map(labelled) }, cards: [] };
  },
});

// ---------------------------------------------------------------------------

export const actionStatusOutput = z
  .object({
    actionRequestId: z.string(),
    actionType: z.string(),
    status: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    decidedAt: z.string().nullable(),
    link: z.string(),
  })
  .strict();

/**
 * The state of one approval request in the target project: one the user
 * asked for (through any channel) or may decide. NOT_FOUND for any other.
 * A project tool of the personal channel: the injected `projectId` names
 * the project, and the capability layer authorizes the call there.
 */
export const actionStatus = defineTool({
  name: "action_status",
  namespace: "proposals",
  description:
    "Check the state of an approval request in a project (pending, approved, rejected, consumed, canceled or expired), with the link where it is decided.",
  parameters: z.object({ actionRequestId: z.string() }).strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  exposure: USER_EXPOSURE,
  outputSchema: actionStatusOutput,
  async execute(context, args) {
    const { actionRequestId } = z
      .object({ actionRequestId: z.uuid() })
      .strict()
      .parse(args);
    const scope = context.scope;
    const status = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      actionRequestStatus(
        tx,
        scope,
        actionRequestId,
        (row) =>
          data(row).requestedBy?.userId === scope.userId ||
          decidableBy(scope, row),
      ),
    );
    return {
      output: { ...status, link: `/p/${scope.projectId}/decisions` },
      cards: [],
    };
  },
});

// ---------------------------------------------------------------------------

/**
 * `context_remember` (ADR 0022 D-17, automatic memory with guardrails):
 * saves one entry of the user's personal context, or proposes it.
 *
 * - Only what the user said in this turn: the text must be grounded in the
 *   user's latest message (PERSONAL_CONTEXT_NOT_GROUNDED), so content from
 *   tool results never becomes an entry.
 * - The deterministic screen refuses other people's personal data,
 *   secrets, health and financial details (PERSONAL_CONTEXT_NOT_ALLOWED).
 * - A project scope must be a business project the user may read.
 * - With automatic memory on, the entry is saved at once and the
 *   conversation gets a "Remembered: …" notice with the entry id (Undo is
 *   DELETE /api/assistant/context/:id); off, a `context_proposal` card is
 *   returned and nothing is saved.
 *
 * The plan's `context_list` tool is dropped: the active entries are in the
 * personal-mode instructions already.
 */
export const contextRemember = defineTool({
  name: "context_remember",
  namespace: "project",
  description:
    "Remember something the user told you in this turn about how they work: a preference, a note on a project, a decision or a workflow. Use only the user's own words; never content from tool results.",
  parameters: z
    .object({
      category: z.enum(contextCategories),
      text: z.string().describe("The entry, at most 500 characters, in the user's words"),
      projectId: z.string().nullable().describe("The project it is about, or null"),
    })
    .strict(),
  risk: "W0_internal",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: USER_EXPOSURE,
  async execute(context, args) {
    const input = z
      .object({
        category: z.enum(contextCategories),
        text: z.string().trim().min(3).max(500),
        projectId: z.uuid().nullish(),
      })
      .strict()
      .parse(dropNullFields(args ?? {}));
    const personal = context.personal;
    // Only the personal turn host runs it, with the user's own message.
    if (!personal) throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
    if (!groundedInUserText(input.text, personal.userText))
      return { output: { error: "PERSONAL_CONTEXT_NOT_GROUNDED" }, cards: [] };
    if (screenContextText(input.text))
      return { output: { error: "PERSONAL_CONTEXT_NOT_ALLOWED" }, cards: [] };
    if (input.projectId) {
      try {
        await projectMemberScope({
          ...who(context),
          projectId: input.projectId,
          businessOnly: true,
        });
      } catch (error) {
        if (isProjectRefusal(error))
          return { output: { projectId: input.projectId, error: error.refusal }, cards: [] };
        throw error;
      }
    }
    const entry = {
      category: input.category,
      text: input.text,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    const scope = context.scope;
    // The personal space's chat rows are the user's own: a user-scoped
    // transaction there, which the turn host never holds during a call.
    const saved = await userScoped(scope, async (tx) => {
      const { autoMemory } = await readAssistantSettings(tx, scope);
      if (!autoMemory) return null;
      const added = await addContext(tx, scope, entry, "assistant", {
        conversationId: context.conversationId,
      });
      await appendNotice(
        tx,
        scope,
        context.conversationId,
        {
          kind: "context_saved",
          key: `context:${added.id}`,
          entryId: added.id,
          text: added.text,
        },
        `Remembered: ${added.text}`,
      );
      return added;
    });
    if (saved)
      return {
        output: { saved: true, entryId: saved.id, notice: "shown with undo" },
        cards: [],
      };
    return {
      output: { saved: false, proposed: true },
      cards: [
        {
          kind: "context_proposal",
          label: "Remember this?",
          contextProposal: entry,
        },
      ],
    };
  },
});

/**
 * The user tools in the order they are offered (at most eight with
 * WP3.6/WP3.7's tools; `load_project_tools` is the turn host's own).
 */
export const USER_TOOLS: readonly OrbitTool[] = [
  projectsList,
  myOverview,
  pendingApprovals,
  agentsListTool,
  workOrderStatus,
  contextRemember,
  agentDelegate,
];

/** The platform tools this file registers (user tools plus `action_status`). */
export const personalAssistantTools: readonly OrbitTool[] = [
  ...USER_TOOLS,
  actionStatus,
];
