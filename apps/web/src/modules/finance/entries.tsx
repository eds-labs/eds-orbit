"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { cn } from "@/lib/utils";
import { financePath, query, type JournalEntry } from "./api";
import { useFinanceAccess } from "./access";
import { EntryDetail, entryTotal } from "./entry-detail";
import { financeText } from "./labels";
import { useLast, useMasterData } from "./lists";
import { ManualEntryForm } from "./manual-entry-form";
import { formatMoney } from "./money";
import { periodOf, periodRange, type Period } from "./period";

// The journal (spec §9): filterable list of bookings. The filters and the
// open entry live in the URL (?period=&account=&category=&costCenter=&kind=
// &q=&entry=), so a link reproduces the view.

export const ENTRY_PERIODS = ["12m", "year", "lastYear", "all"] as const;
export type EntryPeriod = Period | "all";
/** Kinds offered as a filter (the server matches any kind text). */
export const ENTRY_KINDS = [
  "invoice",
  "receipt",
  "credit_note",
  "payment",
  "contribution",
  "withdrawal",
  "transfer",
  "adjustment",
  "reversal",
] as const;
const LIMIT = 500;

export type EntryFilters = {
  period: EntryPeriod;
  account: string;
  category: string;
  costCenter: string;
  kind: string;
  q: string;
};

/** The filters named in the URL; an unknown period is the default. */
export function entryFilters(
  params: Pick<URLSearchParams, "get"> | null,
): EntryFilters {
  const get = (key: string) => params?.get(key) ?? "";
  const period = get("period");
  return {
    period: period === "all" ? "all" : periodOf(period === "" ? null : period),
    account: get("account"),
    category: get("category"),
    costCenter: get("costCenter"),
    kind: get("kind"),
    q: get("q"),
  };
}

/** The GET entries query of the filters (dates from the period, UTC). */
export function entriesQuery(filters: EntryFilters, now: Date) {
  const range =
    filters.period === "all" ? {} : periodRange(filters.period, now);
  return query({
    ...range,
    account: filters.account,
    category: filters.category,
    costCenter: filters.costCenter,
    kind: filters.kind,
    q: filters.q.trim(),
    limit: LIMIT,
  });
}

/** `pathname` with `change` applied to the params; an empty value removes the key. */
export function paramsHref(
  pathname: string,
  params: Pick<URLSearchParams, "toString"> | null,
  change: Record<string, string | null>,
) {
  const next = new URLSearchParams(params?.toString() ?? "");
  for (const [key, value] of Object.entries(change))
    if (value) next.set(key, value);
    else next.delete(key);
  const text = next.toString();
  return `${pathname}${text ? `?${text}` : ""}`;
}

export function FinanceEntries() {
  const { project, locale, t: word } = useWorkspace();
  const t = financeText(locale);
  const e = t.entries;
  const { write } = useFinanceAccess();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const filters = entryFilters(params);
  const selected = params?.get("entry") ?? null;
  const master = useMasterData(project.id);
  const list = useResource<{ items: JournalEntry[] }>(
    financePath(project.id, `/entries${entriesQuery(filters, new Date())}`),
  );
  const items = useLast(list.data)?.items ?? null;
  const inList = items?.find((x) => x.id === selected) ?? null;
  const fetched = useResource<JournalEntry>(
    selected && !inList
      ? financePath(project.id, `/entries/${encodeURIComponent(selected)}`)
      : null,
  );
  const entry = inList ?? fetched.data;
  // The search box is controlled from the URL: an external change (Clear
  // filters) resets it; typing reaches the URL after a short pause.
  const [text, setText] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  if (filters.q !== seenQ) {
    setSeenQ(filters.q);
    setText(filters.q);
  }
  useEffect(() => {
    if (text.trim() === filters.q) return;
    const timer = setTimeout(() => navigate({ q: text.trim() }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = (change: Record<string, string | null>) =>
    router.replace(paramsHref(pathname, params, change));
  const baseCurrency = master.settings?.baseCurrency ?? "USD";
  const numbers = new Map((items ?? []).map((x) => [x.id, x.number]));
  const filtered =
    filters.account ||
    filters.category ||
    filters.costCenter ||
    filters.kind ||
    filters.q;
  const refresh = () => {
    list.refresh();
    if (selected && !inList) fetched.refresh();
  };

  return (
    <>
      <PageHead
        title={e.title}
        description={e.intro}
        eyebrow={word("moduleEyebrow")}
      >
        {write && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden size={14} />
            {e.newEntry}
          </Button>
        )}
      </PageHead>
      {notice && <Alert kind="success">{notice}</Alert>}
      {creating && (
        <section className="panel" aria-label={t.manual.title}>
          <div className="panel-head">
            <h2>{t.manual.title}</h2>
          </div>
          <div className="finance-body">
            <ManualEntryForm
              t={t}
              locale={locale}
              accounts={master.accounts}
              currencies={master.settings?.currencies}
              baseCurrency={baseCurrency}
              onCancel={() => setCreating(false)}
              onPosted={(number) => {
                setCreating(false);
                setNotice(t.manual.posted.replace("{number}", () => number));
                refresh();
              }}
            />
          </div>
        </section>
      )}
      <div className={cn("finance-review", selected && "finance-review-open")}>
        <section className="panel finance-queue" aria-label={e.list}>
          <div className="panel-head">
            <h2>{e.list}</h2>
          </div>
          <form
            className="finance-filters"
            role="search"
            aria-label={e.filters}
            onSubmit={(ev) => ev.preventDefault()}
          >
            <label>
              <span>{e.period}</span>
              <select
                id="finance-entries-period"
                className="input"
                value={filters.period}
                onChange={(ev) =>
                  navigate({
                    period: ev.target.value === "12m" ? null : ev.target.value,
                  })
                }
              >
                {ENTRY_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {e.periods[p]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{e.account}</span>
              <select
                id="finance-entries-account"
                className="input"
                value={filters.account}
                onChange={(ev) => navigate({ account: ev.target.value })}
              >
                <option value="">{e.any}</option>
                {master.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{e.category}</span>
              <select
                id="finance-entries-category"
                className="input"
                value={filters.category}
                onChange={(ev) => navigate({ category: ev.target.value })}
              >
                <option value="">{e.any}</option>
                {master.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{e.costCenter}</span>
              <select
                id="finance-entries-cost-center"
                className="input"
                value={filters.costCenter}
                onChange={(ev) => navigate({ costCenter: ev.target.value })}
              >
                <option value="">{e.any}</option>
                {master.costCenters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{e.kind}</span>
              <select
                id="finance-entries-kind"
                className="input"
                value={filters.kind}
                onChange={(ev) => navigate({ kind: ev.target.value })}
              >
                <option value="">{e.anyKind}</option>
                {ENTRY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {e.kinds[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{e.search}</span>
              <Input
                id="finance-entries-search"
                type="search"
                value={text}
                placeholder={e.searchHint}
                maxLength={100}
                onChange={(ev) => setText(ev.target.value)}
              />
            </label>
            {filtered && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setText("");
                  navigate({
                    account: null,
                    category: null,
                    costCenter: null,
                    kind: null,
                    q: null,
                  });
                }}
              >
                {e.clear}
              </Button>
            )}
          </form>
          <div className="finance-body">
            {master.error && (
              <ResourceError error={master.error} retry={master.retry} />
            )}
            {items === null && list.error ? (
              <ResourceError error={list.error} retry={list.refresh} />
            ) : items === null ? (
              <Skeleton />
            ) : items.length === 0 ? (
              <Empty
                title={filtered ? e.emptyFiltered : e.empty}
                description={filtered ? undefined : e.emptyBody}
              />
            ) : (
              <div
                className="table-wrap"
                role="region"
                aria-label={e.list}
                tabIndex={0}
              >
                <table className="finance-table">
                  <thead>
                    <tr>
                      <th scope="col">{e.columns.number}</th>
                      <th scope="col">{e.columns.date}</th>
                      <th scope="col">{e.columns.kind}</th>
                      <th scope="col">{e.columns.memo}</th>
                      <th scope="col" className="finance-num">
                        {e.columns.amount}
                      </th>
                      <th scope="col">{e.columns.state}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => {
                      const total = entryTotal(row);
                      return (
                        <tr
                          key={row.id}
                          aria-selected={row.id === selected || undefined}
                          data-selected={row.id === selected || undefined}
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="text-link"
                              aria-current={
                                row.id === selected ? "true" : undefined
                              }
                              onClick={() => navigate({ entry: row.id })}
                            >
                              {row.number}
                            </button>
                          </th>
                          <td>{row.entryDate.slice(0, 10)}</td>
                          <td>{e.kinds[row.kind] ?? row.kind}</td>
                          <td>{row.memo ?? "—"}</td>
                          <td className="finance-num">
                            {total === null
                              ? "—"
                              : formatMoney(total, baseCurrency, locale)}
                          </td>
                          <td>
                            {row.reversedById ? (
                              <Badge tone="warning">{e.reversedBadge}</Badge>
                            ) : row.kind === "reversal" ? (
                              <Badge>{e.kinds.reversal}</Badge>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
        {selected &&
          (entry ? (
            <EntryDetail
              key={entry.id}
              t={t}
              locale={locale}
              entry={entry}
              accounts={master.accounts}
              baseCurrency={baseCurrency}
              numberOf={(id) => numbers.get(id) ?? null}
              canWrite={write}
              onClose={() => navigate({ entry: null })}
              onChanged={(message) => {
                setNotice(message);
                refresh();
              }}
            />
          ) : fetched.error ? (
            <ResourceError error={fetched.error} retry={fetched.refresh} />
          ) : (
            <Skeleton />
          ))}
      </div>
    </>
  );
}
