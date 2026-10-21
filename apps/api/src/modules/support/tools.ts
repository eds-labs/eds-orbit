import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import { defineTool } from "../agents/tools/registry.ts";
import { userScoped } from "../../platform/tenancy/scope.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { DomainError } from "../../shared.ts";
import {
  customerContextView,
  readTicketCustomerContext,
} from "./customer-context.ts";
import { supportActive } from "./gate.ts";
import {
  SUPPORT_CUSTOMER_CONTEXT_READ,
  SUPPORT_STATS_READ,
} from "./permissions.ts";
import { ticketSummary } from "./workspace.ts";

// Support tools for the Orbit Assistant (WP5.6) and, since Track M WP-M3, MCP
// clients. Counts only: no ticket subject, text or contact reaches the
// assistant's model or an outside client (Q-12a); agents read tickets in the
// workspace.
//
// Double-parse review (MCP): the SDK parses a call's arguments, then the
// adapter parses them again with `parameters` before `execute`. The tool takes
// none, so there is no transform or non-idempotent default for the second
// parse to change.

const count = z.number().int().nonnegative();
// Literal copies for the strict output schema (zod enums need literal
// tuples). support-insights-lists.test.ts keeps them equal to their sources:
// SUPPORT_PRIORITIES (settings.ts) and OPEN_STATUSES (common.ts), the
// statuses that are not resolved or closed.
export const SUPPORT_INSIGHTS_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
export const SUPPORT_INSIGHTS_OPEN_STATUSES = [
  "new",
  "open",
  "pending_customer",
  "pending_internal",
] as const;
const PRIORITIES = SUPPORT_INSIGHTS_PRIORITIES;
const OPEN = SUPPORT_INSIGHTS_OPEN_STATUSES;
// A category key as the settings and tickets store it; "none" counts the
// tickets without one. At most 50 configured keys plus "none" (settings), with
// a margin for keys removed from the settings later.
const CATEGORY_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_CATEGORIES = 100;

const counted = z
  .object({
    available: z.literal(true),
    open: count,
    unassigned: count,
    atRisk: count,
    breached: count,
    // Open tickets only: the tool counts every status except resolved/closed.
    byStatus: z.partialRecord(z.enum(OPEN), count),
    byPriority: z.partialRecord(z.enum(PRIORITIES), count),
    byCategory: z
      .record(z.string().regex(CATEGORY_KEY), count)
      .refine((v) => Object.keys(v).length <= MAX_CATEGORIES),
  })
  .strict();

/**
 * What an MCP client receives: `{ available: false }` or the counts. MCP wants
 * one object schema, so the counts are optional keys here; the refinement
 * allows them only together, and only with `available: true`.
 */
export const supportInsightsOutput = z
  .object({
    available: z.boolean(),
    open: counted.shape.open.optional(),
    unassigned: counted.shape.unassigned.optional(),
    atRisk: counted.shape.atRisk.optional(),
    breached: counted.shape.breached.optional(),
    byStatus: counted.shape.byStatus.optional(),
    byPriority: counted.shape.byPriority.optional(),
    byCategory: counted.shape.byCategory.optional(),
  })
  .strict()
  .refine((v) =>
    v.available ? counted.safeParse(v).success : Object.keys(v).length === 1,
  );

export const supportInsights = defineTool({
  name: "support_insights",
  namespace: "support",
  description:
    "Support ticket counts: open, unassigned, at risk and overdue, plus open tickets by status, priority and category. No ticket content.",
  parameters: z.object({}).strict(),
  exposure: { assistant: true, mcp: true },
  outputSchema: supportInsightsOutput,
  risk: "R0_read",
  permission: SUPPORT_STATS_READ,
  deferLoading: true,
  async execute(context) {
    const { scope } = context;
    const output = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        if (!(await supportActive(tx, scope))) return { available: false };
        const open = {
          projectId: scope.projectId,
          mergedIntoTicketId: null,
          status: { notIn: ["resolved", "closed"] },
        };
        const [summary, byStatus, byPriority, byCategory] = await Promise.all([
          ticketSummary(tx, scope),
          tx.supportTicket.groupBy({
            by: ["status"],
            where: open,
            _count: true,
          }),
          tx.supportTicket.groupBy({
            by: ["priority"],
            where: open,
            _count: true,
          }),
          tx.supportTicket.groupBy({
            by: ["category"],
            where: open,
            _count: true,
          }),
        ]);
        const counts = (rows: Array<Record<string, any>>, key: string) =>
          Object.fromEntries(
            rows.map((r) => [String(r[key] ?? "none"), r._count]),
          );
        // Only the four counts: the summary's per-inbox map (for the web
        // overview) stays out of the tool's strict output.
        return {
          available: true,
          open: summary.open,
          unassigned: summary.unassigned,
          atRisk: summary.atRisk,
          breached: summary.breached,
          byStatus: counts(byStatus, "status"),
          byPriority: counts(byPriority, "priority"),
          byCategory: counts(byCategory, "category"),
        };
      },
    );
    return { output, cards: [] };
  },
});

/**
 * The live account of a ticket's verified customer (ADR 0011), for the
 * Orbit Assistant and MCP clients with the support scope. The same read as
 * the ticket view: verified widget identities only, no product user id in
 * the output. Not a transaction-bound operation: the provider call must not
 * hold the project lock.
 */
export const supportCustomerContext = defineTool({
  name: "support_customer_context",
  namespace: "support",
  description:
    "Live subscription, feature and usage-limit status of a support ticket's verified customer, read from the customer's product. Use it for questions about the plan, a feature being enabled or not, and credits or limits and their reset date. A null value means unknown, never zero. If the status is not ok, say the account cannot be checked right now and never guess a cause.",
  parameters: z.object({ ticketId: z.string() }).strict(),
  exposure: { assistant: true, mcp: true },
  outputSchema: z
    .object({ schemaVersion: z.literal(1), result: z.unknown() })
    .strict(),
  risk: "R0_read",
  permission: SUPPORT_CUSTOMER_CONTEXT_READ,
  deferLoading: true,
  feature: "mcp_tasks",
  openWorld: true,
  mcpScopes: ["orbit:support"],
  async execute(context, raw) {
    const { ticketId } = z.object({ ticketId: z.uuid() }).parse(raw);
    await userScoped(context.scope, async (tx) => {
      if (!(await supportActive(tx, context.scope)))
        throw new DomainError("MODULE_DISABLED", 404);
      authorize(context.scope, SUPPORT_CUSTOMER_CONTEXT_READ);
    });
    const read = await readTicketCustomerContext(
      context.scope,
      ticketId,
      "tool",
    );
    return {
      output: { schemaVersion: 1, result: customerContextView(read) },
      cards: [],
    };
  },
});

export const supportTools = [supportInsights, supportCustomerContext];
