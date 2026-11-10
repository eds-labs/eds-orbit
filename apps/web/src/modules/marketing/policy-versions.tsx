"use client";
// The versions of the Marketing operating policy (WP5, 2026-11-10). Every
// save creates a new record and sets the previous one `active: false`
// (savePolicy); records have no `status`, and `entity.version` is their
// optimistic lock, not the policy's version. The number shown is the
// record's position (oldest = 1) and the state is derived from `active`
// and the validity window, as the server reads the active policy.
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Entity } from "@/lib/api";
import { modeLabel, type Locale } from "@/lib/i18n";
import { statusLabel } from "@/lib/status-text";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";
import { marketingText, type MarketingText } from "./labels";

export type PolicyState = "active" | "scheduled" | "expired" | "replaced";

export type PolicyVersionRow = {
  entity: Entity;
  /** 1 for the oldest record, the count of records for the newest. */
  number: number;
  state: PolicyState;
  /** The record the server reads as the policy: the newest `active: true`. */
  current: boolean;
  mode: string | null;
  startAt: string | null;
  endAt: string | null;
  /** When the owner activated it (older records: when it was created). */
  activatedAt: string;
  /** When a later version replaced it: the deactivation's update time. */
  replacedAt: string | null;
};

const text = (v: unknown) => (typeof v === "string" && v ? v : null);
const instant = (v: string | null) => (v === null ? NaN : Date.parse(v));

/**
 * The policy records as versions, newest first. Only the newest record
 * with `active: true` is the current one; it is scheduled before its
 * start, expired from its end and active in between. Every other record
 * was replaced.
 */
export function policyVersionRows(
  items: readonly Entity[],
  now: number,
): PolicyVersionRow[] {
  const sorted = [...items].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  );
  const currentId = sorted.find((e) => e.data.active === true)?.id;
  return sorted.map((entity, index) => {
    const d = entity.data;
    const startAt = text(d.startAt),
      endAt = text(d.endAt);
    const start = instant(startAt),
      end = instant(endAt);
    const current = entity.id === currentId;
    const state: PolicyState = !current
      ? "replaced"
      : start > now
        ? "scheduled"
        : start <= now && end > now
          ? "active"
          : "expired";
    return {
      entity,
      number: sorted.length - index,
      state,
      current,
      mode: text(d.mode),
      startAt,
      endAt,
      activatedAt: text(d.activatedAt) ?? entity.createdAt,
      replacedAt: d.active === false ? entity.updatedAt : null,
    };
  });
}

const TONE: Record<PolicyState, "success" | "blue" | "warning" | "neutral"> = {
  active: "success",
  scheduled: "blue",
  expired: "warning",
  replaced: "neutral",
};

function StateBadge({ state, locale }: { state: PolicyState; locale: Locale }) {
  return <Badge tone={TONE[state]}>{statusLabel(locale, state)}</Badge>;
}

/** An instant as a <time>, or "—" when there is none. */
function Time({
  iso,
  locale,
  timezone,
  dateOnly = false,
}: {
  iso: string | null;
  locale: Locale;
  timezone: string;
  dateOnly?: boolean;
}) {
  if (iso === null || Number.isNaN(Date.parse(iso))) return <>—</>;
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(dateOnly ? {} : { timeStyle: "short" as const }),
    timeZone: timezone,
  });
  return <time dateTime={iso}>{format.format(new Date(iso))}</time>;
}

function Period({
  row,
  locale,
  timezone,
  dateOnly = false,
}: {
  row: PolicyVersionRow;
  locale: Locale;
  timezone: string;
  dateOnly?: boolean;
}) {
  return (
    <>
      <Time iso={row.startAt} locale={locale} timezone={timezone} dateOnly={dateOnly} />
      {" – "}
      <Time iso={row.endAt} locale={locale} timezone={timezone} dateOnly={dateOnly} />
    </>
  );
}

/** The versions table with the current version summarised above it. */
export function PolicyVersions({ items }: { items: Entity[] }) {
  const { locale, project, t } = useWorkspace();
  const words = marketingText(locale).policy;
  const [now] = useState(() => Date.now());
  const [open, setOpen] = useState<PolicyVersionRow | null>(null);
  const rows = policyVersionRows(items, now);
  const current = rows.find((row) => row.current);
  const tz = project.timezone;
  const mode = (row: PolicyVersionRow) => (row.mode ? modeLabel(row.mode, t) : "—");
  return (
    <div className="policy-versions">
      {current ? (
        <div className="policy-current">
          <dl className="detail-grid">
            <dt>{words.current}</dt>
            <dd>
              v{current.number} <StateBadge state={current.state} locale={locale} />
            </dd>
            <dt>{words.mode}</dt>
            <dd>{mode(current)}</dd>
            <dt>{words.valid}</dt>
            <dd>
              <Period row={current} locale={locale} timezone={tz} />
            </dd>
            <dt>{words.activatedAt}</dt>
            <dd>
              <Time iso={current.activatedAt} locale={locale} timezone={tz} />
            </dd>
          </dl>
          <Button variant="outline" size="sm" onClick={() => setOpen(current)}>
            {words.open(current.number)}
          </Button>
        </div>
      ) : (
        <p className="panel-note">{words.noCurrent}</p>
      )}
      {rows.length > (current ? 1 : 0) && (
        <details className="policy-history">
          <summary>{words.history(rows.length)}</summary>
          <div className="table-wrap">
            <table className="table-plain-head">
              <caption>{words.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.version}</th>
                  <th scope="col">{words.mode}</th>
                  <th scope="col">{words.status}</th>
                  <th scope="col">{words.valid}</th>
                  <th scope="col">{words.activatedAt}</th>
                  <th scope="col">{words.replacedAt}</th>
                  <th scope="col">
                    <span className="sr-only">{t("review")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.entity.id}
                    aria-current={row.current ? "true" : undefined}
                  >
                    <th scope="row">v{row.number}</th>
                    <td>{mode(row)}</td>
                    <td>
                      <StateBadge state={row.state} locale={locale} />
                    </td>
                    <td>
                      <Period row={row} locale={locale} timezone={tz} dateOnly />
                    </td>
                    <td>
                      <Time iso={row.activatedAt} locale={locale} timezone={tz} />
                    </td>
                    <td>
                      <Time iso={row.replacedAt} locale={locale} timezone={tz} />
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={words.open(row.number)}
                        onClick={() => setOpen(row)}
                      >
                        <ArrowRight aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {open && (
        <PolicyVersionDetail
          row={open}
          words={marketingText(locale)}
          locale={locale}
          timezone={tz}
          mode={mode(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

const list = (v: unknown, names?: Record<string, string>) =>
  Array.isArray(v) && v.length
    ? v.map((item) => names?.[String(item)] ?? String(item)).join(", ")
    : "—";
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** One version, read-only; the AI budget lives in Settings → AI & budget. */
function PolicyVersionDetail({
  row,
  words,
  locale,
  timezone,
  mode,
  onClose,
}: {
  row: PolicyVersionRow;
  words: MarketingText;
  locale: Locale;
  timezone: string;
  mode: string;
  onClose: () => void;
}) {
  const p = words.policy;
  const d = row.entity.data;
  const interval = count(d.minIntervalMinutes);
  const quietStart = count(d.quietStart),
    quietEnd = count(d.quietEnd);
  return (
    <Modal title={p.detailTitle(row.number)} onClose={onClose}>
      <dl className="detail-grid">
        <dt>{p.status}</dt>
        <dd>
          <StateBadge state={row.state} locale={locale} />
        </dd>
        <dt>{p.mode}</dt>
        <dd>{mode}</dd>
        <dt>{p.validFrom}</dt>
        <dd>
          <Time iso={row.startAt} locale={locale} timezone={timezone} />
        </dd>
        <dt>{p.validUntil}</dt>
        <dd>
          <Time iso={row.endAt} locale={locale} timezone={timezone} />
        </dd>
        <dt>{p.activatedAt}</dt>
        <dd>
          <Time iso={row.activatedAt} locale={locale} timezone={timezone} />
        </dd>
        <dt>{p.replacedAt}</dt>
        <dd>
          <Time iso={row.replacedAt} locale={locale} timezone={timezone} />
        </dd>
        <dt>{p.channels}</dt>
        <dd>{list(d.channels)}</dd>
        <dt>{p.contentTypes}</dt>
        <dd>{list(d.contentTypes, words.contentTypes)}</dd>
        <dt>{p.allowedOrigins}</dt>
        <dd>{list(d.allowedOrigins)}</dd>
        <dt>{p.maxPerDay}</dt>
        <dd>{count(d.maxPerDay) ?? "—"}</dd>
        <dt>{p.minInterval}</dt>
        <dd>{interval === null ? "—" : p.minutes(interval)}</dd>
        <dt>{p.quietHours}</dt>
        <dd>
          {quietStart === null || quietEnd === null
            ? "—"
            : `${quietStart}:00–${quietEnd}:00 (${timezone})`}
        </dd>
      </dl>
      <Alert>
        {p.budgetNote}{" "}
        <AppLink href="/settings?section=ai">{p.budgetLink}</AppLink>.
      </Alert>
    </Modal>
  );
}
