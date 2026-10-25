import { authDb, type Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { aiCostSummary } from "../ai/ai-usage.ts";
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

/**
 * The organization's budget with this month's spend and levels, and the
 * caps its projects' own provider budgets add up to, for the owner to
 * confirm (D-5).
 */
export async function organizationAiBudgetView(workspaceId: string, now = new Date()) {
  const month = monthOf(now);
  const budget = await organizationBudget(authDb, workspaceId);
  const spend = await organizationSpend(authDb, workspaceId, month);
  return {
    enabled: aiOrgBudgetEnabled(),
    periodStart: month.toISOString(),
    budget: budget
      ? {
          monthlyMicros: budget.monthlyMicros,
          providerCaps: budget.providerCaps,
          credits: budget.credits,
          version: budget.version,
          updatedAt: budget.updatedAt,
        }
      : null,
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
          providers: Object.keys(input.providerCaps),
        },
      },
      tx,
    );
  });
  return organizationAiBudgetView(workspaceId);
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
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
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
    perProject.push({
      projectId: project.id,
      name: project.name,
      spentMicros: providers.reduce((n, r) => n + total(r), 0),
      unknownMicros: providers.reduce((n, r) => n + Number(r.unknownMicros), 0),
      count: providers.reduce((n, r) => n + r.count, 0),
    });
  }
  return {
    periodStart: monthOf(now).toISOString(),
    projects: perProject.sort((a, b) => b.spentMicros - a.spentMicros),
    providers: sorted(byProvider),
    models: sorted(byModel),
    tasks: sorted(byTask),
  };
}
