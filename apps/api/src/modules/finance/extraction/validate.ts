import { normalizeCounterpartyName } from "../counterparties.ts";
import { CURRENCY_DECIMALS, isCurrency, parseAmount } from "../money.ts";
import type { FinanceSettings } from "../settings.ts";
import { EXTRACTION_SCHEMA_VERSION, type Extraction } from "./schema.ts";

// Deterministic checks on what the model returned. Nothing here trusts the
// model: amounts go through parseAmount, dates must be real calendar dates,
// and every inconsistency becomes a fixed flag code for the review form.

export type NormalizedLine = {
  description: string;
  quantity: string | null;
  amountMicros: bigint | null;
  taxMicros: bigint | null;
  categoryHint: string | null;
  costCenterHint: string | null;
};

export type Normalized = {
  schemaVersion: typeof EXTRACTION_SCHEMA_VERSION;
  docType: "invoice" | "receipt" | "credit_note" | "other";
  direction: "payable" | "receivable" | "unknown";
  counterparty: {
    name: string;
    normalizedName: string;
    taxId: string | null;
    email: string | null;
  };
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  netMicros: bigint | null;
  taxMicros: bigint | null;
  totalMicros: bigint | null;
  paid: boolean;
  paymentMethod: string | null;
  lines: NormalizedLine[];
  confidence: number;
  /** Flags found while normalizing (amount_invalid, sign_inferred, date_invalid). */
  flags: string[];
};

type Settings = Pick<
  FinanceSettings,
  "currencies" | "reviewConfidence" | "duplicateWindowDays"
>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The date when `value` is a real `YYYY-MM-DD` calendar date. */
function calendarDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

const clean = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const abs = (value: bigint | null) =>
  value !== null && value < 0n ? -value : value;

/**
 * Converts the model's answer into checked values: amounts to bigint micros
 * (an amount parseAmount refuses is dropped with `amount_invalid`), the
 * currency uppercased, dates validated (`date_invalid`). Credit notes carry
 * positive amounts; a negative invoice total is read as a credit note
 * (`sign_inferred`), never as a negative invoice.
 */
export function normalizeExtraction(
  raw: Extraction,
  _settings: Settings,
): Normalized {
  const flags = new Set<string>();
  const currency = clean(raw.currency)?.toUpperCase() ?? null;
  const known = currency !== null && isCurrency(currency);
  const money = (value: string | null | undefined): bigint | null => {
    const textValue = clean(value);
    if (textValue === null || !known) return null;
    try {
      return parseAmount(textValue, currency);
    } catch {
      flags.add("amount_invalid");
      return null;
    }
  };
  const date = (value: string | null) => {
    const textValue = clean(value);
    if (textValue === null) return null;
    if (!calendarDate(textValue)) {
      flags.add("date_invalid");
      return null;
    }
    return textValue;
  };

  let netMicros = money(raw.net);
  let taxMicros = money(raw.tax);
  let totalMicros = money(raw.total);
  let lines: NormalizedLine[] = raw.lines.map((line) => ({
    description: line.description.trim(),
    quantity: clean(line.quantity),
    amountMicros: money(line.amount),
    taxMicros: money(line.tax),
    categoryHint: clean(line.categoryHint),
    costCenterHint: clean(line.costCenterHint),
  }));

  let docType = raw.docType;
  if (docType !== "credit_note" && totalMicros !== null && totalMicros < 0n) {
    docType = "credit_note";
    flags.add("sign_inferred");
  }
  if (docType === "credit_note") {
    netMicros = abs(netMicros);
    taxMicros = abs(taxMicros);
    totalMicros = abs(totalMicros);
    lines = lines.map((line) => ({
      ...line,
      amountMicros: abs(line.amountMicros),
      taxMicros: abs(line.taxMicros),
    }));
  }

  const name = raw.counterparty.name.trim();
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    docType,
    direction: raw.direction,
    counterparty: {
      name,
      normalizedName: normalizeCounterpartyName(name),
      taxId: clean(raw.counterparty.taxId),
      email: clean(raw.counterparty.email)?.toLowerCase() ?? null,
    },
    number: clean(raw.number),
    issueDate: date(raw.issueDate),
    dueDate: date(raw.dueDate),
    currency,
    netMicros,
    taxMicros,
    totalMicros,
    paid: raw.paid,
    paymentMethod: clean(raw.paymentMethod),
    lines,
    confidence: raw.confidence,
    flags: [...flags],
  };
}

/**
 * Consistency flags of a normalized extraction: `total_mismatch` (the lines,
 * with or without the document's tax, or net plus tax differ from the total
 * by more than one minor unit), `unknown_currency` (missing, unknown or not
 * one of the project's currencies), `date_invalid` (issue date more than a
 * day in the future, or due before issue), `missing_total` and
 * `low_confidence` (below `reviewConfidence`).
 */
export function validateExtraction(
  n: Normalized,
  settings: Settings,
  now = new Date(),
): string[] {
  const flags: string[] = [];
  const currencyKnown =
    n.currency !== null &&
    isCurrency(n.currency) &&
    (settings.currencies as string[]).includes(n.currency);

  if (n.totalMicros !== null && n.currency !== null && isCurrency(n.currency)) {
    const unit = 10n ** BigInt(6 - CURRENCY_DECIMALS[n.currency]);
    const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= unit;
    const total = n.totalMicros;
    let mismatch = false;
    if (n.netMicros !== null && n.taxMicros !== null)
      mismatch ||= !near(n.netMicros + n.taxMicros, total);
    const amounts = n.lines.map((l) => l.amountMicros);
    if (amounts.length && amounts.every((a) => a !== null)) {
      const sum = (amounts as bigint[]).reduce((s, a) => s + a, 0n);
      // Lines may be gross, or net with the tax stated once for the document.
      const lineTax = n.lines.every((l) => l.taxMicros !== null)
        ? n.lines.reduce((s, l) => s + l.taxMicros!, 0n)
        : null;
      const candidates = [sum];
      if (n.taxMicros !== null) candidates.push(sum + n.taxMicros);
      if (lineTax !== null) candidates.push(sum + lineTax);
      mismatch ||= !candidates.some((c) => near(c, total));
    }
    if (mismatch) flags.push("total_mismatch");
  }
  if (!currencyKnown) flags.push("unknown_currency");

  const issue = n.issueDate ? calendarDate(n.issueDate) : null;
  const due = n.dueDate ? calendarDate(n.dueDate) : null;
  if (
    !n.flags.includes("date_invalid") &&
    ((issue && issue.valueOf() > now.valueOf() + DAY_MS) ||
      (issue && due && due < issue))
  )
    flags.push("date_invalid");
  if (n.totalMicros === null) flags.push("missing_total");
  if (n.confidence < settings.reviewConfidence) flags.push("low_confidence");
  return flags;
}
