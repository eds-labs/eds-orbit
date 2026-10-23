import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { Normalized } from "../extraction/validate.ts";

// Semantic duplicates (spec §6), after the exact SHA-256 check of intake:
// the same counterparty and invoice number is a duplicate; the same
// counterparty, total and currency within `duplicateWindowDays` where a
// number is missing is only a possible duplicate, for a person to decide.
// The counterparty is the matched one, or the normalized name while the
// document has none. Rejected and duplicate documents never count.

/** The keys an extraction stores so that later documents can find it. */
export type DedupeKeys = {
  counterpartyId: string | null;
  normalizedName: string;
  numberKey: string | null;
};

export const numberKey = (number: string | null) =>
  number ? number.trim().toLowerCase() : null;

export function dedupeKeys(
  n: Normalized,
  counterpartyId: string | null,
): DedupeKeys {
  return {
    counterpartyId,
    normalizedName: n.counterparty.normalizedName,
    numberKey: numberKey(n.number),
  };
}

const DAY_MS = 86_400_000;
const LIVE = { notIn: ["rejected", "duplicate"] };

type Stored = {
  dedupe?: DedupeKeys;
  currency?: string | null;
  totalMicros?: string | null;
  issueDate?: string | null;
};

export async function duplicateCheck(
  tx: DbTx,
  scope: Scope,
  docId: string,
  n: Normalized,
  options: { counterpartyId: string | null; windowDays: number },
): Promise<{ duplicateOfId?: string; possible?: string }> {
  const keys = dedupeKeys(n, options.counterpartyId);
  if (!keys.counterpartyId && !keys.normalizedName) return {};
  const sameParty = (stored: DedupeKeys | undefined) =>
    Boolean(stored) &&
    ((keys.counterpartyId !== null &&
      stored!.counterpartyId === keys.counterpartyId) ||
      (keys.normalizedName !== "" &&
        stored!.normalizedName === keys.normalizedName));

  if (keys.numberKey) {
    const documents = await tx.financeDocument.findMany({
      where: {
        projectId: scope.projectId,
        id: { not: docId },
        status: LIVE,
        extraction: { path: ["dedupe", "numberKey"], equals: keys.numberKey },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, extraction: true },
    });
    const document = documents.find((d) =>
      sameParty((d.extraction as Stored | null)?.dedupe),
    );
    if (document) return { duplicateOfId: document.id };
    // A booked invoice carries the number as a person confirmed it.
    if (keys.counterpartyId) {
      const invoice = await tx.financeInvoice.findFirst({
        where: {
          projectId: scope.projectId,
          counterpartyId: keys.counterpartyId,
          number: { equals: n.number!.trim(), mode: "insensitive" },
          status: { not: "void" },
          documentId: { not: null },
          NOT: { documentId: docId },
        },
        orderBy: { createdAt: "asc" },
        select: { documentId: true },
      });
      if (invoice?.documentId) return { duplicateOfId: invoice.documentId };
    }
  }

  if (n.totalMicros === null || !n.currency || !n.issueDate) return {};
  const issue = Date.parse(`${n.issueDate}T00:00:00Z`);
  const window = options.windowDays * DAY_MS;
  const near = (date: string | Date | null | undefined) => {
    if (!date) return false;
    const at =
      typeof date === "string"
        ? Date.parse(`${date}T00:00:00Z`)
        : date.valueOf();
    return Math.abs(at - issue) <= window;
  };
  const total = n.totalMicros.toString();
  const documents = await tx.financeDocument.findMany({
    where: {
      projectId: scope.projectId,
      id: { not: docId },
      status: LIVE,
      extraction: { path: ["totalMicros"], equals: total },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, extraction: true },
  });
  const possible = documents.find((d) => {
    const stored = d.extraction as Stored | null;
    return (
      stored?.currency === n.currency &&
      sameParty(stored.dedupe) &&
      // Two different numbers are two invoices.
      (!keys.numberKey || !stored.dedupe?.numberKey) &&
      near(stored.issueDate)
    );
  });
  if (possible) return { possible: possible.id };
  if (keys.counterpartyId) {
    const invoices = await tx.financeInvoice.findMany({
      where: {
        projectId: scope.projectId,
        counterpartyId: keys.counterpartyId,
        currency: n.currency,
        totalMicros: n.totalMicros,
        status: { not: "void" },
        documentId: { not: null },
        NOT: { documentId: docId },
      },
      orderBy: { createdAt: "asc" },
      select: { documentId: true, number: true, issueDate: true },
    });
    const invoice = invoices.find(
      (i) => (!keys.numberKey || !i.number) && near(i.issueDate),
    );
    if (invoice?.documentId) return { possible: invoice.documentId };
  }
  return {};
}
