"use client";
import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, Button, Input } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { Locale } from "@/lib/i18n";
import { financeApi, type Account } from "./api";
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
import { CURRENCIES, formatMoney } from "./money";

// The manual entry form (spec §7): contributions, withdrawals, transfers
// between payment accounts and free adjustments. Amounts use the same
// decimal parsing as the booking form. An adjustment must balance in its
// currency; the running difference is shown and blocks submitting while it
// is not zero. The server checks everything again.

export type ManualKind =
  "contribution" | "withdrawal" | "transfer" | "adjustment";
export const MANUAL_KINDS: readonly ManualKind[] = [
  "contribution",
  "withdrawal",
  "transfer",
  "adjustment",
];

export type ManualLine = {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
};
export type ManualForm = {
  kind: ManualKind;
  date: string;
  currency: string;
  accountId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  memo: string;
  lines: ManualLine[];
  rateOverride: string;
};

const blankLine = (side: ManualLine["side"]): ManualLine => ({
  accountId: "",
  side,
  amount: "",
});

export function initialManual(currency: string, today: string): ManualForm {
  return {
    kind: "contribution",
    date: today,
    currency,
    accountId: "",
    fromAccountId: "",
    toAccountId: "",
    amount: "",
    memo: "",
    lines: [blankLine("debit"), blankLine("credit")],
    rateOverride: "",
  };
}

/**
 * Debits, credits and their difference of an adjustment in micros. Each is
 * null while a line's amount is not valid, so no half-typed sum is shown.
 */
export function adjustmentBalance(
  form: Pick<ManualForm, "lines" | "currency">,
): {
  debit: bigint | null;
  credit: bigint | null;
  difference: bigint | null;
} {
  let debit = 0n;
  let credit = 0n;
  let valid = true;
  for (const line of form.lines) {
    const micros = amountMicros(line.amount, form.currency);
    if (micros === null) {
      valid = false;
      continue;
    }
    if (line.side === "debit") debit += micros;
    else credit += micros;
  }
  return valid
    ? { debit, credit, difference: debit - credit }
    : { debit: null, credit: null, difference: null };
}

/** The POST entries body. Amounts are decimal text; the server parses them. */
export type ManualBody = Record<string, unknown>;

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

/**
 * The body the form describes, or the problems that block it. `fxMissing`
 * (after FX_RATE_MISSING) adds the manual rate, which then is required.
 */
export function manualEntryOf(
  form: ManualForm,
  t: FinanceText,
  options: { fxMissing: boolean; locale?: string },
): { body: ManualBody | null; problems: string[] } {
  const m = t.manual;
  const problems: string[] = [];
  const decimals = currencyDecimals(form.currency);
  if (decimals === null) problems.push(m.currencyRequired);
  if (!isDate(form.date)) problems.push(m.dateRequired);
  const canonical = (text: string) =>
    microsToInput(String(amountMicros(text, form.currency)), form.currency);
  const common = {
    date: form.date,
    currency: form.currency,
    ...(form.memo.trim() ? { memo: form.memo.trim() } : {}),
    ...(options.fxMissing
      ? {
          rateOverride: rateText(form.rateOverride) ?? form.rateOverride.trim(),
        }
      : {}),
  };
  let body: ManualBody | null = null;
  if (form.kind === "adjustment") {
    if (form.lines.length < 2) problems.push(m.linesMin);
    form.lines.forEach((line, i) => {
      const n = String(i + 1);
      if (!line.accountId) problems.push(fill(m.lineAccount, { n }));
      if (
        decimals !== null &&
        (amountMicros(line.amount, form.currency) === null ||
          amountMicros(line.amount, form.currency) === 0n)
      )
        problems.push(fill(m.lineAmount, { n, d: String(decimals) }));
    });
    const { difference } = adjustmentBalance(form);
    if (difference !== null && difference !== 0n && decimals !== null)
      problems.push(
        fill(m.unbalanced, {
          diff: formatMoney(
            String(difference < 0n ? -difference : difference),
            form.currency,
            options.locale ?? "en",
          ),
        }),
      );
    body = {
      kind: "adjustment",
      ...common,
      lines: form.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount:
          amountMicros(line.amount, form.currency) === null
            ? line.amount.trim()
            : canonical(line.amount),
      })),
    };
  } else {
    const micros = amountMicros(form.amount, form.currency);
    if (decimals !== null && (micros === null || micros === 0n))
      problems.push(fill(m.amountInvalid, { d: String(decimals) }));
    const amount =
      micros === null ? form.amount.trim() : canonical(form.amount);
    if (form.kind === "transfer") {
      if (!form.fromAccountId || !form.toAccountId)
        problems.push(m.accountRequired);
      else if (form.fromAccountId === form.toAccountId)
        problems.push(m.sameAccount);
      body = {
        kind: "transfer",
        fromAccountId: form.fromAccountId,
        toAccountId: form.toAccountId,
        amount,
        ...common,
      };
    } else {
      if (!form.accountId) problems.push(m.accountRequired);
      body = { kind: form.kind, accountId: form.accountId, amount, ...common };
    }
  }
  if (options.fxMissing && !rateValid(form.rateOverride))
    problems.push(t.manage.rateInvalid);
  return problems.length ? { body: null, problems } : { body, problems };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The manual entry form. `accounts` are all the project's accounts; payment
 * accounts of the chosen currency are offered for contributions,
 * withdrawals and transfers, every live account for adjustments.
 */
export function ManualEntryForm({
  t,
  locale,
  accounts,
  currencies = CURRENCIES,
  baseCurrency,
  initial,
  onPosted,
  onCancel,
}: {
  t: FinanceText;
  locale: Locale;
  accounts: readonly Account[];
  currencies?: readonly string[];
  baseCurrency: string;
  /** Starting values over the defaults. */
  initial?: Partial<ManualForm>;
  onPosted: (number: string) => void;
  onCancel: () => void;
}) {
  const m = t.manual;
  const { project } = useWorkspace();
  const [form, setForm] = useState(() => ({
    ...initialManual(baseCurrency, today()),
    ...initial,
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fxMissing, setFxMissing] = useState(false);
  const lock = useRef(false);
  const update = (change: Partial<ManualForm>) =>
    setForm((f) => ({ ...f, ...change }));
  const setLine = (index: number, change: Partial<ManualLine>) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, i) => (i === index ? { ...l, ...change } : l)),
    }));
  const { body, problems } = manualEntryOf(form, t, {
    fxMissing,
    locale,
  });
  const live = accounts.filter((a) => !a.archivedAt);
  const payment = live.filter(
    (a) => a.paymentAccount && (!a.currency || a.currency === form.currency),
  );
  const balance = adjustmentBalance(form);
  const known = currencyDecimals(form.currency) !== null;
  const fid = (name: string) => `finance-manual-${name}`;
  const accountOptions = (list: readonly Account[]) =>
    list.map((a) => (
      <option key={a.id} value={a.id}>
        {a.code} · {a.name}
      </option>
    ));

  async function submit() {
    if (lock.current || !body) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = (await financeApi(project.id).entries.post(body)) as {
        number?: string;
      };
      onPosted(result.number ?? "");
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
      aria-label={m.title}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={pending}>
        <div className="finance-grid">
          <label>
            <span>{m.kind}</span>
            <select
              id={fid("kind")}
              className="input"
              value={form.kind}
              onChange={(e) => update({ kind: e.target.value as ManualKind })}
            >
              {MANUAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {m.kinds[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t.manage.date}</span>
            <Input
              id={fid("date")}
              type="date"
              required
              value={form.date}
              onChange={(e) => update({ date: e.target.value })}
            />
          </label>
          <label>
            <span>{t.manage.currency}</span>
            <select
              id={fid("currency")}
              className="input"
              value={form.currency}
              onChange={(e) => update({ currency: e.target.value })}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        {form.kind === "adjustment" ? (
          <fieldset className="finance-lines">
            <legend>{m.lines}</legend>
            {form.lines.map((line, index) => {
              const n = String(index + 1);
              return (
                <div
                  key={index}
                  className="finance-line"
                  role="group"
                  aria-label={fill(m.line, { n })}
                >
                  <div className="finance-grid">
                    <label>
                      <span>{t.manage.account}</span>
                      <select
                        id={fid(`line-account-${index}`)}
                        className="input"
                        value={line.accountId}
                        onChange={(e) =>
                          setLine(index, { accountId: e.target.value })
                        }
                      >
                        <option value="">{t.manage.accountChoose}</option>
                        {accountOptions(live)}
                      </select>
                    </label>
                    <label>
                      <span>{m.side}</span>
                      <select
                        id={fid(`line-side-${index}`)}
                        className="input"
                        value={line.side}
                        onChange={(e) =>
                          setLine(index, {
                            side: e.target.value as ManualLine["side"],
                          })
                        }
                      >
                        <option value="debit">{m.debit}</option>
                        <option value="credit">{m.credit}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t.manage.amount}</span>
                      <Input
                        id={fid(`line-amount-${index}`)}
                        inputMode="decimal"
                        value={line.amount}
                        onChange={(e) =>
                          setLine(index, { amount: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {form.lines.length > 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update({
                          lines: form.lines.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 aria-hidden size={14} />
                      {m.removeLine}
                    </Button>
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                update({ lines: [...form.lines, blankLine("debit")] })
              }
            >
              <Plus aria-hidden size={14} />
              {m.addLine}
            </Button>
            <dl className="finance-sums" aria-live="polite">
              <div>
                <dt>{m.debits}</dt>
                <dd>
                  {balance.debit !== null && known
                    ? formatMoney(String(balance.debit), form.currency, locale)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{m.credits}</dt>
                <dd>
                  {balance.credit !== null && known
                    ? formatMoney(String(balance.credit), form.currency, locale)
                    : "—"}
                </dd>
              </div>
              <div data-balanced={balance.difference === 0n ? "true" : "false"}>
                <dt>{m.difference}</dt>
                <dd>
                  {balance.difference !== null && known
                    ? formatMoney(
                        String(balance.difference),
                        form.currency,
                        locale,
                      )
                    : "—"}
                </dd>
              </div>
            </dl>
          </fieldset>
        ) : (
          <div className="finance-grid">
            {form.kind === "transfer" ? (
              <>
                <label>
                  <span>{m.from}</span>
                  <select
                    id={fid("from")}
                    className="input"
                    value={form.fromAccountId}
                    onChange={(e) => update({ fromAccountId: e.target.value })}
                  >
                    <option value="">{t.manage.accountChoose}</option>
                    {accountOptions(payment)}
                  </select>
                </label>
                <label>
                  <span>{m.to}</span>
                  <select
                    id={fid("to")}
                    className="input"
                    value={form.toAccountId}
                    onChange={(e) => update({ toAccountId: e.target.value })}
                  >
                    <option value="">{t.manage.accountChoose}</option>
                    {accountOptions(payment)}
                  </select>
                </label>
              </>
            ) : (
              <label>
                <span>{m.paymentAccount}</span>
                <select
                  id={fid("account")}
                  className="input"
                  value={form.accountId}
                  onChange={(e) => update({ accountId: e.target.value })}
                >
                  <option value="">{t.manage.accountChoose}</option>
                  {accountOptions(payment)}
                </select>
              </label>
            )}
            <label>
              <span>{t.manage.amount}</span>
              <Input
                id={fid("amount")}
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => update({ amount: e.target.value })}
              />
            </label>
          </div>
        )}

        <label>
          <span>{m.memo}</span>
          <Input
            id={fid("memo")}
            value={form.memo}
            maxLength={500}
            onChange={(e) => update({ memo: e.target.value })}
          />
          <small className="field-hint">{m.memoHint}</small>
        </label>

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
                currency: form.currency || "—",
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
          {problems.map((p, i) => (
            <li key={`${i}:${p}`} className="finance-problem">
              {p}
            </li>
          ))}
        </ul>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="settings-row-actions finance-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.cancel}
        </Button>
        <Button type="submit" disabled={pending || body === null}>
          {pending ? t.manage.working : m.submit}
        </Button>
      </div>
    </form>
  );
}
