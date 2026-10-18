import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import { defineTool } from "../agents/tools/registry.ts";
import { supportActive } from "./gate.ts";
import { SUPPORT_STATS_READ } from "./permissions.ts";
import { ticketSummary } from "./workspace.ts";

// Support tools for the Orbit Assistant (WP5.6). Counts only: no ticket
// subject, text or contact reaches the assistant's model (Q-12a); agents
// read tickets in the workspace.

export const supportInsights = defineTool({
  name: "support_insights",
  namespace: "support",
  description:
    "Support ticket counts: open, unassigned, at risk and overdue, plus open tickets by status, priority and category. No ticket content.",
  parameters: z.object({}).strict(),
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
        return {
          available: true,
          ...summary,
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
