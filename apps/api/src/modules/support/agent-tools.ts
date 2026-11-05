import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { currentAgentExecution } from "../../platform/agents/agent-execution.ts";
import { defineTool } from "../../platform/agents/tools/registry.ts";
import { approvedOperation } from "../../platform/tasks/operation-tools.ts";
import { userScoped } from "../../platform/tenancy/scope.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { DomainError, hash } from "../../shared.ts";
import { assertAgentTicket, SUPPORT_AGENT_CATALOG } from "./agent-gate.ts";
import { handOff, runSupportTask, supportActor } from "./ai.ts";
import { supportActive } from "./gate.ts";
import {
  SUPPORT_TICKETS_ASSIGN,
  SUPPORT_TICKETS_READ,
  SUPPORT_TICKETS_REPLY,
} from "./permissions.ts";
import {
  TICKET_PRIORITIES,
  updateTicket,
  validateTicketUpdate,
} from "./workspace.ts";

// Tools only configured agents use (ADR 0021 Phase 2, plan §2.3). They are
// never offered to the assistant or outside clients: the paid ones wrap the
// existing triage and draft pipelines with all their checks, the others
// are content-free reads, a field-limited triage proposal and a hand-off.

const ticketInput = z.strictObject({ ticketId: z.uuid() });
const agentOnly = { assistant: false, mcp: false, agent: true } as const;
const SIMILAR_DAYS = 90;
const SIMILAR_MAX = 5;

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );

/**
 * Recent tickets of the same inbox with a similar subject or the same
 * category: ids, numbers, status and category only, never a subject or a
 * message, so nothing of another customer reaches the agent.
 */
export async function similarTickets(tx: DbTx, scope: Scope, ticketId: string) {
  const ticket = await tx.supportTicket.findFirst({
    where: { id: ticketId, projectId: scope.projectId },
  });
  if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
  const since = new Date(Date.now() - SIMILAR_DAYS * 86_400_000);
  const recent = await tx.supportTicket.findMany({
    where: {
      projectId: scope.projectId,
      inboxId: ticket.inboxId,
      id: { not: ticket.id },
      mergedIntoTicketId: null,
      createdAt: { gte: since },
    },
    select: { id: true, number: true, subject: true, status: true, category: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const own = words(ticket.subject);
  return recent
    .map((t) => {
      const shared = [...words(t.subject)].filter((w) => own.has(w)).length;
      const sameCategory = Boolean(ticket.category && t.category === ticket.category);
      return { t, score: shared * 2 + (sameCategory ? 1 : 0), sameCategory, shared };
    })
    .filter((m) => m.shared > 0 || m.sameCategory)
    .sort((a, b) => b.score - a.score || b.t.createdAt.valueOf() - a.t.createdAt.valueOf())
    .slice(0, SIMILAR_MAX)
    .map(({ t, shared, sameCategory }) => ({
      ticketId: t.id,
      number: t.number,
      status: t.status,
      category: t.category,
      match: shared > 0 ? ("subject" as const) : ("category" as const),
      ...(sameCategory && shared > 0 ? { sameCategory: true } : {}),
    }));
}

const similarOutput = z.strictObject({
  items: z.array(
    z.strictObject({
      ticketId: z.uuid(),
      number: z.number().int(),
      status: z.string(),
      category: z.string().nullable(),
      match: z.enum(["subject", "category"]),
      sameCategory: z.literal(true).optional(),
    }),
  ),
});

const similar = defineTool({
  name: "support_similar_tickets",
  namespace: "support",
  description:
    "Recent tickets of the same inbox (90 days) with a similar subject or the same category: ids, numbers, status and category only.",
  parameters: ticketInput,
  risk: "R0_read",
  permission: SUPPORT_TICKETS_READ,
  exposure: agentOnly,
  deferLoading: true,
  catalog: SUPPORT_AGENT_CATALOG.similar,
  outputSchema: z.strictObject({ schemaVersion: z.literal(1), result: similarOutput }),
  async execute(context, raw) {
    const { ticketId } = ticketInput.parse(raw);
    const items = await userScoped(context.scope, async (tx) => {
      if (!(await supportActive(tx, context.scope)))
        throw new DomainError("MODULE_DISABLED", 404);
      authorize(context.scope, SUPPORT_TICKETS_READ);
      await assertAgentTicket(tx, context.scope, ticketId);
      return similarTickets(tx, context.scope, ticketId);
    });
    return { output: { schemaVersion: 1, result: { items } }, cards: [] };
  },
});

/** The latest customer message of the ticket: the pipelines' idempotency per message. */
async function latestMessageId(tx: DbTx, scope: Scope, ticketId: string) {
  const latest = await tx.supportMessage.findFirst({
    where: { projectId: scope.projectId, ticketId, kind: "customer" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!latest) throw new DomainError("NOTHING_TO_ANSWER", 409);
  return latest.id;
}

/**
 * One of Support's paid pipelines as an agent tool. It runs inside the
 * agent's turn: its call reserves under the work order, counts toward the
 * agent's run and month ceilings and Support's daily cap, and is refused for
 * a provider not allowed for customer data. One call per work order, ticket
 * and customer message; a repeat is refused rather than paid again.
 */
function pipelineTool(task: "triage" | "draft") {
  const triage = task === "triage";
  return defineTool({
    name: triage ? "support_triage_suggest" : "support_draft_generate",
    namespace: "support",
    description: triage
      ? "Run Support's AI triage of the ticket once: suggests language, category, priority and sentiment (the category fills an empty field; nothing else changes) and stores the summary as an internal message. Paid within the agent's budget. Apply other fields with support_apply_triage."
      : "Run Support's grounded AI draft for the latest customer message once, with every check (citations, evidence, forbidden promises). Stores an internal draft a person reviews, or hands the ticket off. Never sends anything. Paid within the agent's budget.",
    parameters: ticketInput,
    risk: "W0_internal",
    // Stores suggestions only, like the automatic jobs: allowed in mode draft.
    agentMinMode: "draft",
    permission: triage ? SUPPORT_TICKETS_READ : SUPPORT_TICKETS_REPLY,
    exposure: agentOnly,
    deferLoading: true,
    catalog: triage ? SUPPORT_AGENT_CATALOG.triage : SUPPORT_AGENT_CATALOG.draft,
    outputSchema: z.strictObject({ schemaVersion: z.literal(1), result: z.record(z.string(), z.unknown()) }),
    async execute(context, raw) {
      const { ticketId } = ticketInput.parse(raw);
      const execution = currentAgentExecution();
      if (!execution) throw new DomainError("AGENT_PRINCIPAL_FORBIDDEN", 403);
      const messageId = await userScoped(context.scope, async (tx) => {
        if (!(await supportActive(tx, context.scope)))
          throw new DomainError("MODULE_DISABLED", 404);
        authorize(context.scope, triage ? SUPPORT_TICKETS_READ : SUPPORT_TICKETS_REPLY);
        await assertAgentTicket(tx, context.scope, ticketId);
        return latestMessageId(tx, context.scope, ticketId);
      });
      const result = await runSupportTask(context.scope, {
        task,
        ticketId,
        // With the work order in the reservation key (agent budget).
        attemptKey: `${execution.principal.workOrderId}:${messageId}`,
      });
      return { output: { schemaVersion: 1, result: result as Record<string, unknown> }, cards: [] };
    },
  });
}

const HAND_OFF_REASONS = [
  "needs_human",
  "low_confidence",
  "missing_source",
  "sensitive_topic",
  "customer_request",
  "possible_product_issue",
] as const;

const handOffTool = defineTool({
  name: "support_hand_off",
  namespace: "support",
  description:
    "Hand the ticket to the team: stops automatic AI work on it and notifies the agents. Give one reason from the list.",
  parameters: ticketInput.extend({ reason: z.enum(HAND_OFF_REASONS) }),
  risk: "W0_internal",
  permission: SUPPORT_TICKETS_READ,
  exposure: agentOnly,
  deferLoading: true,
  catalog: SUPPORT_AGENT_CATALOG.handOff,
  outputSchema: z.strictObject({ schemaVersion: z.literal(1), result: z.strictObject({ handedOff: z.boolean(), already: z.boolean() }) }),
  async execute(context, raw) {
    const { ticketId, reason } = ticketInput.extend({ reason: z.enum(HAND_OFF_REASONS) }).parse(raw);
    const handedOff = await userScoped(context.scope, async (tx) => {
      if (!(await supportActive(tx, context.scope)))
        throw new DomainError("MODULE_DISABLED", 404);
      authorize(context.scope, SUPPORT_TICKETS_READ);
      // Handing off only reduces automation: also on a sensitive ticket.
      await assertAgentTicket(tx, context.scope, ticketId, { allowSensitive: true });
      const ticket = await tx.supportTicket.findFirstOrThrow({
        where: { id: ticketId, projectId: context.scope.projectId },
      });
      return handOff(tx, context.scope, ticket, `agent:${reason}`);
    });
    return { output: { schemaVersion: 1, result: { handedOff: true, already: !handedOff } }, cards: [] };
  },
});

const triageFields = {
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
};

/** The fields a triage proposal changes, as they are now. */
async function triageBefore(tx: DbTx, scope: Scope, args: { ticketId: string }) {
  const ticket = await tx.supportTicket.findFirst({
    where: { id: args.ticketId, projectId: scope.projectId },
    select: { number: true, priority: true, category: true, tags: true },
  });
  if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
  return {
    ticketNumber: ticket.number,
    before: { priority: ticket.priority, category: ticket.category, tags: ticket.tags },
  };
}

/**
 * `support_apply_triage` (D-16, T2-2, T2-4, T2-5): priority, category and
 * tags only, never status or assignee. An owner or an editor who may assign
 * tickets decides; an agent mandate can cover it, but never a downgrade from
 * `urgent`. A human change to a proposed field meanwhile refuses it.
 */
export const supportApplyTriage = approvedOperation({
  riskClass: "W0",
  module: "support",
  sensitive: true,
  assistant: false,
  // Agents only: outside clients use support_update_ticket.
  proposable: () => false,
  name: "support_apply_triage",
  description:
    "Propose applying a triage to the ticket: priority, category and tags only (configured keys). Status and assignee are never changed by this.",
  permission: SUPPORT_TICKETS_ASSIGN,
  deciderRole: "editor",
  requires: [],
  agent: SUPPORT_AGENT_CATALOG.applyTriage,
  mandate: {
    maxCostMicrosPerAction: 0,
    check(args: { priority?: string }, _terms, context) {
      const before = (context as { before?: { priority?: string } } | undefined)?.before;
      if (!before) return ["PAYLOAD_NOT_COVERED"];
      return before.priority === "urgent" && args.priority && args.priority !== "urgent"
        ? ["PRIORITY_DOWNGRADE_NOT_COVERED"]
        : [];
    },
  },
  input: ticketInput.extend(triageFields),
  summary: (args, context) => ({
    operation: {
      kind: "support_apply_triage",
      ticketId: args.ticketId,
      after: {
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      },
      ...((context as { before?: unknown } | undefined)?.before
        ? { before: (context as { before: unknown }).before }
        : {}),
      ...((context as { ticketNumber?: number } | undefined)?.ticketNumber
        ? { ticketNumber: (context as { ticketNumber: number }).ticketNumber }
        : {}),
    },
  }),
  async validate(tx, scope, { ticketId, ...change }) {
    await assertAgentTicket(tx, scope, ticketId);
    if (change.priority === undefined && change.category === undefined && change.tags === undefined)
      throw new DomainError("SUPPORT_TRIAGE_EMPTY", 400);
    await validateTicketUpdate(tx, scope, ticketId, change);
  },
  approvalContext: triageBefore,
  async revalidateContext(tx, scope, args, saved) {
    const current = await triageBefore(tx, scope, args);
    if (!saved || hash(current) !== hash(saved))
      throw new DomainError("SUPPORT_TICKET_CHANGED", 409);
  },
  async run(tx, scope, { ticketId, ...change }, requester) {
    const row = await updateTicket(tx, scope, ticketId, change, supportActor(scope, requester as never));
    return {
      ticketId: row.id,
      priority: row.priority,
      category: row.category,
      tags: row.tags,
    };
  },
});

export const supportAgentTools = [
  similar,
  pipelineTool("triage"),
  pipelineTool("draft"),
  handOffTool,
  supportApplyTriage.tool,
];
export const supportAgentActions = {
  [supportApplyTriage.actionType]: supportApplyTriage.action,
};
