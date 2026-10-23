"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardCheck,
  Repeat,
  TrendingDown,
  TrendingUp,
  Wallet,
  Receipt,
} from "lucide-react";
import { useMutation, useResource, when } from "@/lib/api";
import { Alert, Button, Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { Metric } from "@/platform/ui/metric";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { labels } from "@/lib/i18n";
import {
  financeApi,
  financePath,
  query,
  type FinanceDocument,
  type SetupStatus,
  type Summary,
} from "./api";
import { financeText, type FinanceText } from "./labels";
import { useFinanceAccess } from "./access";
import { MonthlyBars, RankedBars, Sparkline, micros } from "./charts";
import { formatMoney } from "./money";
import { periodOf, periodRange, PERIODS } from "./period";

const RECEIPT_LIMIT = 10;

/** True when no month has income or expenses and nothing is open. */
export function hasNoBookings(summary: Summary): boolean {
  return (
    summary.months.every(
      (m) => micros(m.incomeMicros) === 0n && micros(m.expenseMicros) === 0n,
    ) &&
    summary.open.count === 0 &&
    summary.overdue.count === 0
  );
}

/**
 * The setup screen: shown while a system account is missing, with the
 * owner's one-click default chart of accounts.
 */
export function SetupPrompt({
  t,
  missingRoles,
  canSetup,
  pending,
  error,
  onApply,
}: {
  t: FinanceText;
  missingRoles: readonly string[];
  canSetup: boolean;
  pending: boolean;
  error: string | null;
  onApply: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.setup.title}</h2>
          <p>{t.setup.body}</p>
        </div>
      </div>
      {missingRoles.length > 0 && (
        <p className="panel-note">
          {t.setup.missing}:{" "}
          {missingRoles.map((r) => t.roles[r] ?? r).join(", ")}
        </p>
      )}
      {canSetup ? (
        <Button disabled={pending} onClick={onApply}>
          {t.setup.action}
        </Button>
      ) : (
        <p className="panel-note">{t.setup.ownerNeeded}</p>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}

/** The review queue, one level below the finance root (registered in a later page). */
export function useReviewHref() {
  return `${useShell().hrefOf("finance")}/review`;
}

function ReceiptList() {
  const { project, locale } = useWorkspace();
  const t = financeText(locale).dashboard;
  const reviewHref = useReviewHref();
  const list = useResource<{ items: FinanceDocument[] }>(
    financePath(
      project.id,
      `/documents${query({ status: "needs_review", limit: RECEIPT_LIMIT })}`,
    ),
  );
  return (
    <section className="panel" aria-label={t.receipts}>
      <div className="panel-head">
        <h2>{t.receipts}</h2>
        <AppLink className="text-link" href={reviewHref}>
          {t.reviewAll}
          <ArrowRight aria-hidden />
        </AppLink>
      </div>
      <div className="finance-body">
        {list.loading ? (
          <Skeleton />
        ) : list.error ? (
          <ResourceError error={list.error} retry={list.refresh} />
        ) : list.data?.items.length ? (
          <ul className="settings-rows">
            {list.data.items.slice(0, RECEIPT_LIMIT).map((doc) => (
              <li key={doc.id}>
                <AppLink
                  className="list-row"
                  href={`${reviewHref}?document=${encodeURIComponent(doc.id)}`}
                >
                  <span className="list-row-title">
                    {doc.originalName ?? t.unnamedReceipt}
                  </span>
                  <span className="list-row-meta">
                    {when(doc.createdAt, locale, project.timezone)}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t.receiptsEmpty} />
        )}
      </div>
    </section>
  );
}

/** The figures of the current month, or null when it is outside the period. */
function thisMonth(summary: Summary | null, now: Date) {
  const key = now.toISOString().slice(0, 7);
  return summary?.months.find((m) => m.month === key) ?? null;
}

function Dashboard({ now }: { now: Date }) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = financeText(locale).dashboard;
  const word = labels[locale];
  const reviewHref = useReviewHref();
  const period = periodOf(params?.get("period") ?? null);
  const range = periodRange(period, now);
  const summary = useResource<Summary>(
    financePath(project.id, `/summary${query(range)}`),
  );
  const s = summary.data;
  const currency = s?.baseCurrency ?? "";
  const money = (value: string | undefined) =>
    s && value !== undefined ? formatMoney(value, currency, locale) : "—";
  const month = thisMonth(s, now);
  const count = (n: number | undefined) => (s ? String(n ?? "—") : "—");
  return (
    <>
      <div className="finance-period">
        <label htmlFor="finance-period">{t.period}</label>
        <select
          id="finance-period"
          className="input"
          value={period}
          onChange={(e) => {
            const next = new URLSearchParams(params?.toString() ?? "");
            next.set("period", e.target.value);
            router.replace(`${pathname}?${next.toString()}`);
          }}
        >
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t.periods[p]}
            </option>
          ))}
        </select>
      </div>
      <ResourceError error={summary.error} retry={summary.refresh} />
      <div className="metrics-strip metrics-five">
        <Metric
          icon={TrendingUp}
          label={t.incomeMonth}
          amount={money(month?.incomeMicros)}
        />
        <Metric
          icon={TrendingDown}
          label={t.expenseMonth}
          amount={money(month?.expenseMicros)}
        />
        <Metric
          icon={Wallet}
          label={t.resultMonth}
          amount={money(month?.resultMicros)}
        />
        <Metric
          icon={Receipt}
          label={t.open}
          amount={count(s?.open.count)}
          detail={
            s
              ? t.openDetail
                  .replace("{payable}", money(s.open.payableMicros))
                  .replace("{receivable}", money(s.open.receivableMicros))
              : undefined
          }
        />
        <Metric
          icon={AlertTriangle}
          label={t.overdue}
          amount={money(s?.overdue.totalMicros)}
          detail={
            s
              ? t.overdueDetail.replace("{n}", String(s.overdue.count))
              : undefined
          }
          tone={s && s.overdue.count > 0 ? "warning" : undefined}
        />
        <Metric
          icon={Repeat}
          label={t.running}
          amount={money(s?.recurringMonthlyMicros)}
          detail={
            s && s.recurringMissingRate > 0 ? t.runningMissing : undefined
          }
        />
        <Metric
          icon={ClipboardCheck}
          label={t.review}
          amount={count(s?.reviewCount)}
          href={reviewHref}
        />
      </div>
      {summary.loading ? (
        <Skeleton />
      ) : s && hasNoBookings(s) ? (
        <section className="panel">
          <Empty title={t.emptyTitle} description={t.emptyBody}>
            <Button asChild>
              <AppLink href={reviewHref}>{t.reviewAll}</AppLink>
            </Button>
            <Button asChild variant="outline">
              <AppLink href={shell.hrefOf("settings")}>
                {t.emptySettings}
              </AppLink>
            </Button>
          </Empty>
        </section>
      ) : s ? (
        <>
          <section className="panel" aria-label={t.monthly}>
            <div className="panel-head">
              <h2>{t.monthly}</h2>
            </div>
            <div className="finance-body">
              <MonthlyBars months={s.months} currency={currency} />
            </div>
          </section>
          <div className="overview-columns">
            <section className="panel" aria-label={t.costCenters}>
              <div className="panel-head">
                <h2>{t.costCenters}</h2>
              </div>
              <div className="finance-body">
                <RankedBars
                  caption={t.costCenters}
                  currency={currency}
                  fallback={word.financeReportUnassigned}
                  rows={s.byCostCenter.map((c) => ({
                    id: c.id,
                    name: c.name,
                    valueMicros: c.expenseMicros,
                  }))}
                />
              </div>
            </section>
            <section className="panel" aria-label={t.categories}>
              <div className="panel-head">
                <h2>{t.categories}</h2>
              </div>
              <div className="finance-body">
                <ul className="finance-trend">
                  {s.byCategory.map((c) => {
                    const name = c.name ?? word.financeReportOther;
                    const total = String(
                      c.months.reduce(
                        (sum, m) => sum + micros(m.expenseMicros),
                        0n,
                      ),
                    );
                    return (
                      <li key={c.id ?? (c.other ? "other" : "none")}>
                        <span>{name}</span>
                        <Sparkline
                          label={t.categoriesLabel
                            .replace("{name}", name)
                            .replace(
                              "{total}",
                              formatMoney(total, currency, locale),
                            )}
                          currency={currency}
                          points={c.months.map((m) => ({
                            month: m.month,
                            valueMicros: m.expenseMicros,
                          }))}
                        />
                        <span>{formatMoney(total, currency, locale)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          </div>
        </>
      ) : null}
      <ReceiptList />
    </>
  );
}

/**
 * The overview: the setup screen while a system account is missing, then
 * the dashboard (spec §9) with the metrics strip, the monthly chart, cost
 * centers, the category trend and the receipts waiting for review.
 */
export function FinanceOverview() {
  const { project, locale, t: word } = useWorkspace();
  const { owner } = useFinanceAccess();
  const t = financeText(locale);
  const [now] = useState(() => new Date());
  const setup = useResource<SetupStatus>(financePath(project.id, "/setup"));
  const apply = useMutation(setup.refresh);
  return (
    <>
      <PageHead
        title={t.finance}
        description={t.financeIntro}
        eyebrow={word("moduleEyebrow")}
      />
      {setup.loading ? (
        <Skeleton />
      ) : setup.error ? (
        <ResourceError error={setup.error} retry={setup.refresh} />
      ) : setup.data && !setup.data.ready ? (
        <SetupPrompt
          t={t}
          missingRoles={setup.data.missingRoles}
          canSetup={owner}
          pending={apply.pending}
          error={apply.error}
          onApply={() => apply.run(() => financeApi(project.id).setup.apply())}
        />
      ) : (
        <Dashboard now={now} />
      )}
      {apply.success && <Alert kind="success">{t.setup.created}</Alert>}
    </>
  );
}
