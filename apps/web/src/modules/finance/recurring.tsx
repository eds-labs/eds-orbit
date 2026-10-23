"use client";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Input,
  Skeleton,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { financeApi, financePath, query, type Recurring } from "./api";
import { useFinanceAccess } from "./access";
import {
  AllocationEditor,
  allocationOf,
  rowsOf,
  type AllocationRow,
} from "./allocation-editor";
import {
  amountMicros,
  currencyDecimals,
  isDate,
  microsToInput,
} from "./amount";
import { financeText, type FinanceText } from "./labels";
import { errorCode, errorText, useLast, useMasterData } from "./lists";
import { CURRENCIES, formatMoney } from "./money";

// Recurring costs (spec §9): a list with the monthly equivalent and the next
// due date, and a form to add and edit them. A cost that invoices were
// booked from cannot be deleted (409 FINANCE_IN_USE); archiving switches it
// off instead and keeps it readable.

export const INTERVALS = ["monthly", "quarterly", "yearly"] as const;
type Interval = (typeof INTERVALS)[number];
const MONTHS: Record<Interval, bigint> = {
  monthly: 1n,
  quarterly: 3n,
  yearly: 12n,
};

/**
 * What the cost amounts to per month in micros, rounded half to even to the
 * decimals of its currency like the server (quarterly divided by 3, yearly
 * by 12). Null for an unknown interval or currency.
 */
export function monthlyEquivalent(
  expectedMicros: string,
  interval: string,
  currency: string,
): bigint | null {
  const months = MONTHS[interval as Interval];
  const decimals = currencyDecimals(currency);
  if (!months || decimals === null || !/^\d+$/.test(expectedMicros))
    return null;
  const amount = BigInt(expectedMicros);
  const unit = 10n ** BigInt(6 - decimals);
  const divisor = months * unit;
  const quotient = amount / divisor;
  const twice = (amount % divisor) * 2n;
  const up = twice > divisor || (twice === divisor && quotient % 2n === 1n);
  return (up ? quotient + 1n : quotient) * unit;
}

export type RecurringForm = {
  /** Set while editing: the row and the version the edit is based on. */
  id: string | null;
  version: number;
  name: string;
  counterpartyId: string;
  categoryId: string;
  allocation: AllocationRow[];
  interval: Interval;
  amount: string;
  currency: string;
  nextDueDate: string;
  active: boolean;
};

export const blankRecurring = (
  currency: string,
  today: string,
): RecurringForm => ({
  id: null,
  version: 0,
  name: "",
  counterpartyId: "",
  categoryId: "",
  allocation: [],
  interval: "monthly",
  amount: "",
  currency,
  nextDueDate: today,
  active: true,
});

export function formOf(item: Recurring): RecurringForm {
  return {
    id: item.id,
    version: item.version,
    name: item.name,
    counterpartyId: item.counterpartyId ?? "",
    categoryId: item.categoryId ?? "",
    allocation: rowsOf(item.allocation),
    interval: INTERVALS.find((i) => i === item.interval) ?? "monthly",
    amount: microsToInput(item.expectedAmountMicros, item.currency),
    currency: item.currency,
    nextDueDate: item.nextDueDate.slice(0, 10),
    active: item.active,
  };
}

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

/** The create or update body of the form, or the problems that block it. */
export function recurringBodyOf(
  form: RecurringForm,
  t: FinanceText,
): { body: Record<string, unknown> | null; problems: string[] } {
  const r = t.recurring;
  const problems: string[] = [];
  const decimals = currencyDecimals(form.currency);
  if (!form.name.trim()) problems.push(r.nameRequired);
  if (decimals === null) problems.push(r.currencyRequired);
  const micros = amountMicros(form.amount, form.currency);
  if (decimals !== null && (micros === null || micros === 0n))
    problems.push(fill(r.amountInvalid, { d: String(decimals) }));
  if (!isDate(form.nextDueDate)) problems.push(r.dateRequired);
  const split = allocationOf(form.allocation);
  if (split.problem) problems.push(t.allocation.sumInvalid);
  if (problems.length || micros === null) return { body: null, problems };
  return {
    problems,
    body: {
      name: form.name.trim(),
      counterpartyId: form.counterpartyId || null,
      categoryId: form.categoryId || null,
      allocation:
        split.allocation && split.allocation.length ? split.allocation : null,
      interval: form.interval,
      expectedAmountMicros: String(micros),
      currency: form.currency,
      nextDueDate: form.nextDueDate,
      ...(form.id ? { version: form.version, active: form.active } : {}),
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function FinanceRecurring() {
  const { project, locale, t: word } = useWorkspace();
  const t = financeText(locale);
  const r = t.recurring;
  const { write } = useFinanceAccess();
  const finance = financeApi(project.id);
  const master = useMasterData(project.id);
  const [showArchived, setShowArchived] = useState(false);
  const list = useResource<{ items: Recurring[] }>(
    financePath(
      project.id,
      `/recurring${query({ includeInactive: showArchived || undefined })}`,
    ),
  );
  const items = useLast(list.data)?.items ?? null;
  const [form, setForm] = useState<RecurringForm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inUse, setInUse] = useState<string | null>(null);
  const lock = useRef(false);
  const lastCode = useRef<string | null>(null);
  const baseCurrency = master.settings?.baseCurrency ?? "USD";
  const currencies: readonly string[] =
    master.settings?.currencies ?? CURRENCIES;
  const names = new Map(master.counterparties.map((c) => [c.id, c.name]));

  /** One request at a time (a ref lock, so a double click sends once). */
  async function act(task: () => Promise<unknown>, done: string) {
    if (lock.current) return false;
    lock.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    lastCode.current = null;
    try {
      await task();
      setNotice(done);
      list.refresh();
      return true;
    } catch (e) {
      lastCode.current = errorCode(e);
      setError(
        errorCode(e) === "VERSION_CONFLICT"
          ? t.manage.conflict
          : errorText(e, t),
      );
      return false;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  const monthly = (item: Recurring) =>
    monthlyEquivalent(item.expectedAmountMicros, item.interval, item.currency);
  const active = (items ?? []).filter((i) => i.active);
  const totalItems = active.filter((i) => i.currency === baseCurrency);
  const total = totalItems.reduce((sum, i) => sum + (monthly(i) ?? 0n), 0n);
  const excluded = active.length > totalItems.length;
  const problems = form ? recurringBodyOf(form, t) : null;

  async function save() {
    if (!form || !problems?.body) return;
    const body = problems.body;
    const ok = await act(
      () =>
        form.id
          ? finance.recurring.update(form.id, body as never)
          : finance.recurring.create(body as never),
      r.saved,
    );
    if (ok) setForm(null);
  }

  return (
    <>
      <PageHead
        title={r.title}
        description={r.intro}
        eyebrow={word("moduleEyebrow")}
      >
        {write && !form && (
          <Button
            onClick={() => setForm(blankRecurring(baseCurrency, today()))}
          >
            <Plus aria-hidden size={14} />
            {r.add}
          </Button>
        )}
      </PageHead>
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {!write && <p className="panel-note">{t.manage.readOnly}</p>}
      {form && (
        <section
          className="panel"
          aria-label={form.id ? r.formEdit : r.formNew}
        >
          <div className="panel-head">
            <h2>{form.id ? r.formEdit : r.formNew}</h2>
          </div>
          <div className="finance-body">
            <form
              className="settings-form finance-booking"
              aria-label={form.id ? r.formEdit : r.formNew}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={pending}>
                <label>
                  <span>{r.name}</span>
                  <Input
                    id="finance-recurring-name"
                    required
                    maxLength={160}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <div className="finance-grid">
                  <label>
                    <span>{t.manage.counterparty}</span>
                    <select
                      id="finance-recurring-counterparty"
                      className="input"
                      value={form.counterpartyId}
                      onChange={(e) =>
                        setForm({ ...form, counterpartyId: e.target.value })
                      }
                    >
                      <option value="">{t.manage.none}</option>
                      {master.counterparties.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{r.category}</span>
                    <select
                      id="finance-recurring-category"
                      className="input"
                      value={form.categoryId}
                      onChange={(e) =>
                        setForm({ ...form, categoryId: e.target.value })
                      }
                    >
                      <option value="">{r.categoryChoose}</option>
                      {master.categories
                        .filter(
                          (c) =>
                            c.id === form.categoryId ||
                            (!c.archivedAt && c.kind === "expense"),
                        )
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <AllocationEditor
                  t={t}
                  id="finance-recurring-alloc"
                  rows={form.allocation}
                  costCenters={master.costCenters}
                  disabled={pending}
                  onChange={(allocation) => setForm({ ...form, allocation })}
                />
                <div className="finance-grid">
                  <label>
                    <span>{r.interval}</span>
                    <select
                      id="finance-recurring-interval"
                      className="input"
                      value={form.interval}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          interval: e.target.value as Interval,
                        })
                      }
                    >
                      {INTERVALS.map((i) => (
                        <option key={i} value={i}>
                          {r.intervals[i]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{r.amount}</span>
                    <Input
                      id="finance-recurring-amount"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(e) =>
                        setForm({ ...form, amount: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>{r.currency}</span>
                    <select
                      id="finance-recurring-currency"
                      className="input"
                      value={form.currency}
                      onChange={(e) =>
                        setForm({ ...form, currency: e.target.value })
                      }
                    >
                      {[
                        ...currencies,
                        ...(currencies.includes(form.currency)
                          ? []
                          : [form.currency]),
                      ].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{r.nextDue}</span>
                    <Input
                      id="finance-recurring-next"
                      type="date"
                      required
                      value={form.nextDueDate}
                      onChange={(e) =>
                        setForm({ ...form, nextDueDate: e.target.value })
                      }
                    />
                  </label>
                </div>
                {form.id && (
                  <label className="settings-check">
                    <input
                      id="finance-recurring-active"
                      type="checkbox"
                      checked={form.active}
                      onChange={(e) =>
                        setForm({ ...form, active: e.target.checked })
                      }
                    />
                    {r.activeLabel}
                  </label>
                )}
                {(() => {
                  const micros = amountMicros(form.amount, form.currency);
                  const per =
                    micros === null
                      ? null
                      : monthlyEquivalent(
                          String(micros),
                          form.interval,
                          form.currency,
                        );
                  return (
                    <p className="finance-allocation-sum" aria-live="polite">
                      {fill(r.monthly, {
                        amount:
                          per === null
                            ? "—"
                            : formatMoney(String(per), form.currency, locale),
                      })}
                    </p>
                  );
                })()}
              </fieldset>
              {problems && problems.problems.length > 0 && (
                <ul className="finance-problems" aria-live="polite">
                  {problems.problems.map((p) => (
                    <li key={p} className="finance-problem">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
              <div className="settings-row-actions finance-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setForm(null)}
                >
                  {r.cancel}
                </Button>
                <Button type="submit" disabled={pending || !problems?.body}>
                  {pending ? t.manage.working : r.save}
                </Button>
              </div>
            </form>
          </div>
        </section>
      )}
      <section className="panel" aria-label={r.list}>
        <div className="panel-head">
          <h2>{r.list}</h2>
          <label className="settings-check finance-noprint">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {r.showArchived}
          </label>
        </div>
        <div className="finance-body">
          {master.error && (
            <ResourceError error={master.error} retry={master.retry} />
          )}
          {items === null && list.error ? (
            <ResourceError error={list.error} retry={list.refresh} />
          ) : items === null ? (
            <Skeleton />
          ) : items.length === 0 ? (
            <Empty title={r.empty} description={r.emptyBody} />
          ) : (
            <>
              <p className="finance-allocation-sum">
                {r.total}: {formatMoney(String(total), baseCurrency, locale)}
                {excluded && ` (${r.totalMissing})`}
              </p>
              <div
                className="table-wrap"
                role="region"
                aria-label={r.list}
                tabIndex={0}
              >
                <table className="finance-table">
                  <thead>
                    <tr>
                      <th scope="col">{r.columns.name}</th>
                      <th scope="col">{r.columns.counterparty}</th>
                      <th scope="col">{r.columns.interval}</th>
                      <th scope="col" className="finance-num">
                        {r.columns.amount}
                      </th>
                      <th scope="col" className="finance-num">
                        {r.columns.monthly}
                      </th>
                      <th scope="col">{r.columns.next}</th>
                      <th scope="col">{r.columns.state}</th>
                      {write && (
                        <th scope="col" className="finance-noprint">
                          <span className="sr-only">{t.manage.edit}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const per = monthly(item);
                      return (
                        <tr key={item.id}>
                          <th scope="row">{item.name}</th>
                          <td>
                            {item.counterpartyId
                              ? (names.get(item.counterpartyId) ?? "—")
                              : "—"}
                          </td>
                          <td>{r.intervals[item.interval] ?? item.interval}</td>
                          <td className="finance-num">
                            {formatMoney(
                              item.expectedAmountMicros,
                              item.currency,
                              locale,
                            )}
                          </td>
                          <td className="finance-num">
                            {per === null
                              ? "—"
                              : formatMoney(String(per), item.currency, locale)}
                          </td>
                          <td>{item.nextDueDate.slice(0, 10)}</td>
                          <td>
                            <Badge tone={item.active ? "success" : "neutral"}>
                              {item.active ? r.active : r.archived}
                            </Badge>
                          </td>
                          {write && (
                            <td className="finance-noprint">
                              <div className="settings-row-actions">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={pending}
                                  onClick={() => setForm(formOf(item))}
                                >
                                  {t.manage.edit}
                                </Button>
                                {item.active ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={pending}
                                    onClick={() =>
                                      act(
                                        () =>
                                          finance.recurring.archive(item.id),
                                        r.saved,
                                      )
                                    }
                                  >
                                    {r.archive}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={pending}
                                    onClick={() =>
                                      act(
                                        () =>
                                          finance.recurring.update(item.id, {
                                            version: item.version,
                                            active: true,
                                          }),
                                        r.saved,
                                      )
                                    }
                                  >
                                    {r.activate}
                                  </Button>
                                )}
                                {confirming === item.id ? (
                                  <>
                                    <span>{r.deleteConfirm}</span>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      disabled={pending}
                                      onClick={async () => {
                                        const ok = await act(
                                          () =>
                                            finance.recurring.remove(item.id),
                                          r.deleted,
                                        );
                                        setConfirming(null);
                                        if (
                                          !ok &&
                                          lastCode.current === "FINANCE_IN_USE"
                                        )
                                          setInUse(item.id);
                                      }}
                                    >
                                      {r.delete}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setConfirming(null)}
                                    >
                                      {r.cancel}
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() => {
                                      setInUse(null);
                                      setConfirming(item.id);
                                    }}
                                  >
                                    {r.delete}
                                  </Button>
                                )}
                              </div>
                              {inUse === item.id && (
                                <small className="field-hint">
                                  {r.inUseHint}
                                </small>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
