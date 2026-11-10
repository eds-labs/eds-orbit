import {
  authDb,
  scoped,
  type DbTx,
  type Prisma,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { aiCostSummary } from "../ai/ai-usage.ts";
import {
  activeSpendPolicyRecord,
  derivedLimits,
  requireSpendMandate,
} from "../ai/spend-mandate.ts";
import { reservationMonth } from "../attention/platform-items.ts";
import { personalAssistantEnabled } from "../assistant/personal-space.ts";
import {
  aiOrgBudgetEnabled,
  budgetLevel,
  monthOf,
  ORG_PROVIDERS,
  organizationAiBudgetInput,
  organizationBudget,
  organizationSpend,
} from "../ai/org-budget.ts";
import { providerCapProposal } from "../ai/org-budget-seed.ts";
import { systemAudit } from "./audit.ts";

// "Budget" and "Verbrauch" of an organization's AI area (plans/
// ai-central-management.md, phase C; decision D-6: organization owners).
// The budget is control plane; the usage is read project by project inside
// each project's own transaction, so row-level security stays as it is.

/** off: saved but not applied; not_set: no limit; active: applied now. */
export type LimitState = "off" | "not_set" | "active";
type Origin = { by: { id: string; name: string } | null; at: string } | null;

/**
 * The spending authority of one business project as the organization page
 * shows it (plan 2026-11-10 WP2 B): read inside the project's own scoped
 * transaction, so row-level security stays as it is; limits, this month's
 * spend and who activated it. Nothing is written.
 */
async function projectLimit(tx: DbTx, scope: Scope, now: Date) {
  const record = await activeSpendPolicyRecord(tx, scope);
  let mandate: Awaited<ReturnType<typeof requireSpendMandate>> | null = null;
  let problem: string | null = null;
  try {
    mandate = await requireSpendMandate(tx, scope);
  } catch (error) {
    const code = (error as { code?: string }).code;
    problem = code === "POLICY_REQUIRED" ? null : (code ?? "POLICY_INVALID");
  }
  const limits = mandate?.limits ?? null;
  const state: LimitState | "expired" | "invalid" = problem
    ? "invalid"
    : !limits
      ? "not_set"
      : !limits.approvedPaidTests || !limits.monthlyBudgetMicros
        ? "off"
        : now < new Date(limits.startAt) || now >= new Date(limits.endAt)
          ? "expired"
          : "active";
  const stored = record ? (record.data as Record<string, unknown>) : null;
  return {
    state,
    source: mandate?.source ?? ("none" as const),
    monthlyBudgetMicros: limits?.monthlyBudgetMicros ?? null,
    dailyBudgetMicros: limits?.dailyBudgetMicros ?? null,
    perRunBudgetMicros: limits?.perRunBudgetMicros ?? null,
    endAt: limits?.endAt ?? null,
    spentMicros: (await reservationMonth(tx, scope, now)).spentMicros,
    activatedBy:
      mandate?.source === "platform" && typeof stored?.activatedBy === "string"
        ? stored.activatedBy
        : null,
    activatedAt:
      mandate?.source === "platform" && typeof stored?.activatedAt === "string"
        ? stored.activatedAt
        : record?.createdAt.toISOString() ?? null,
  };
}

/**
 * The organization's three budget levels (WP2 B): its monthly limit, the
 * personal assistant's cap per member with the members' usage as one sum
 * (ADR 0022: never per user), and each business project's own spending
 * authority. Owners only (the route checks); reads only.
 */
async function budgetLevels(
  workspaceId: string,
  actorId: string,
  budget: Awaited<ReturnType<typeof organizationBudget>>,
  spentMicros: number,
  now: Date,
) {
  const projects = await authDb.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, kind: true },
    orderBy: { createdAt: "asc" },
  });
  const usage = { spentMicros: 0, unknownMicros: 0, count: 0, spaces: 0 };
  const perProject = [];
  for (const project of projects) {
    const scope = {
      workspaceId,
      projectId: project.id,
      userId: actorId,
      role: "owner",
    } as Scope;
    if (project.kind === "personal") {
      const month = await scoped(workspaceId, project.id, (tx) =>
        reservationMonth(tx, scope, now),
      );
      usage.spentMicros += month.spentMicros;
      usage.unknownMicros += month.unknown?.micros ?? 0;
      usage.spaces += 1;
      continue;
    }
    perProject.push({
      projectId: project.id,
      name: project.name,
      ...(await scoped(workspaceId, project.id, (tx) => projectLimit(tx, scope, now))),
    });
  }
  const userIds = [
    ...new Set(
      [budget?.updatedBy, ...perProject.map((p) => p.activatedBy)].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  ];
  const names = new Map(
    (userIds.length
      ? await authDb.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : []
    ).map((u) => [u.id, u.name]),
  );
  const origin = (by: string | null | undefined, at: Date | string | null | undefined): Origin =>
    at
      ? {
          by: by ? { id: by, name: names.get(by) ?? "—" } : null,
          at: typeof at === "string" ? at : at.toISOString(),
        }
      : null;
  const cap = budget?.assistantPerUserMonthlyMicros ?? null;
  const budgetOrigin = budget ? origin(budget.updatedBy, budget.updatedAt) : null;
  const organizationState: LimitState =
    budget?.monthlyMicros == null
      ? "not_set"
      : aiOrgBudgetEnabled()
        ? "active"
        : "off";
  const assistantState: LimitState =
    cap === null ? "not_set" : cap > 0 ? "active" : "off";
  const derived = cap === null ? null : derivedLimits(cap);
  return {
    organization: {
      state: organizationState,
      monthlyMicros: budget?.monthlyMicros ?? null,
      spentMicros,
      origin: budgetOrigin,
    },
    // Applies whether ORBIT_AI_ORG_BUDGET is on or not: it is the personal
    // spaces' spending authority (spend-mandate.ts personalSpendRecord).
    assistant: {
      available: personalAssistantEnabled(),
      state: assistantState,
      capMicros: cap,
      // What `reserve` derives (D-4): a tenth a day, a run at most a day's
      // share and never more than USD 2.
      perDayMicros: derived?.dailyBudgetMicros ?? null,
      perAnswerMicros: derived?.perRunBudgetMicros ?? null,
      usage,
      origin: budgetOrigin,
    },
    projects: perProject.map(({ activatedBy, activatedAt, ...p }) => ({
      ...p,
      origin: origin(activatedBy, activatedAt),
    })),
  };
}

/**
 * The organization's budget with this month's spend and levels, and the
 * caps its projects' own provider budgets add up to, for the owner to
 * confirm (D-5). `actorId` is the owner reading it (the project reads
 * run in each project's scope as that user; nothing is written).
 */
export async function organizationAiBudgetView(
  workspaceId: string,
  actorId: string,
  now = new Date(),
) {
  const month = monthOf(now);
  const budget = await organizationBudget(authDb, workspaceId);
  const spend = await organizationSpend(authDb, workspaceId, month);
  return {
    enabled: aiOrgBudgetEnabled(),
    periodStart: month.toISOString(),
    budget: budget
      ? {
          monthlyMicros: budget.monthlyMicros,
          assistantPerUserMonthlyMicros: budget.assistantPerUserMonthlyMicros,
          providerCaps: budget.providerCaps,
          credits: budget.credits,
          version: budget.version,
          updatedAt: budget.updatedAt,
        }
      : null,
    levels: await budgetLevels(workspaceId, actorId, budget, spend.total.spentMicros, now),
    spend: {
      ...spend.total,
      level: budgetLevel(spend.total.spentMicros, budget?.monthlyMicros),
    },
    providers: Object.fromEntries(
      ORG_PROVIDERS.map((p) => [
        p,
        {
          ...spend[p],
          capMicros: budget?.providerCaps[p] ?? null,
          level: budgetLevel(spend[p].spentMicros, budget?.providerCaps[p]),
        },
      ]),
    ),
    proposal: await providerCapProposal(workspaceId),
  };
}

/** Saves the organization's budget (a full replace) and audits it. */
export async function saveOrganizationAiBudget(
  actorId: string,
  workspaceId: string,
  raw: unknown,
) {
  const input = organizationAiBudgetInput.parse(raw);
  await authDb.$transaction(async (tx) => {
    const current = await tx.organizationAiBudget.findFirst({ where: { workspaceId } });
    const fields = {
      monthlyMicros: input.monthlyMicros === null ? null : BigInt(input.monthlyMicros),
      ...(input.assistantPerUserMonthlyMicros === undefined
        ? {}
        : {
            assistantPerUserMonthlyMicros:
              input.assistantPerUserMonthlyMicros === null
                ? null
                : BigInt(input.assistantPerUserMonthlyMicros),
          }),
      providerCaps: input.providerCaps as Prisma.InputJsonValue,
      credits: input.credits as Prisma.InputJsonValue,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    const saved = current
      ? await tx.organizationAiBudget.update({
          where: { id: current.id },
          data: { ...fields, version: { increment: 1 } },
        })
      : await tx.organizationAiBudget.create({ data: { workspaceId, ...fields } });
    await systemAudit(
      {
        actorId,
        action: "ai_budget.updated",
        targetType: "ai_budget",
        targetId: saved.id,
        workspaceId,
        metadata: {
          version: saved.version,
          monthlyMicros: input.monthlyMicros,
          ...(input.assistantPerUserMonthlyMicros === undefined
            ? {}
            : { assistantPerUserMonthlyMicros: input.assistantPerUserMonthlyMicros }),
          providers: Object.keys(input.providerCaps),
        },
      },
      tx,
    );
  });
  return organizationAiBudgetView(workspaceId, actorId);
}

type CostRow = {
  key: string | null;
  reservedMicros: string;
  settledMicros: string;
  unknownMicros: string;
  count: number;
};
const total = (row: CostRow) =>
  Number(row.reservedMicros) + Number(row.settledMicros) + Number(row.unknownMicros);

/** Adds rows of the same key: the organization's view across projects. */
function merge(target: Map<string, { spentMicros: number; unknownMicros: number; count: number }>, rows: CostRow[]) {
  for (const row of rows) {
    const key = row.key ?? "—";
    const acc = target.get(key) ?? { spentMicros: 0, unknownMicros: 0, count: 0 };
    acc.spentMicros += total(row);
    acc.unknownMicros += Number(row.unknownMicros);
    acc.count += row.count;
    target.set(key, acc);
  }
}
const sorted = (map: Map<string, { spentMicros: number; unknownMicros: number; count: number }>) =>
  [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.spentMicros - a.spentMicros);

/**
 * The organization's AI spend of the current UTC month, per project,
 * provider, model and task, with unclear outcomes per project (settled in
 * the project's own AI settings after checking the provider's billing).
 */
export async function organizationAiUsage(workspaceId: string, now = new Date()) {
  const projects = await authDb.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, kind: true },
    orderBy: { createdAt: "asc" },
  });
  // Personal spaces count towards every total but are shown as one sum,
  // never per user (ADR 0022).
  const assistants = { spentMicros: 0, unknownMicros: 0, count: 0, spaces: 0 };
  const byProvider = new Map<string, { spentMicros: number; unknownMicros: number; count: number }>();
  const byModel = new Map<string, { spentMicros: number; unknownMicros: number; count: number }>();
  const byTask = new Map<string, { spentMicros: number; unknownMicros: number; count: number }>();
  const perProject = [];
  for (const project of projects) {
    const scope = { workspaceId, projectId: project.id } as Scope;
    const query = (groupBy: "provider" | "model" | "taskClass") =>
      aiCostSummary(scope, { groupBy, to: now.toISOString() }).then((r) => r.rows);
    const [providers, models, tasks] = await Promise.all([
      query("provider"),
      query("model"),
      query("taskClass"),
    ]);
    merge(byProvider, providers);
    merge(byModel, models);
    merge(byTask, tasks);
    const usage = {
      spentMicros: providers.reduce((n, r) => n + total(r), 0),
      unknownMicros: providers.reduce((n, r) => n + Number(r.unknownMicros), 0),
      count: providers.reduce((n, r) => n + r.count, 0),
    };
    if (project.kind === "personal") {
      assistants.spentMicros += usage.spentMicros;
      assistants.unknownMicros += usage.unknownMicros;
      assistants.count += usage.count;
      assistants.spaces += 1;
      continue;
    }
    perProject.push({ projectId: project.id, name: project.name, ...usage });
  }
  return {
    periodStart: monthOf(now).toISOString(),
    projects: perProject.sort((a, b) => b.spentMicros - a.spentMicros),
    assistants,
    providers: sorted(byProvider),
    models: sorted(byModel),
    tasks: sorted(byTask),
  };
}
