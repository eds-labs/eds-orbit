"use client";
import { useReducer } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, Button, Input } from "@/components/ui/primitives";
import type { Locale } from "@/lib/i18n";
import type {
  Account,
  Category,
  CostCenter,
  Counterparty,
  FinanceDocument,
  Invoice,
} from "./api";
import {
  AllocationEditor,
  allocationMessage,
  allocationOf,
  rowsOf,
  type Allocation,
  type AllocationRow,
} from "./allocation-editor";
import type { FinanceText } from "./labels";
import { CURRENCIES, formatMoney } from "./money";

// The booking form of the review detail (spec §9): prefilled from the
// stored extraction and its suggestions, edited by a person, and sent as
// the `book` body only when that person clicks Book. Amounts are decimal
// strings in the document currency, checked with string math against the
// currency's decimals; the server parses them again.

export type BookingKind = "invoice" | "receipt" | "credit_note";
export type Direction = "payable" | "receivable";

export type LineForm = {
  description: string;
  amount: string;
  tax: string;
  categoryId: string;
  allocation: AllocationRow[];
};

export type BookingFormState = {
  kind: BookingKind;
  direction: Direction;
  /** "" while no counterparty is chosen; NEW_COUNTERPARTY while creating one. */
  counterpartyId: string;
  newCounterpartyName: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  lines: LineForm[];
  paid: boolean;
  accountId: string;
  paidDate: string;
  rateOverride: string;
  paidRateOverride: string;
  creditsInvoiceId: string;
};

/** The booking body of POST documents/:id/book. */
export type Booking = {
  kind: BookingKind;
  direction: Direction;
  counterpartyId: string;
  number?: string;
  issueDate: string;
  dueDate?: string;
  currency: string;
  lines: Array<{
    description: string;
    amount: string;
    tax: string;
    categoryId: string;
    allocation: Allocation;
  }>;
  paid?: { accountId: string; date?: string; rateOverride?: string };
  rateOverride?: string;
  creditsInvoiceId?: string;
};

export const NEW_COUNTERPARTY = "__new";

const DECIMALS: Readonly<Record<string, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  USDC: 6,
};
const MICRO = 1_000_000n;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^\d{1,12}(?:\.\d{1,12})?$/;

/** The decimals a currency allows, or null for one finance does not know. */
export const currencyDecimals = (currency: string): number | null =>
  DECIMALS[currency] ?? null;

const GROUPED = (separator: "." | ",") =>
  new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`);
/** A comma before exactly three final digits: refused for USDC (see below). */
const AMBIGUOUS_COMMA = /^\d{1,3}(?:\.\d{3})*,\d{3}$/;

/**
 * Typed amount text as micros, or null when it is not a non-negative
 * amount with at most the currency's decimals. Reads separators like the
 * server's parseAmount: with both "." and "," the last one is the decimal
 * separator and the other must group thousands ("1,000.50", "1.000,50"); a
 * separator that repeats groups thousands ("1,234,567"); a single one is
 * the decimal separator ("12,5"). For currencies with more than two
 * decimals a comma before exactly three final digits ("1,000") is
 * ambiguous and refused.
 */
export function amountMicros(text: string, currency: string): bigint | null {
  const decimals = currencyDecimals(currency);
  if (decimals === null) return null;
  const body = text.trim();
  if (!/^[\d.,]+$/.test(body)) return null;
  if (decimals > 2 && AMBIGUOUS_COMMA.test(body)) return null;
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let whole = body;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const index = Math.max(lastDot, lastComma);
    const grouping = body[index] === "." ? "," : ".";
    const left = body.slice(0, index);
    fraction = body.slice(index + 1);
    if (!GROUPED(grouping).test(left) || !fraction) return null;
    whole = left.replaceAll(grouping, "");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? "." : ",";
    const index = Math.max(lastDot, lastComma);
    if (body.split(separator).length > 2) {
      if (!GROUPED(separator).test(body)) return null;
      whole = body.replaceAll(separator, "");
    } else {
      whole = body.slice(0, index);
      fraction = body.slice(index + 1);
      if (!fraction) return null;
    }
  }
  if (!/^\d{1,12}$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

/** Micros text ("12500000") as input text in the currency's decimals ("12.50"). */
export function microsToInput(micros: unknown, currency: string): string {
  if (typeof micros !== "string" || !/^-?\d+$/.test(micros)) return "";
  const value = BigInt(micros);
  const abs = value < 0n ? -value : value;
  const places = currencyDecimals(currency) ?? 6;
  let fraction = (abs % MICRO).toString().padStart(6, "0");
  // Keep what the currency allows; never drop a non-zero digit.
  while (fraction.length > places && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  return `${value < 0n ? "-" : ""}${abs / MICRO}${fraction ? `.${fraction}` : ""}`;
}

/** A positive decimal rate with up to 12 decimals. */
export const rateValid = (text: string) =>
  RATE.test(text.trim()) && /[1-9]/.test(text);

/** A real `YYYY-MM-DD` calendar date. */
function isDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

/** The stored draft as the form reads it (the extraction JSON, loosely). */
export type Draft = {
  docType?: string;
  direction?: string;
  counterpartyId?: string | null;
  counterparty?: { name?: string };
  number?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  totalMicros?: string | null;
  netMicros?: string | null;
  taxMicros?: string | null;
  paid?: boolean;
  lines?: Array<{
    description?: string;
    amountMicros?: string | null;
    taxMicros?: string | null;
    categoryId?: string | null;
    allocation?: unknown;
  }>;
  suggestion?: {
    counterpartyId?: string;
    categoryId?: string;
    allocation?: unknown;
    source?: "history" | "ai" | "none";
  };
  possibleDuplicateOfId?: string | null;
};

export const draftOf = (doc: Pick<FinanceDocument, "extraction">): Draft =>
  doc.extraction && typeof doc.extraction === "object"
    ? (doc.extraction as Draft)
    : {};

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The form as the stored draft and its suggestions prefill it. */
export function initialForm(doc: FinanceDocument): BookingFormState {
  const draft = draftOf(doc);
  const s = draft.suggestion ?? {};
  const kindOf = draft.docType ?? doc.docType;
  const kind: BookingKind =
    kindOf === "receipt" || kindOf === "credit_note" ? kindOf : "invoice";
  const currency = str(draft.currency).toUpperCase();
  const stored = draft.lines?.length
    ? draft.lines
    : [
        {
          description: "",
          amountMicros:
            draft.netMicros ??
            (draft.totalMicros && !draft.taxMicros ? draft.totalMicros : null),
          taxMicros: draft.taxMicros ?? null,
        },
      ];
  const issueDate = str(draft.issueDate);
  return {
    kind,
    direction: draft.direction === "receivable" ? "receivable" : "payable",
    counterpartyId: str(draft.counterpartyId) || str(s.counterpartyId),
    newCounterpartyName: str(draft.counterparty?.name),
    number: str(draft.number),
    issueDate,
    dueDate: str(draft.dueDate),
    currency,
    lines: stored.map((line) => ({
      description: str(line.description),
      amount: microsToInput(line.amountMicros, currency),
      tax: microsToInput(line.taxMicros, currency) || (currency ? "0" : ""),
      categoryId:
        str((line as { categoryId?: unknown }).categoryId) || str(s.categoryId),
      allocation: rowsOf(
        (line as { allocation?: unknown }).allocation ?? s.allocation,
      ),
    })),
    paid: kind === "receipt" || draft.paid === true,
    accountId: "",
    paidDate: issueDate,
    rateOverride: "",
    paidRateOverride: "",
    creditsInvoiceId: "",
  };
}

/** Σ(net + tax) of the lines in micros, or null while one is invalid. */
export function lineSumMicros(form: BookingFormState): bigint | null {
  let sum = 0n;
  for (const line of form.lines) {
    const amount = amountMicros(line.amount, form.currency);
    const tax = amountMicros(line.tax || "0", form.currency);
    if (amount === null || tax === null) return null;
    sum += amount + tax;
  }
  return sum;
}

/** Valid amount text as the plain decimal sent to the API ("1,000.50" → "1000.50"). */
const canonical = (text: string, currency: string) => {
  const micros = amountMicros(text, currency);
  return micros === null
    ? text.trim()
    : microsToInput(String(micros), currency);
};

/** The payment date that is sent: a receipt is paid on its issue date. */
export const paymentDate = (form: BookingFormState) =>
  form.kind === "receipt" ? form.issueDate : form.paidDate || form.issueDate;

/**
 * The booking the form describes, or the problems that block it (texts
 * from `t`). `fxMissing` adds the manual rate, which then is required.
 */
export function bookingOf(
  form: BookingFormState,
  t: FinanceText,
  options: { fxMissing: boolean },
): { booking: Booking | null; problems: string[] } {
  const r = t.review;
  const problems: string[] = [];
  const decimals = currencyDecimals(form.currency);
  if (!form.counterpartyId || form.counterpartyId === NEW_COUNTERPARTY)
    problems.push(r.counterpartyRequired);
  if (decimals === null) problems.push(r.currencyRequired);
  if (!isDate(form.issueDate)) problems.push(r.dateRequired);
  else if (form.dueDate && form.dueDate < form.issueDate)
    problems.push(r.dueBeforeIssue);
  const lines: Booking["lines"] = [];
  form.lines.forEach((line, i) => {
    const n = String(i + 1);
    if (!line.description.trim())
      problems.push(r.descriptionRequired.replace("{n}", n));
    if (
      decimals !== null &&
      (amountMicros(line.amount, form.currency) === null ||
        amountMicros(line.tax || "0", form.currency) === null)
    )
      problems.push(
        r.amountInvalid.replace("{n}", n).replace("{d}", String(decimals)),
      );
    if (!line.categoryId) problems.push(r.categoryRequired.replace("{n}", n));
    const split = allocationOf(line.allocation);
    if (split.problem)
      problems.push(
        `${r.line.replace("{n}", n)}: ${allocationMessage(t, split.problem)}`,
      );
    lines.push({
      description: line.description.trim(),
      amount: canonical(line.amount, form.currency),
      tax: canonical(line.tax || "0", form.currency),
      categoryId: line.categoryId,
      allocation: split.allocation ?? [],
    });
  });
  const paid = form.kind === "receipt" || form.paid;
  const date = paymentDate(form);
  const paidRate =
    paid && options.fxMissing && date !== form.issueDate
      ? form.paidRateOverride.trim()
      : "";
  if (paid && !form.accountId) problems.push(r.accountRequired);
  if (
    paid &&
    form.kind !== "receipt" &&
    form.paidDate &&
    !isDate(form.paidDate)
  )
    problems.push(r.dateRequired);
  if (options.fxMissing && !rateValid(form.rateOverride))
    problems.push(r.rateInvalid);
  if (paidRate && !rateValid(paidRate)) problems.push(r.rateInvalid);
  if (problems.length) return { booking: null, problems };
  const booking: Booking = {
    kind: form.kind,
    direction: form.direction,
    counterpartyId: form.counterpartyId,
    issueDate: form.issueDate,
    currency: form.currency,
    lines,
    ...(form.number.trim() ? { number: form.number.trim() } : {}),
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    ...(options.fxMissing ? { rateOverride: form.rateOverride.trim() } : {}),
    ...(form.kind === "credit_note" && form.creditsInvoiceId
      ? { creditsInvoiceId: form.creditsInvoiceId }
      : {}),
    ...(paid
      ? {
          paid: {
            accountId: form.accountId,
            date,
            ...(paidRate ? { rateOverride: paidRate } : {}),
          },
        }
      : {}),
  };
  return { booking, problems };
}

/** The PATCH body of "Save draft": what the form holds, invalid parts as null. */
export function draftPatchOf(form: BookingFormState): Record<string, unknown> {
  const amount = (text: string) =>
    text.trim() && amountMicros(text, form.currency) !== null
      ? canonical(text, form.currency)
      : null;
  return {
    docType: form.kind,
    direction: form.direction,
    counterpartyId:
      form.counterpartyId && form.counterpartyId !== NEW_COUNTERPARTY
        ? form.counterpartyId
        : null,
    number: form.number.trim() || null,
    issueDate: isDate(form.issueDate) ? form.issueDate : null,
    dueDate: isDate(form.dueDate) ? form.dueDate : null,
    currency: form.currency || null,
    lines: form.lines.map((line) => {
      const split = allocationOf(line.allocation).allocation;
      return {
        description: line.description.trim(),
        amount: amount(line.amount),
        tax: amount(line.tax),
        categoryId: line.categoryId || null,
        allocation: split && split.length ? split : null,
      };
    }),
  };
}

/** Open invoices a credit note of this form may credit. */
export function creditableInvoices(
  invoices: readonly Invoice[],
  form: BookingFormState,
) {
  return invoices.filter(
    (inv) =>
      inv.kind !== "credit_note" &&
      (inv.status === "open" || inv.status === "partially_paid") &&
      inv.counterpartyId === form.counterpartyId &&
      inv.direction === form.direction &&
      inv.currency === form.currency,
  );
}

/** A change of the form state; `bookingReducer` applies it. */
export type BookingAction =
  | { type: "set"; change: Partial<BookingFormState> }
  | { type: "line"; index: number; change: Partial<LineForm> }
  | { type: "addLine" }
  | { type: "removeLine"; index: number }
  | { type: "counterpartyCreated"; id: string };

/**
 * The form's state changes. A receipt is always paid; a counterparty
 * created inline is selected at once.
 */
export function bookingReducer(
  state: BookingFormState,
  action: BookingAction,
): BookingFormState {
  switch (action.type) {
    case "set": {
      const next = { ...state, ...action.change };
      return next.kind === "receipt" ? { ...next, paid: true } : next;
    }
    case "line":
      return {
        ...state,
        lines: state.lines.map((l, i) =>
          i === action.index ? { ...l, ...action.change } : l,
        ),
      };
    case "addLine":
      return { ...state, lines: [...state.lines, EMPTY_LINE] };
    case "removeLine":
      return {
        ...state,
        lines: state.lines.filter((_, i) => i !== action.index),
      };
    case "counterpartyCreated":
      return { ...state, counterpartyId: action.id };
  }
}

export type BookingLists = {
  counterparties: readonly Counterparty[];
  categories: readonly Category[];
  costCenters: readonly CostCenter[];
  accounts: readonly Account[];
  invoices: readonly Invoice[];
};

const EMPTY_LINE: LineForm = {
  description: "",
  amount: "",
  tax: "0",
  categoryId: "",
  allocation: [],
};

/**
 * The booking form. Read-only (no buttons) without `canWrite`; Book is
 * offered only for `needs_review` and stays disabled while a duplicate
 * question is open or a field is invalid. After FX_RATE_MISSING it asks
 * for the rate (base per 1 unit of the document currency) and books again.
 */
export function BookingForm({
  t,
  locale,
  doc,
  lists,
  currencies = CURRENCIES,
  baseCurrency,
  canWrite,
  pending,
  bookError,
  duplicateOpen,
  onBook,
  onSave,
  onCreateCounterparty,
}: {
  t: FinanceText;
  locale: Locale;
  doc: FinanceDocument;
  lists: BookingLists;
  currencies?: readonly string[];
  baseCurrency?: string;
  canWrite: boolean;
  pending: boolean;
  /** The error code of the last book attempt. */
  bookError: string | null;
  duplicateOpen: boolean;
  onBook: (booking: Booking) => void;
  onSave: (patch: Record<string, unknown>) => void;
  onCreateCounterparty: (name: string) => Promise<string | undefined>;
}) {
  const r = t.review;
  // Initialized once per document (the parent keys the form by doc.id), so
  // a refetch or a saved draft never resets what the person typed.
  const [form, dispatch] = useReducer(bookingReducer, doc, initialForm);
  const draft = draftOf(doc);
  const suggestion = draft.suggestion;
  const extractedName = draft.counterparty?.name;
  const editable =
    canWrite && (doc.status === "needs_review" || doc.status === "failed");
  const fxMissing = bookError === "FX_RATE_MISSING";
  const { booking, problems } = bookingOf(form, t, { fxMissing });
  const update = (change: Partial<BookingFormState>) =>
    dispatch({ type: "set", change });
  const setLine = (index: number, change: Partial<LineForm>) =>
    dispatch({ type: "line", index, change });
  const hint =
    suggestion?.source === "history"
      ? r.suggestedHistory
      : suggestion?.source === "ai"
        ? r.suggestedAi
        : null;
  const categoryKind = form.direction === "receivable" ? "income" : "expense";
  const categories = (current: string) =>
    lists.categories.filter(
      (c) => c.id === current || (!c.archivedAt && c.kind === categoryKind),
    );
  const accounts = lists.accounts.filter(
    (a) => a.paymentAccount && (!a.archivedAt || a.id === form.accountId),
  );
  const currencyOptions = [
    ...currencies,
    ...(form.currency && !currencies.includes(form.currency)
      ? [form.currency]
      : []),
  ];
  const sum = lineSumMicros(form);
  const total =
    typeof draft.totalMicros === "string" ? draft.totalMicros : null;
  const known = currencyDecimals(form.currency) !== null;
  const mismatch = sum !== null && total !== null && String(sum) !== total;
  const payDate = paymentDate(form);
  const paid = form.kind === "receipt" || form.paid;
  const creditable =
    form.kind === "credit_note" ? creditableInvoices(lists.invoices, form) : [];
  const fid = (name: string) => `finance-book-${doc.id}-${name}`;

  return (
    <form
      className="settings-form finance-booking"
      aria-label={r.form}
      // Enter in a field never books; only the Book button does.
      onSubmit={(e) => e.preventDefault()}
    >
      <fieldset disabled={!editable || pending}>
        <div className="finance-grid">
          <label>
            <span>{r.kind}</span>
            <select
              id={fid("kind")}
              className="input"
              value={form.kind}
              onChange={(e) => update({ kind: e.target.value as BookingKind })}
            >
              {(["invoice", "receipt", "credit_note"] as const).map((k) => (
                <option key={k} value={k}>
                  {r.kinds[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{r.direction}</span>
            <select
              id={fid("direction")}
              className="input"
              value={form.direction}
              onChange={(e) =>
                update({ direction: e.target.value as Direction })
              }
            >
              {(["payable", "receivable"] as const).map((d) => (
                <option key={d} value={d}>
                  {r.directions[d]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span>{r.counterparty}</span>
          <select
            id={fid("counterparty")}
            className="input"
            required
            value={form.counterpartyId}
            onChange={(e) => update({ counterpartyId: e.target.value })}
          >
            <option value="">{r.counterpartyChoose}</option>
            {lists.counterparties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW_COUNTERPARTY}>{r.counterpartyNew}</option>
          </select>
          {hint &&
            suggestion?.counterpartyId &&
            suggestion.counterpartyId === form.counterpartyId && (
              <small className="field-hint">{hint}</small>
            )}
          {extractedName && (
            <small className="field-hint">
              {r.extractedName.replace("{name}", () => extractedName)}
            </small>
          )}
        </label>
        {form.counterpartyId === NEW_COUNTERPARTY && (
          <div className="finance-inline">
            <label>
              <span>{r.counterpartyName}</span>
              <Input
                id={fid("counterparty-name")}
                value={form.newCounterpartyName}
                maxLength={200}
                onChange={(e) =>
                  update({ newCounterpartyName: e.target.value })
                }
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={!form.newCounterpartyName.trim()}
              onClick={async () => {
                const id = await onCreateCounterparty(
                  form.newCounterpartyName.trim(),
                );
                if (id) dispatch({ type: "counterpartyCreated", id });
              }}
            >
              {r.counterpartyCreate}
            </Button>
          </div>
        )}

        <div className="finance-grid">
          <label>
            <span>{r.number}</span>
            <Input
              id={fid("number")}
              value={form.number}
              maxLength={80}
              onChange={(e) => update({ number: e.target.value })}
            />
          </label>
          <label>
            <span>{r.currency}</span>
            <select
              id={fid("currency")}
              className="input"
              value={form.currency}
              onChange={(e) => update({ currency: e.target.value })}
            >
              <option value="">—</option>
              {currencyOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{r.issueDate}</span>
            <Input
              id={fid("issue")}
              type="date"
              required
              value={form.issueDate}
              onChange={(e) => update({ issueDate: e.target.value })}
            />
          </label>
          <label>
            <span>{r.dueDate}</span>
            <Input
              id={fid("due")}
              type="date"
              value={form.dueDate}
              onChange={(e) => update({ dueDate: e.target.value })}
            />
          </label>
        </div>

        {form.kind === "credit_note" && (
          <label>
            <span>{r.creditsInvoice}</span>
            <select
              id={fid("credits")}
              className="input"
              value={form.creditsInvoiceId}
              onChange={(e) => update({ creditsInvoiceId: e.target.value })}
            >
              <option value="">{r.creditsInvoiceNone}</option>
              {creditable.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.number ?? inv.issueDate} ·{" "}
                  {formatMoney(inv.totalMicros, inv.currency, locale)}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="finance-lines">
          <legend>{r.lines}</legend>
          {form.lines.map((line, index) => {
            const n = String(index + 1);
            return (
              <div
                key={index}
                className="finance-line"
                role="group"
                aria-label={r.line.replace("{n}", n)}
              >
                <label>
                  <span>{r.description}</span>
                  <Input
                    id={fid(`desc-${index}`)}
                    value={line.description}
                    maxLength={500}
                    onChange={(e) =>
                      setLine(index, { description: e.target.value })
                    }
                  />
                </label>
                <div className="finance-grid">
                  <label>
                    <span>{r.amount}</span>
                    <Input
                      id={fid(`amount-${index}`)}
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) =>
                        setLine(index, { amount: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>{r.tax}</span>
                    <Input
                      id={fid(`tax-${index}`)}
                      inputMode="decimal"
                      value={line.tax}
                      onChange={(e) => setLine(index, { tax: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>{r.category}</span>
                    <select
                      id={fid(`category-${index}`)}
                      className="input"
                      value={line.categoryId}
                      onChange={(e) =>
                        setLine(index, { categoryId: e.target.value })
                      }
                    >
                      <option value="">{r.categoryChoose}</option>
                      {categories(line.categoryId).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {hint &&
                      suggestion?.categoryId &&
                      suggestion.categoryId === line.categoryId && (
                        <small className="field-hint">{hint}</small>
                      )}
                  </label>
                </div>
                <AllocationEditor
                  t={t}
                  id={fid(`alloc-${index}`)}
                  rows={line.allocation}
                  costCenters={lists.costCenters}
                  disabled={!editable || pending}
                  onChange={(allocation) => setLine(index, { allocation })}
                />
                {editable && form.lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => dispatch({ type: "removeLine", index })}
                  >
                    <Trash2 aria-hidden size={14} />
                    {r.removeLine}
                  </Button>
                )}
              </div>
            );
          })}
          {editable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => dispatch({ type: "addLine" })}
            >
              <Plus aria-hidden size={14} />
              {r.addLine}
            </Button>
          )}
        </fieldset>

        <dl className="finance-sums">
          <div>
            <dt>{r.lineSum}</dt>
            <dd>
              {sum !== null && known
                ? formatMoney(String(sum), form.currency, locale)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{r.total}</dt>
            <dd>
              {total !== null && known
                ? formatMoney(total, form.currency, locale)
                : "—"}
            </dd>
          </div>
        </dl>
        {mismatch && <Alert kind="warning">{r.sumMismatch}</Alert>}

        {form.kind !== "receipt" && (
          <label className="settings-check">
            <input
              id={fid("paid")}
              type="checkbox"
              checked={form.paid}
              onChange={(e) => update({ paid: e.target.checked })}
            />
            {r.paid}
          </label>
        )}
        {paid && (
          <div className="finance-grid">
            <label>
              <span>{r.paymentAccount}</span>
              <select
                id={fid("account")}
                className="input"
                value={form.accountId}
                onChange={(e) => update({ accountId: e.target.value })}
              >
                <option value="">{r.paymentAccountChoose}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{r.paymentDate}</span>
              <Input
                id={fid("paid-date")}
                type="date"
                value={payDate}
                readOnly={form.kind === "receipt"}
                aria-describedby={
                  form.kind === "receipt" ? fid("paid-date-hint") : undefined
                }
                onChange={(e) => update({ paidDate: e.target.value })}
              />
              {form.kind === "receipt" && (
                <small className="field-hint" id={fid("paid-date-hint")}>
                  {r.paymentDateReceipt}
                </small>
              )}
            </label>
          </div>
        )}

        {fxMissing && (
          <div className="finance-rate" role="group" aria-label={r.rateTitle}>
            <Alert kind="warning">
              {r.rateTitle}.{" "}
              {r.rateHint
                .replace("{base}", () => baseCurrency ?? "—")
                .replace("{currency}", () => form.currency || "—")}
            </Alert>
            <label>
              <span>{r.rate}</span>
              <Input
                id={fid("rate")}
                inputMode="decimal"
                value={form.rateOverride}
                onChange={(e) => update({ rateOverride: e.target.value })}
              />
            </label>
            {paid && payDate !== form.issueDate && (
              <label>
                <span>{r.paymentRate}</span>
                <Input
                  id={fid("paid-rate")}
                  inputMode="decimal"
                  value={form.paidRateOverride}
                  onChange={(e) => update({ paidRateOverride: e.target.value })}
                />
              </label>
            )}
          </div>
        )}
      </fieldset>

      {editable && problems.length > 0 && (
        <ul className="finance-problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p} className="finance-problem">
              {p}
            </li>
          ))}
        </ul>
      )}
      {editable && duplicateOpen && (
        <p className="finance-problem">{r.bookBlockedDuplicate}</p>
      )}
      {editable && (
        <div className="settings-row-actions finance-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onSave(draftPatchOf(form))}
          >
            {r.save}
          </Button>
          {doc.status === "needs_review" && (
            <Button
              type="button"
              disabled={pending || duplicateOpen || booking === null}
              onClick={() => {
                if (booking && !duplicateOpen) onBook(booking);
              }}
            >
              {r.book}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
