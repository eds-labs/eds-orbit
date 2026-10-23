import { randomUUID } from "node:crypto";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit } from "../../shared.ts";
import type { SystemRole } from "./ledger/accounts.ts";

// The neutral starting chart of accounts and categories. It carries no
// accounting framework: codes and names are plain and can be renamed.

type AccountSpec = {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  role?: SystemRole;
  paymentAccount?: boolean;
};

const ACCOUNTS: AccountSpec[] = [
  { code: "1000", name: "Bank", type: "asset", paymentAccount: true },
  { code: "1100", name: "Card", type: "asset", paymentAccount: true },
  { code: "1200", name: "Wallet", type: "asset", paymentAccount: true },
  { code: "1400", name: "Receivables", type: "asset", role: "receivables" },
  { code: "1600", name: "Payables", type: "liability", role: "payables" },
  {
    code: "2000",
    name: "Owner contributions",
    type: "equity",
    role: "owner_contributions",
  },
  { code: "2100", name: "Owner draws", type: "equity", role: "owner_draws" },
  { code: "4000", name: "Revenue", type: "income" },
  { code: "6000", name: "Expenses", type: "expense" },
  {
    code: "6900",
    name: "FX gains and losses",
    type: "expense",
    role: "fx_gain_loss",
  },
  { code: "6990", name: "Rounding", type: "expense", role: "rounding" },
];

const CATEGORIES: { name: string; kind: "income" | "expense" }[] = [
  { name: "Revenue", kind: "income" },
  { name: "Software & SaaS", kind: "expense" },
  { name: "AI services", kind: "expense" },
  { name: "Hosting & infrastructure", kind: "expense" },
  { name: "Marketing", kind: "expense" },
  { name: "Services & contractors", kind: "expense" },
  { name: "Fees & banking", kind: "expense" },
  { name: "Office & other", kind: "expense" },
];

const POSTS_TO = { income: "4000", expense: "6000" } as const;

/**
 * Creates the missing accounts and categories; re-running adds nothing.
 * Accounts match by code, categories by name and kind (archived rows count,
 * so nothing is recreated behind an owner's back). A system role that
 * another live account already holds is left alone: the template account
 * is then created without it.
 */
export async function applyFinanceTemplate(
  tx: DbTx,
  scope: Scope,
): Promise<{ created: number }> {
  const base = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  let created = 0;

  const accounts = await tx.financeAccount.findMany({
    where: { projectId: scope.projectId },
    select: { id: true, code: true, role: true, archivedAt: true },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const takenRoles = new Set(
    accounts.filter((a) => a.role && !a.archivedAt).map((a) => a.role),
  );
  for (const spec of ACCOUNTS) {
    if (byCode.has(spec.code)) continue;
    const role = spec.role && !takenRoles.has(spec.role) ? spec.role : null;
    const id = randomUUID();
    await tx.financeAccount.create({
      data: {
        id,
        ...base,
        code: spec.code,
        name: spec.name,
        type: spec.type,
        role,
        paymentAccount: spec.paymentAccount ?? false,
      },
    });
    byCode.set(spec.code, id);
    if (role) takenRoles.add(role);
    created += 1;
  }

  const categories = await tx.financeCategory.findMany({
    where: { projectId: scope.projectId },
    select: { name: true, kind: true },
  });
  const known = new Set(categories.map((c) => `${c.kind}:${c.name}`));
  for (const spec of CATEGORIES) {
    if (known.has(`${spec.kind}:${spec.name}`)) continue;
    await tx.financeCategory.create({
      data: {
        id: randomUUID(),
        ...base,
        name: spec.name,
        kind: spec.kind,
        accountId: byCode.get(POSTS_TO[spec.kind])!,
      },
    });
    created += 1;
  }

  await audit(tx, scope, "finance.template.applied", scope.projectId, {
    created,
  });
  return { created };
}
