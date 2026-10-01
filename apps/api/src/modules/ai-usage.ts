import { z } from "zod";
import { Prisma, scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";

const PAGE_SIZE = 50;
const MAX_RANGE_MS = 93 * 24 * 3600 * 1000;
export const RUN_KINDS = [
  "chat",
  "generation",
  "retrieval",
  "ingestion",
  "reindex",
  "evaluation",
  "image",
] as const;
const GROUPS = ["day", "category", "model", "taskClass", "mission"] as const;
type Group = (typeof GROUPS)[number];

export const agentRunsQuery = z.object({
  cursor: z.uuid().optional(),
  kind: z.enum(RUN_KINDS).optional(),
});
export const aiCostQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  groupBy: z.enum(GROUPS).default("day"),
});

const big = (v: bigint | null | undefined) => v ?? 0n;

export async function listAgentRuns(
  scope: Scope,
  query: z.infer<typeof agentRunsQuery>,
) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const { projectId } = scope;
    let after: Prisma.AgentRunWhereInput = {};
    if (query.cursor) {
      const c = await tx.agentRun.findFirst({
        where: { id: query.cursor, projectId },
        select: { startedAt: true },
      });
      if (!c) throw new DomainError("INVALID_CURSOR", 400);
      after = {
        OR: [
          { startedAt: { lt: c.startedAt } },
          { startedAt: c.startedAt, id: { lt: query.cursor } },
        ],
      };
    }
    // One extra row tells whether another page exists.
    const rows = await tx.agentRun.findMany({
      where: {
        projectId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...after,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const spans = page.length
      ? await tx.agentSpan.groupBy({
          by: ["runId", "type"],
          where: { projectId, runId: { in: page.map((r) => r.id) } },
          _count: { _all: true },
          _sum: {
            inputTokens: true,
            cachedTokens: true,
            cacheWriteTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            costMicros: true,
          },
        })
      : [];
    const runs = page.map((r) => {
      const own = spans.filter((s) => s.runId === r.id);
      const sum = (k: keyof (typeof own)[number]["_sum"]) =>
        own.reduce((n, s) => n + Number(s._sum[k] ?? 0), 0);
      const count = (type: string) =>
        own.find((s) => s.type === type)?._count._all ?? 0;
      return {
        id: r.id,
        kind: r.kind,
        agentName: r.agentName,
        taskClass: r.taskClass,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        missionId: r.missionId,
        status: r.status,
        errorCode: r.errorCode,
        startedAt: r.startedAt.toISOString(),
        durationMs: r.durationMs,
        modelCalls: count("model_call"),
        toolCalls: count("tool_call"),
        inputTokens: sum("inputTokens"),
        cachedTokens: sum("cachedTokens"),
        cacheWriteTokens: sum("cacheWriteTokens"),
        outputTokens: sum("outputTokens"),
        reasoningTokens: sum("reasoningTokens"),
        costMicros: own
          .reduce((n, s) => n + big(s._sum.costMicros), 0n)
          .toString(),
      };
    });
    return {
      runs,
      nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1]!.id : null,
    };
  });
}

type Row = {
  key: string | null;
  state: string;
  amount: bigint | null;
  settled: bigint | null;
  count: number;
};

function resolveRange(query: z.infer<typeof aiCostQuery>) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  if (to <= from) throw new DomainError("INVALID_RANGE", 400);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS)
    throw new DomainError("RANGE_TOO_LARGE", 400);
  return { from, to };
}

export async function aiCostSummary(
  scope: Scope,
  query: z.infer<typeof aiCostQuery>,
) {
  const { from, to } = resolveRange(query);
  const groupBy: Group = query.groupBy;
  const rows = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const { workspaceId, projectId } = scope;
    if (groupBy === "day") {
      const raw = await tx.$queryRaw<
        {
          key: string;
          state: string;
          amount: bigint;
          settled: bigint;
          count: number;
        }[]
      >(Prisma.sql`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key,
               "state" AS state,
               SUM("amountMicros")::bigint AS amount,
               SUM(COALESCE("settledMicros", 0))::bigint AS settled,
               COUNT(*)::int AS count
        FROM "BudgetReservation"
        WHERE "workspaceId" = ${workspaceId}::uuid
          AND "projectId" = ${projectId}::uuid
          AND "state" <> 'released'
          AND "createdAt" >= ${from}
          AND "createdAt" <= ${to}
        GROUP BY 1, 2`);
      return raw as Row[];
    }
    const field = (
      {
        category: "category",
        model: "model",
        taskClass: "taskClass",
        mission: "missionId",
      } as const
    )[groupBy];
    const grouped = await tx.budgetReservation.groupBy({
      by: [field, "state"],
      where: {
        projectId,
        state: { not: "released" },
        createdAt: { gte: from, lte: to },
      },
      _sum: { amountMicros: true, settledMicros: true },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      key: (g as Record<string, unknown>)[field] as string | null,
      state: g.state,
      amount: g._sum.amountMicros,
      settled: g._sum.settledMicros,
      count: g._count._all,
    }));
  });
  const byKey = new Map<
    string | null,
    { reserved: bigint; settled: bigint; unknown: bigint; count: number }
  >();
  for (const r of rows) {
    const acc = byKey.get(r.key) ?? {
      reserved: 0n,
      settled: 0n,
      unknown: 0n,
      count: 0,
    };
    if (r.state === "settled") acc.settled += big(r.settled);
    else if (r.state === "unknown") acc.unknown += big(r.amount);
    else if (r.state === "reserved" || r.state === "in_flight")
      acc.reserved += big(r.amount);
    acc.count += r.count;
    byKey.set(r.key, acc);
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    groupBy,
    rows: [...byKey.entries()]
      .sort(([a], [b]) =>
        a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1,
      )
      .map(([key, v]) => ({
        key,
        reservedMicros: v.reserved.toString(),
        settledMicros: v.settled.toString(),
        unknownMicros: v.unknown.toString(),
        count: v.count,
      })),
  };
}
