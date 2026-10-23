import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { allocationSchema } from "../common.ts";
import type { Normalized } from "./validate.ts";

// Booking suggestions for the review form. Confirmed history wins over the
// model: the counterparty's last booked invoice (its first line's category
// and allocation) or the counterparty's defaults, then the model's hint.
// No counterparty is created here; the review form gets the name instead.

export type Allocation = { costCenterId: string; bp: number }[];

export type Suggestion = {
  counterpartyId?: string;
  categoryId?: string;
  allocation?: Allocation;
  recurringId?: string;
  source: "history" | "ai" | "none";
};

/** Opaque prompt keys ("c1", "k1") mapped back to database ids. */
export type HintKeys = {
  categories: Map<string, { id: string; kind: string }>;
  costCenters: Map<string, string>;
};

const taxKey = (value: string) => value.replace(/[\s.\-/]/g, "").toUpperCase();

/** The domain of an e-mail address, lowercase, or null. */
const emailDomain = (email: string | null) => {
  const at = email?.lastIndexOf("@") ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
};

/**
 * The project's counterparty for the extracted party: an equal tax id, an
 * equal normalized name, or an e-mail domain the counterparty lists, in
 * that order. Null when none matches.
 */
export async function matchCounterparty(tx: DbTx, scope: Scope, n: Normalized) {
  const { taxId, normalizedName, email } = n.counterparty;
  if (taxId) {
    const key = taxKey(taxId);
    const withTax = await tx.financeCounterparty.findMany({
      where: { projectId: scope.projectId, taxId: { not: null } },
      select: { id: true, taxId: true },
    });
    const hit = withTax.find((c) => taxKey(c.taxId!) === key);
    if (hit) return hit.id;
  }
  if (normalizedName) {
    const byName = await tx.financeCounterparty.findFirst({
      where: { projectId: scope.projectId, normalizedName },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (byName) return byName.id;
  }
  const domain = emailDomain(email);
  if (domain) {
    const byDomain = await tx.financeCounterparty.findFirst({
      where: { projectId: scope.projectId, emailDomains: { has: domain } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (byDomain) return byDomain.id;
  }
  return null;
}

const allocationOf = (value: unknown): Allocation | undefined => {
  const parsed = allocationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** An active recurring cost of the counterparty the total fits, if any. */
async function matchRecurring(
  tx: DbTx,
  scope: Scope,
  counterpartyId: string,
  n: Normalized,
) {
  if (n.totalMicros === null || !n.currency) return undefined;
  const total = n.totalMicros;
  const candidates = await tx.financeRecurring.findMany({
    where: {
      projectId: scope.projectId,
      counterpartyId,
      currency: n.currency,
      active: true,
    },
    orderBy: { nextDueDate: "asc" },
  });
  return candidates.find((r) => {
    const bp = BigInt(
      (r.match as { toleranceBp?: number } | null)?.toleranceBp ?? 0,
    );
    const diff =
      total > r.expectedAmountMicros
        ? total - r.expectedAmountMicros
        : r.expectedAmountMicros - total;
    return diff * 10_000n <= r.expectedAmountMicros * bp;
  })?.id;
}

/**
 * The suggested counterparty, category, allocation and recurring cost for
 * a normalized extraction (spec §6). `keys` maps the model's hints back;
 * a hint that is unknown, or a category of the wrong kind for the
 * document's direction, is ignored.
 */
export async function suggestBooking(
  tx: DbTx,
  scope: Scope,
  n: Normalized,
  keys: HintKeys = { categories: new Map(), costCenters: new Map() },
): Promise<Suggestion> {
  const counterpartyId = (await matchCounterparty(tx, scope, n)) ?? undefined;
  const base = counterpartyId
    ? {
        counterpartyId,
        recurringId: await matchRecurring(tx, scope, counterpartyId, n),
      }
    : {};
  const clean = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined),
    ) as T;

  if (counterpartyId) {
    const last = await tx.financeInvoice.findFirst({
      where: {
        projectId: scope.projectId,
        counterpartyId,
        status: { not: "void" },
      },
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    const line = last
      ? await tx.financeInvoiceLine.findFirst({
          where: { projectId: scope.projectId, invoiceId: last.id },
          orderBy: { position: "asc" },
          select: { categoryId: true, allocation: true },
        })
      : null;
    if (line?.categoryId)
      return clean({
        ...base,
        categoryId: line.categoryId,
        allocation: allocationOf(line.allocation),
        source: "history" as const,
      });
    const counterparty = await tx.financeCounterparty.findFirst({
      where: { projectId: scope.projectId, id: counterpartyId },
      select: { defaultCategoryId: true, defaultAllocation: true },
    });
    if (counterparty?.defaultCategoryId)
      return clean({
        ...base,
        categoryId: counterparty.defaultCategoryId,
        allocation: allocationOf(counterparty.defaultAllocation),
        source: "history" as const,
      });
  }

  const wanted =
    n.direction === "payable"
      ? "expense"
      : n.direction === "receivable"
        ? "income"
        : null;
  const category = n.lines
    .map((l) =>
      l.categoryHint ? keys.categories.get(l.categoryHint) : undefined,
    )
    .find((c) => c && (!wanted || c.kind === wanted));
  const costCenterId = n.lines
    .map((l) =>
      l.costCenterHint ? keys.costCenters.get(l.costCenterHint) : undefined,
    )
    .find(Boolean);
  if (category)
    return clean({
      ...base,
      categoryId: category.id,
      allocation: costCenterId ? [{ costCenterId, bp: 10_000 }] : undefined,
      source: "ai" as const,
    });
  return clean({ ...base, source: "none" as const });
}
