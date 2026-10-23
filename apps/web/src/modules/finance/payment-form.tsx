"use client";
import { useRef, useState } from "react";
import { Alert, Button, Input } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { financeApi, type Account, type Invoice } from "./api";
import {
  amountMicros,
  currencyDecimals,
  isDate,
  microsToInput,
  rateText,
  rateValid,
} from "./amount";
import type { FinanceText } from "./labels";
import { errorCode, errorText } from "./lists";
import { formatMoney } from "./money";

// Record payment (spec §7): one payment allocated across one or more open
// invoices of the same counterparty. The allocations default to the open
// amounts and must add up to the payment amount; until they do, submitting
// is blocked. After FX_RATE_MISSING a manual rate is asked for. The server
// derives which open-item account the payment settles and checks it again.

export type PaymentRow = { invoiceId: string; allocation: string };
export type PaymentForm = {
  accountId: string;
  date: string;
  amount: string;
  reference: string;
  rateOverride: string;
  rows: PaymentRow[];
};

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

const openOf = (invoice: Pick<Invoice, "openAmountMicros">): bigint =>
  invoice.openAmountMicros && /^\d+$/.test(invoice.openAmountMicros)
    ? BigInt(invoice.openAmountMicros)
    : 0n;

/**
 * The direction that settles an invoice, like the server: money leaves for
 * a payable invoice and arrives for a receivable one; a credit note inverts
 * it, so the only payment it takes is a refund.
 */
export const settlingDirection = (
  invoice: Pick<Invoice, "kind" | "direction">,
): "outgoing" | "incoming" =>
  (invoice.direction === "payable") !== (invoice.kind === "credit_note")
    ? "outgoing"
    : "incoming";

/** Invoices a payment can still settle: not void or paid, with something open. */
export const payable = (invoice: Invoice) =>
  (invoice.status === "open" || invoice.status === "partially_paid") &&
  openOf(invoice) > 0n;

/** True when one payment can settle all of them. */
export function sameSettlement(invoices: readonly Invoice[]): boolean {
  const first = invoices[0];
  return (
    !!first &&
    invoices.every(
      (i) =>
        i.counterpartyId === first.counterpartyId &&
        i.direction === first.direction &&
        i.currency === first.currency &&
        settlingDirection(i) === settlingDirection(first),
    )
  );
}

/** Every allocation at its open amount; the payment amount is their sum. */
export function initialPayment(
  invoices: readonly Invoice[],
  today: string,
): PaymentForm {
  const currency = invoices[0]?.currency ?? "";
  const total = invoices.reduce((sum, i) => sum + openOf(i), 0n);
  return {
    accountId: "",
    date: today,
    amount: microsToInput(String(total), currency),
    reference: "",
    rateOverride: "",
    rows: invoices.map((i) => ({
      invoiceId: i.id,
      allocation: microsToInput(String(openOf(i)), currency),
    })),
  };
}

/** Σ of the allocation texts in micros, or null while one is invalid. */
export function allocatedMicros(
  form: Pick<PaymentForm, "rows">,
  currency: string,
): bigint | null {
  let sum = 0n;
  for (const row of form.rows) {
    const micros = amountMicros(row.allocation, currency);
    if (micros === null) return null;
    sum += micros;
  }
  return sum;
}

/**
 * The POST payments body, or the problems that block it. The allocations
 * must add up to the payment amount; each is positive and at most what is
 * open on its invoice.
 */
export function paymentOf(
  form: PaymentForm,
  invoices: readonly Invoice[],
  t: FinanceText,
  options: { fxMissing: boolean; locale?: string },
): {
  body: Record<string, unknown> | null;
  problems: string[];
  allocated: bigint | null;
  amount: bigint | null;
} {
  const p = t.payment;
  const locale = options.locale ?? "en";
  const problems: string[] = [];
  const first = invoices[0];
  if (!first)
    return {
      body: null,
      problems: [p.noInvoices],
      allocated: null,
      amount: null,
    };
  const currency = first.currency;
  const decimals = currencyDecimals(currency);
  const d = String(decimals ?? 6);
  if (!sameSettlement(invoices)) problems.push(p.mixed);
  if (!form.accountId) problems.push(p.accountRequired);
  if (!isDate(form.date)) problems.push(p.dateRequired);
  const amount = amountMicros(form.amount, currency);
  if (amount === null || amount === 0n)
    problems.push(fill(p.amountInvalid, { d }));
  const byId = new Map(invoices.map((i) => [i.id, i]));
  form.rows.forEach((row, i) => {
    const n = String(i + 1);
    const micros = amountMicros(row.allocation, currency);
    if (micros === null || micros === 0n) {
      problems.push(fill(p.allocationInvalid, { n, d }));
      return;
    }
    const invoice = byId.get(row.invoiceId);
    if (invoice && micros > openOf(invoice))
      problems.push(
        fill(p.allocationOver, {
          n,
          open: formatMoney(String(openOf(invoice)), currency, locale),
        }),
      );
  });
  const allocated = allocatedMicros(form, currency);
  if (
    amount !== null &&
    amount !== 0n &&
    allocated !== null &&
    allocated !== amount
  )
    problems.push(
      fill(p.mismatch, {
        sum: formatMoney(String(allocated), currency, locale),
        amount: formatMoney(String(amount), currency, locale),
      }),
    );
  if (options.fxMissing && !rateValid(form.rateOverride))
    problems.push(t.manage.rateInvalid);
  if (problems.length || amount === null)
    return { body: null, problems, allocated, amount };
  return {
    problems,
    allocated,
    amount,
    body: {
      direction: settlingDirection(first),
      accountId: form.accountId,
      date: form.date,
      currency,
      amountMicros: String(amount),
      ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
      allocations: form.rows.map((row) => ({
        invoiceId: row.invoiceId,
        amountMicros: String(amountMicros(row.allocation, currency)),
      })),
      ...(options.fxMissing
        ? {
            rateOverride:
              rateText(form.rateOverride) ?? form.rateOverride.trim(),
          }
        : {}),
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function PaymentFormView({
  t,
  locale,
  invoices,
  accounts,
  baseCurrency,
  onDone,
  onCancel,
}: {
  t: FinanceText;
  locale: string;
  invoices: readonly Invoice[];
  accounts: readonly Account[];
  baseCurrency: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const p = t.payment;
  const { project } = useWorkspace();
  const [form, setForm] = useState(() => initialPayment(invoices, today()));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fxMissing, setFxMissing] = useState(false);
  const lock = useRef(false);
  const update = (change: Partial<PaymentForm>) =>
    setForm((f) => ({ ...f, ...change }));
  const currency = invoices[0]?.currency ?? "";
  const { body, problems, allocated, amount } = paymentOf(form, invoices, t, {
    fxMissing,
    locale,
  });
  const offered = accounts.filter(
    (a) =>
      a.paymentAccount &&
      !a.archivedAt &&
      (!a.currency || a.currency === currency),
  );
  const known = currencyDecimals(currency) !== null;
  const difference =
    allocated !== null && amount !== null ? amount - allocated : null;
  const fid = (name: string) => `finance-payment-${name}`;

  async function submit() {
    if (lock.current || !body) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await financeApi(project.id).payments.post(body);
      onDone();
    } catch (e) {
      if (errorCode(e) === "FX_RATE_MISSING") setFxMissing(true);
      else setError(errorText(e, t));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="settings-form finance-booking"
      aria-label={p.title}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="panel-note">{p.intro}</p>
      <fieldset disabled={pending}>
        <div className="finance-grid">
          <label>
            <span>{p.account}</span>
            <select
              id={fid("account")}
              className="input"
              value={form.accountId}
              onChange={(e) => update({ accountId: e.target.value })}
            >
              <option value="">{t.manage.accountChoose}</option>
              {offered.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{p.date}</span>
            <Input
              id={fid("date")}
              type="date"
              required
              value={form.date}
              onChange={(e) => update({ date: e.target.value })}
            />
          </label>
          <label>
            <span>
              {p.amount} ({currency})
            </span>
            <Input
              id={fid("amount")}
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => update({ amount: e.target.value })}
            />
          </label>
          <label>
            <span>{p.reference}</span>
            <Input
              id={fid("reference")}
              value={form.reference}
              maxLength={200}
              onChange={(e) => update({ reference: e.target.value })}
            />
          </label>
        </div>

        <div
          className="table-wrap"
          role="region"
          aria-label={p.allocations}
          tabIndex={0}
        >
          <table className="finance-table">
            <caption className="sr-only">{p.allocations}</caption>
            <thead>
              <tr>
                <th scope="col">{p.invoice}</th>
                <th scope="col" className="finance-num">
                  {p.openAmount}
                </th>
                <th scope="col">{p.allocate}</th>
              </tr>
            </thead>
            <tbody>
              {form.rows.map((row, index) => {
                const invoice = invoices.find((i) => i.id === row.invoiceId);
                return (
                  <tr key={row.invoiceId}>
                    <th scope="row">
                      {invoice?.number ?? invoice?.issueDate ?? "—"}
                    </th>
                    <td className="finance-num">
                      {invoice
                        ? formatMoney(
                            String(openOf(invoice)),
                            invoice.currency,
                            locale,
                          )
                        : "—"}
                    </td>
                    <td>
                      <Input
                        id={fid(`allocation-${index}`)}
                        aria-label={`${p.allocate}: ${invoice?.number ?? index + 1}`}
                        inputMode="decimal"
                        value={row.allocation}
                        onChange={(e) =>
                          update({
                            rows: form.rows.map((r, i) =>
                              i === index
                                ? { ...r, allocation: e.target.value }
                                : r,
                            ),
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="finance-sums" aria-live="polite">
          <div>
            <dt>{p.sum}</dt>
            <dd>
              {allocated !== null && known
                ? formatMoney(String(allocated), currency, locale)
                : "—"}
            </dd>
          </div>
          <div data-balanced={difference === 0n ? "true" : "false"}>
            <dt>{p.difference}</dt>
            <dd>
              {difference !== null && known
                ? formatMoney(String(difference), currency, locale)
                : "—"}
            </dd>
          </div>
        </dl>

        {fxMissing && (
          <div
            className="finance-rate"
            role="group"
            aria-label={t.manage.rateTitle}
          >
            <Alert kind="warning">
              {t.manage.rateTitle}.{" "}
              {fill(t.manage.rateHint, {
                base: baseCurrency,
                currency: currency || "—",
              })}
            </Alert>
            <label>
              <span>{t.manage.rate}</span>
              <Input
                id={fid("rate")}
                inputMode="decimal"
                value={form.rateOverride}
                onChange={(e) => update({ rateOverride: e.target.value })}
              />
            </label>
          </div>
        )}
      </fieldset>

      {problems.length > 0 && (
        <ul className="finance-problems" aria-live="polite">
          {problems.map((message, i) => (
            <li key={`${i}:${message}`} className="finance-problem">
              {message}
            </li>
          ))}
        </ul>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="settings-row-actions finance-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          {p.cancel}
        </Button>
        <Button type="submit" disabled={pending || body === null}>
          {pending ? t.manage.working : p.submit}
        </Button>
      </div>
    </form>
  );
}
