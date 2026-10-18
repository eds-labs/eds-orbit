import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import { defineTool } from "../agents/tools/registry.ts";
import { supportActive } from "./gate.ts";
import { SUPPORT_STATS_READ } from "./permissions.ts";
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
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
// The statuses that are not resolved or closed (OPEN_STATUSES in common.ts).
const OPEN = ["new", "open", "pending_customer", "pending_internal"] as const;
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

export const supportTools = [supportInsights];
