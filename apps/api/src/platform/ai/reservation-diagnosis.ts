import { z } from "zod";
import {
  Prisma,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { providerOfModel } from "../../../../../packages/ai/src/index.ts";
import { DomainError } from "../shared.ts";
import { budgetMonthStart } from "./budget.ts";
import { runtimeProviderBudgets } from "./openai-configuration.ts";

// The cost diagnosis of a project's AI reservations (plan 2026-11-10, WP2
// C): every reservation of every month with what it was for, its run and a
// status derived at read time, so an owner can tell a call that is still
// running from one that was lost and one whose outcome is unclear. Read
// only: nothing here settles, releases or sweeps a reservation; unknown
// outcomes are settled only by the owner's explicit action
// (`settle-unknown-reservations`). No prompt, key or provider response id
// leaves this module; `providerConfirmed` is a boolean.

/**
 * The longest job lease of any queue class (JobDef.leaseMs): agent work
 * orders, 6 minutes (platform/agents/work-orders/execute.ts). A test pins
 * that no registered job class leases longer.
 */
export const LARGEST_LEASE_MS = 360_000;
/**
 * How long a lost job can wait for the worker's recovery after its lease
 * ran out: the dispatcher revisits every project at least every 5 minutes
 * (worker/main.ts MAX_IDLE_MS); recovery then marks a sent call unknown.
 */
export const RECOVERY_INTERVAL_MS = 300_000;
/** Margin for clock skew and API-side calls (the longest, knowledge analysis, has 4 minutes). */
export const STALE_GRACE_MS = 240_000;
/**
 * A reservation still `reserved` or `in_flight` after this long (15
 * minutes) can no longer belong to a live call: its run would have ended,
 * or the worker's recovery would have marked it unknown. It is shown as
 * stale; nothing moves it (the plan's follow-up sweeps them).
 */
export const STALE_AFTER_MS =
  LARGEST_LEASE_MS + RECOVERY_INTERVAL_MS + STALE_GRACE_MS;

export type ReservationStatus =
  | "reserved"
  | "in_flight"
  | "stale"
  | "settled"
  | "unknown"
  | "released";
export type NextAction =
  /** A live call: its run settles or releases it. */
  | "wait"
  /** Lost or inconsistent: check the run; it still counts at the reserved amount. */
  | "check_run"
  /** Check the provider's billing, then settle it with a reason (owner). */
  | "check_billing_then_settle"
  | "none";

const PAGE_SIZE = 50;

export const reservationsQuery = z.object({
  cursor: z.uuid().optional(),
  /** open: reserved, in flight or unknown; unknown: only unclear outcomes. */
  state: z.enum(["all", "open", "unknown"]).default("all"),
});

// Which module a reservation belongs to, from its category, task class or
// run kind (the platform names the categories its callers book under).
const MODULE_BY_CATEGORY: Record<string, string> = {
  support_text: "support",
  finance_document: "finance",
  work_pm: "work",
  issues_ai: "issues",
  knowledge_analysis: "knowledge",
  knowledge_evaluation: "knowledge",
  reindex: "knowledge",
  reindex_evaluation: "knowledge",
  embedding: "knowledge",
  query_embedding: "knowledge",
  chat_text: "assistant",
  assistant_briefing: "assistant",
  agent_work: "agents",
  text: "marketing",
  agent_text: "marketing",
  image_generation: "marketing",
};
const MODULE_BY_RUN_KIND: Record<string, string> = {
  support: "support",
  chat: "assistant",
  agent: "agents",
  retrieval: "knowledge",
  ingestion: "knowledge",
  reindex: "knowledge",
  evaluation: "knowledge",
  generation: "marketing",
  image: "marketing",
  mcp: "assistant",
};

/** The module of a reservation; "platform" when nothing names one. */
export function reservationModule(row: {
  category: string;
  taskClass: string | null;
  runKind?: string | null;
}) {
  const task = row.taskClass ?? "";
  return (
    MODULE_BY_CATEGORY[row.category] ??
    (task.startsWith("support_")
      ? "support"
      : task.startsWith("finance_")
        ? "finance"
        : task.startsWith("pm_")
          ? "work"
          : task.startsWith("issue_")
            ? "issues"
            : task.startsWith("knowledge_")
              ? "knowledge"
              : task === "chat_operator"
                ? "assistant"
                : task === "agent_custom"
                  ? "agents"
                  : task.startsWith("draft_") ||
                      task.startsWith("agent_") ||
                      task === "creative_review"
                    ? "marketing"
                    : undefined) ??
    (row.runKind ? MODULE_BY_RUN_KIND[row.runKind] : undefined) ??
    "platform"
  );
}

/**
 * The status shown for a reservation: its stored state, except that a
 * `reserved` or `in_flight` row is stale once its run ended or it is older
 * than STALE_AFTER_MS.
 */
export function reservationStatus(
  row: { state: string; createdAt: Date },
  run: { status: string } | null,
  now: Date,
): ReservationStatus {
  if (row.state === "reserved" || row.state === "in_flight") {
    const ended = Boolean(run && run.status !== "running");
    const old = now.getTime() - row.createdAt.getTime() > STALE_AFTER_MS;
    return ended || old ? "stale" : row.state;
  }
  if (row.state === "settled" || row.state === "unknown" || row.state === "released")
    return row.state;
  return "unknown";
}

export function nextActionOf(status: ReservationStatus): NextAction {
  if (status === "reserved" || status === "in_flight") return "wait";
  if (status === "stale") return "check_run";
  if (status === "unknown") return "check_billing_then_settle";
  return "none";
}

/**
 * This month's reservations split as the operations band shows them:
 * settled, live in flight, stale and unclear, as `reserve` counts them
 * (settled at the settled amount, the rest at the reserved amount; released
 * rows do not count). One grouped query on the createdAt index.
 */
export async function reservationBreakdown(tx: DbTx, scope: Scope, now = new Date()) {
  const month = budgetMonthStart(now);
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = await tx.$queryRaw<
    { state: string; stale: boolean; amount: bigint; settled: bigint; count: number }[]
  >(Prisma.sql`
    SELECT r."state" AS state,
           (r."state" IN ('reserved','in_flight')
             AND (r."createdAt" < ${cutoff}
                  OR (a."status" IS NOT NULL AND a."status" <> 'running'))) AS stale,
           COALESCE(SUM(r."amountMicros"), 0)::bigint AS amount,
           COALESCE(SUM(r."settledMicros"), 0)::bigint AS settled,
           COUNT(*)::int AS count
    FROM "BudgetReservation" r
    LEFT JOIN "AgentRun" a
      ON a."workspaceId" = r."workspaceId" AND a."projectId" = r."projectId"
     AND a."id" = r."agentRunId"
    WHERE r."workspaceId" = ${scope.workspaceId}::uuid
      AND r."projectId" = ${scope.projectId}::uuid
      AND r."createdAt" >= ${month}
      AND r."state" <> 'released'
    GROUP BY 1, 2`);
  const sum = { settled: 0, inFlight: 0, stale: 0, unknown: 0 };
  const count = { settled: 0, inFlight: 0, stale: 0, unknown: 0 };
  for (const row of rows) {
    const key =
      row.state === "settled"
        ? "settled"
        : row.state === "unknown"
          ? "unknown"
          : row.stale
            ? "stale"
            : "inFlight";
    sum[key] += Number(key === "settled" ? row.settled : row.amount);
    count[key] += row.count;
  }
  return {
    periodStart: month.toISOString(),
    settledMicros: sum.settled,
    inFlightMicros: sum.inFlight,
    staleMicros: sum.stale,
    unknownMicros: sum.unknown,
    /** Everything open this month: in flight, stale and unclear. */
    reservedMicros: sum.inFlight + sum.stale + sum.unknown,
    counts: count,
  };
}

/**
 * One page of the project's reservations of all months, newest first, with
 * the derived status, the run they belong to and what to do next. The
 * first page carries this month's breakdown and the unclear outcomes of
 * every month.
 */
export async function listReservations(
  scope: Scope,
  query: z.infer<typeof reservationsQuery>,
  now = new Date(),
) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const { workspaceId, projectId } = scope;
    let after: Prisma.BudgetReservationWhereInput = {};
    if (query.cursor) {
      const c = await tx.budgetReservation.findFirst({
        where: { id: query.cursor, workspaceId, projectId },
        select: { createdAt: true },
      });
      if (!c) throw new DomainError("INVALID_CURSOR", 400);
      after = {
        OR: [
          { createdAt: { lt: c.createdAt } },
          { createdAt: c.createdAt, id: { lt: query.cursor } },
        ],
      };
    }
    const states =
      query.state === "open"
        ? ["reserved", "in_flight", "unknown"]
        : query.state === "unknown"
          ? ["unknown"]
          : null;
    const rows = await tx.budgetReservation.findMany({
      where: {
        workspaceId,
        projectId,
        ...(states ? { state: { in: states } } : {}),
        ...after,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        createdAt: true,
        state: true,
        amountMicros: true,
        settledMicros: true,
        category: true,
        taskClass: true,
        model: true,
        agentRunId: true,
      },
    });
    const page = rows.slice(0, PAGE_SIZE);
    const runIds = [
      ...new Set(page.map((r) => r.agentRunId).filter((id): id is string => Boolean(id))),
    ];
    const runs = runIds.length
      ? await tx.agentRun.findMany({
          where: { workspaceId, projectId, id: { in: runIds } },
          select: { id: true, kind: true, status: true, errorCode: true },
        })
      : [];
    // Spans are read by run (indexed); only whether a provider answered
    // for the reservation leaves here, never the response id itself.
    const confirmed = new Set(
      runIds.length
        ? (
            await tx.agentSpan.findMany({
              where: {
                workspaceId,
                projectId,
                runId: { in: runIds },
                budgetReservationId: { in: page.map((r) => r.id) },
                providerResponseId: { not: null },
              },
              select: { budgetReservationId: true },
            })
          ).map((s) => s.budgetReservationId)
        : [],
    );
    const registry = page.some((r) => r.model)
      ? (await runtimeProviderBudgets(tx, scope)).models
      : undefined;
    const items = page.map((r) => {
      const run = runs.find((x) => x.id === r.agentRunId) ?? null;
      const status = reservationStatus(r, run, now);
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        module: reservationModule({ ...r, runKind: run?.kind ?? null }),
        category: r.category,
        taskClass: r.taskClass,
        provider: r.model ? providerOfModel(r.model, registry) : null,
        model: r.model,
        run: run
          ? { id: run.id, kind: run.kind, status: run.status, errorCode: run.errorCode }
          : null,
        reservedMicros: r.amountMicros.toString(),
        settledMicros: r.settledMicros === null ? null : r.settledMicros.toString(),
        status,
        providerConfirmed: confirmed.has(r.id),
        nextAction: nextActionOf(status),
      };
    });
    const summary = query.cursor
      ? null
      : {
          month: await reservationBreakdown(tx, scope, now),
          unknownAllMonths: await tx.budgetReservation
            .aggregate({
              where: { workspaceId, projectId, state: "unknown" },
              _sum: { amountMicros: true },
              _count: { _all: true },
            })
            .then((a) => ({
              micros: Number(a._sum.amountMicros ?? 0),
              count: a._count._all,
            })),
        };
    return {
      items,
      nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1]!.id : null,
      staleAfterMs: STALE_AFTER_MS,
      summary,
    };
  });
}
