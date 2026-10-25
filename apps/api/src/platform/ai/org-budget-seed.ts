import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  providerBudgetsSchema,
  providerOfModel,
  type ProviderBudget,
} from "../../../../../packages/ai/src/index.ts";
import { data } from "../shared.ts";
import { runtimeProviderBudgets } from "./openai-configuration.ts";
import { monthOf, ORG_PROVIDERS, type OrgProvider } from "./org-budget.ts";

// Phase C helpers that read project data project by project, inside each
// project's own transaction:
// - the seed adds this month's reservations made before ORBIT_AI_ORG_BUDGET
//   was on to the organization counters, once (it marks each reservation);
// - the proposal sums the projects' provider stops into organization caps
//   (decision D-5: the owner confirms them in the organization's budget).

export type SeedRow = {
  workspaceId: string;
  projectId: string;
  name: string;
  reservations: number;
  reservedMicros: number;
  settledMicros: number;
};

/**
 * Adds every reservation of the current UTC month that is not on the
 * organization counters yet (`orgProvider` null) to them, project by
 * project; dry run without `apply`. Safe to run again: counted rows are
 * marked. Run it right after turning the switch on, at a quiet moment: a
 * reservation settled while its project is seeded may stay on "reserved".
 */
export async function seedOrganizationCounters(
  options: { workspaceId?: string; apply?: boolean; now?: Date } = {},
): Promise<SeedRow[]> {
  const month = monthOf(options.now ?? new Date());
  const projects = await authDb.project.findMany({
    where: options.workspaceId ? { workspaceId: options.workspaceId } : {},
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const rows: SeedRow[] = [];
  for (const project of projects) {
    rows.push(
      await scoped(project.workspaceId, project.id, async (tx) => {
        const scope = { workspaceId: project.workspaceId, projectId: project.id } as Scope;
        const registry = (await runtimeProviderBudgets(tx, scope)).models;
        const open = await tx.budgetReservation.findMany({
          where: {
            projectId: project.id,
            createdAt: { gte: month },
            state: { not: "released" },
            orgProvider: null,
          },
        });
        const row: SeedRow = {
          workspaceId: project.workspaceId,
          projectId: project.id,
          name: project.name,
          reservations: 0,
          reservedMicros: 0,
          settledMicros: 0,
        };
        for (const r of open) {
          const provider: OrgProvider | "none" = r.model
            ? providerOfModel(r.model, registry)
            : "none";
          const settled = r.state === "settled";
          const micros = settled ? (r.settledMicros ?? 0n) : r.amountMicros;
          row.reservations++;
          if (settled) row.settledMicros += Number(micros);
          else row.reservedMicros += Number(micros);
          if (!options.apply) continue;
          // Marked first, so a second run or a concurrent seed skips it.
          const marked = await tx.budgetReservation.updateMany({
            where: { id: r.id, orgProvider: null },
            data: { orgProvider: provider },
          });
          if (marked.count !== 1) continue;
          for (const key of ["total", ...(provider === "none" ? [] : [provider])]) {
            await tx.$executeRaw`INSERT INTO "OrganizationSpendCounter" ("workspaceId","scopeKey","periodStart")
              VALUES (${project.workspaceId}::uuid, ${key}, ${month})
              ON CONFLICT ("workspaceId","scopeKey","periodStart") DO NOTHING`;
            if (settled)
              await tx.$executeRaw`UPDATE "OrganizationSpendCounter" SET "settledMicros" = "settledMicros" + ${micros}
                WHERE "workspaceId" = ${project.workspaceId}::uuid AND "scopeKey" = ${key} AND "periodStart" = ${month}`;
            else
              await tx.$executeRaw`UPDATE "OrganizationSpendCounter" SET "reservedMicros" = "reservedMicros" + ${micros}
                WHERE "workspaceId" = ${project.workspaceId}::uuid AND "scopeKey" = ${key} AND "periodStart" = ${month}`;
          }
        }
        return row;
      }),
    );
  }
  return rows;
}

/**
 * The organization caps the projects' own provider budgets add up to (D-5):
 * per provider the sum of their stops, and the newest credit an owner
 * entered, with the projects it comes from.
 */
export async function providerCapProposal(workspaceId: string) {
  const projects = await authDb.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const caps: Partial<Record<OrgProvider, number>> = {};
  const credits: Partial<Record<OrgProvider, NonNullable<ProviderBudget["credit"]>>> = {};
  const sources: { projectId: string; name: string; provider: OrgProvider; stopMicros: number }[] = [];
  for (const project of projects) {
    const budgets = await scoped(workspaceId, project.id, async (tx) => {
      const row = await tx.entity.findFirst({
        where: { workspaceId, projectId: project.id, kind: "openai_configuration" },
        select: { data: true },
      });
      const parsed = providerBudgetsSchema.safeParse(
        row ? (data(row) as { providerBudgets?: unknown }).providerBudgets ?? {} : {},
      );
      return parsed.success ? parsed.data : {};
    });
    for (const provider of ORG_PROVIDERS) {
      const budget = budgets[provider];
      if (!budget) continue;
      caps[provider] = (caps[provider] ?? 0) + budget.stopMicros;
      sources.push({
        projectId: project.id,
        name: project.name,
        provider,
        stopMicros: budget.stopMicros,
      });
      const credit = budget.credit;
      const known = credits[provider];
      if (credit && (!known || known.verifiedAt < credit.verifiedAt))
        credits[provider] = credit;
    }
  }
  return { providerCaps: caps, credits, sources };
}
