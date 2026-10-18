"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlarmClock,
  ArrowRight,
  Inbox as InboxIcon,
  Timer,
  TriangleAlert,
  UserRoundX,
} from "lucide-react";
import { useResource, when } from "@/lib/api";
import { Badge, Button, Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { Metric } from "@/platform/ui/metric";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  slaState,
  supportPath,
  type Inbox,
  type Summary,
  type Ticket,
} from "./api";
import { supportText, type SupportText } from "./labels";
import { durationLabel, statsQuery } from "./stats";
import { SLA_TONE } from "./ticket";

/** The days of the new-tickets chart. */
const CHART_DAYS = 14;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where an old support link goes: notifications still point at
 * `/support?ticket=<id>`, and the inbox now lives one level down. Returns the
 * path relative to the module root, or null when no ticket id is given.
 */
export function ticketRedirect(search: string): string | null {
  const id = new URLSearchParams(search).get("ticket");
  return id && UUID.test(id) ? `tickets?ticket=${id}` : null;
}

type Stats = {
  firstResponse: { count: number; medianMinutes: number | null };
  volume: { total: number; byDay: Record<string, number> };
};

/** The earliest due time that is still pending, as the server orders by. */
function pendingDue(ticket: Ticket): string | null {
  const due = [
    ticket.firstRespondedAt ? null : ticket.firstResponseDueAt,
    ticket.resolvedAt ? null : ticket.resolutionDueAt,
  ].filter((v): v is string => Boolean(v));
  return due.sort()[0] ?? null;
}

/** One ticket as a link into the inbox, with its status and SLA state. */
function TicketLink({
  ticket,
  showDue,
}: {
  ticket: Ticket;
  showDue?: boolean;
}) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const sla = slaState(ticket);
  const due = pendingDue(ticket);
  return (
    <li>
      <AppLink
        className="support-row"
        href={`${shell.hrefOf("support-tickets")}?ticket=${encodeURIComponent(ticket.id)}`}
      >
        <span className="support-row-title">
          #{ticket.number} {ticket.subject}
        </span>
        <span className="support-row-meta">
          {ticket.contact?.name ?? ticket.contact?.email ?? "—"}
          {showDue &&
            ` · ${due ? `${t.overview.due} ${when(due, locale, project.timezone)}` : t.overview.noDue}`}
        </span>
        <span className="support-row-badges">
          <Badge>
            {t.status[ticket.status as keyof SupportText["status"]]}
          </Badge>
          {sla !== "ok" && sla !== "done" && (
            <Badge tone={SLA_TONE[sla]}>{t.sla[sla]}</Badge>
          )}
        </span>
      </AppLink>
    </li>
  );
}

function TicketCard({
  title,
  path,
  empty,
  showDue,
}: {
  title: string;
  path: string;
  empty: string;
  showDue?: boolean;
}) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const list = useResource<{ items: Ticket[] }>(path);
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        <AppLink className="text-link" href={shell.hrefOf("support-tickets")}>
          {t.overview.allTickets}
          <ArrowRight aria-hidden />
        </AppLink>
      </div>
      <div className="support-overview-body">
        {list.loading ? (
          <Skeleton />
        ) : list.error ? (
          <ResourceError error={list.error} retry={list.refresh} />
        ) : list.data?.items.length ? (
          <ul className="support-rows">
            {list.data.items.map((ticket) => (
              <TicketLink key={ticket.id} ticket={ticket} showDue={showDue} />
            ))}
          </ul>
        ) : (
          <Empty title={empty} />
        )}
      </div>
    </section>
  );
}

function InboxCard({ summary }: { summary: Summary | null }) {
  const { project, locale } = useWorkspace();
  const t = supportText(locale);
  const inboxes = useResource<{ items: Inbox[] }>(
    supportPath(project.id, "/inboxes"),
  );
  const open = summary?.openByInbox ?? {};
  const live = (inboxes.data?.items ?? [])
    .filter((inbox) => !inbox.archivedAt)
    .sort(
      (a, b) =>
        (open[b.id] ?? 0) - (open[a.id] ?? 0) || a.name.localeCompare(b.name),
    );
  return (
    <section className="panel" aria-label={t.overview.inboxes}>
      <div className="panel-head">
        <h2>{t.overview.inboxes}</h2>
      </div>
      <div className="support-overview-body">
        {inboxes.loading ? (
          <Skeleton />
        ) : inboxes.error ? (
          <ResourceError error={inboxes.error} retry={inboxes.refresh} />
        ) : live.length ? (
          <ul className="support-rows">
            {live.map((inbox) => (
              <li key={inbox.id} className="support-inbox-row">
                <strong>{inbox.name}</strong>
                {inbox.channels.map((c) => (
                  <Badge key={c}>{c}</Badge>
                ))}
                <span className="support-inbox-count">
                  {summary
                    ? t.overview.openCount.replace(
                        "{n}",
                        String(open[inbox.id] ?? 0),
                      )
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t.overview.inboxesEmpty} />
        )}
      </div>
    </section>
  );
}

/** "10-18" style label of a YYYY-MM-DD day, in the viewer's locale. */
const dayLabel = (day: string, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

function VolumeCard({
  stats,
}: {
  stats: ReturnType<typeof useResource<Stats>>;
}) {
  const { locale } = useWorkspace();
  const t = supportText(locale);
  const byDay = stats.data?.volume.byDay ?? {};
  // The server counts calendar days, so a range of 14 days can span 15 of them.
  const days = Object.keys(byDay).sort().slice(-CHART_DAYS);
  const counts = days.map((day) => byDay[day] ?? 0);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const max = Math.max(0, ...counts);
  const busiest = days[counts.indexOf(max)];
  return (
    <section className="panel" aria-label={t.overview.perDay}>
      <div className="panel-head">
        <h2>{t.overview.perDay}</h2>
      </div>
      <div className="support-overview-body">
        {stats.loading ? (
          <Skeleton />
        ) : stats.error ? (
          <ResourceError error={stats.error} retry={stats.refresh} />
        ) : total > 0 && busiest ? (
          <>
            <div
              className="support-bars"
              role="img"
              aria-label={t.overview.perDayLabel
                .replace("{n}", String(days.length))
                .replace("{total}", String(total))
                .replace("{day}", busiest)
                .replace("{max}", String(max))}
            >
              {days.map((day, i) => (
                <span
                  key={day}
                  className="support-bar"
                  title={`${day}: ${counts[i]}`}
                  style={{ height: `${Math.round((counts[i]! / max) * 100)}%` }}
                />
              ))}
            </div>
            <div className="support-bars-axis" aria-hidden>
              <span>{dayLabel(days[0]!, locale)}</span>
              <span>{dayLabel(days.at(-1)!, locale)}</span>
            </div>
          </>
        ) : (
          <Empty title={t.overview.perDayEmpty} />
        )}
      </div>
    </section>
  );
}

/**
 * The root of the Support module. An old notification link
 * (`/support?ticket=<id>`) is decided during render from the router's search
 * params, not from window.location, which a client navigation updates only on
 * commit: it shows a skeleton, asks for nothing and is replaced by the inbox.
 */
export function SupportOverview() {
  const shell = useShell();
  const router = useRouter();
  const target = ticketRedirect(useSearchParams()?.toString() ?? "");
  const href = target
    ? `${shell.hrefOf("support-tickets")}${target.slice(target.indexOf("?"))}`
    : null;
  useEffect(() => {
    if (href) router.replace(href);
  }, [href]);
  return href ? <Skeleton /> : <OverviewContent />;
}

/** What needs attention, then the inbox. */
function OverviewContent() {
  const { project, locale, t: word } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const [now] = useState(() => new Date());
  const summary = useResource<Summary>(supportPath(project.id, "/summary"));
  const stats = useResource<Stats>(
    supportPath(project.id, `/stats?${statsQuery(CHART_DAYS, null, now)}`),
  );
  const s = summary.data;
  const count = (n: number | undefined) => (s ? String(n) : "—");
  return (
    <div className="support-page">
      <PageHead
        title={t.support}
        description={t.supportIntro}
        eyebrow={word("moduleEyebrow")}
      >
        <Button asChild variant="outline">
          <AppLink href={shell.hrefOf("support-tickets")}>
            {t.overview.allTickets}
          </AppLink>
        </Button>
      </PageHead>
      <ResourceError error={summary.error} retry={summary.refresh} />
      <div className="metrics-strip metrics-five">
        <Metric icon={InboxIcon} label={t.home.open} amount={count(s?.open)} />
        <Metric
          icon={UserRoundX}
          label={t.home.unassigned}
          amount={count(s?.unassigned)}
        />
        <Metric
          icon={AlarmClock}
          label={t.home.atRisk}
          amount={count(s?.atRisk)}
        />
        <Metric
          icon={TriangleAlert}
          label={t.home.breached}
          amount={count(s?.breached)}
        />
        <Metric
          icon={Timer}
          label={t.overview.firstResponse}
          amount={
            stats.data
              ? durationLabel(stats.data.firstResponse.medianMinutes)
              : "—"
          }
        />
      </div>
      <div className="overview-columns">
        <TicketCard
          title={t.overview.urgent}
          path={supportPath(project.id, "/tickets?sort=sla&limit=5")}
          empty={t.overview.urgentEmpty}
          showDue
        />
        <InboxCard summary={s} />
      </div>
      <div className="overview-columns">
        <VolumeCard stats={stats} />
        <TicketCard
          title={t.overview.mine}
          path={supportPath(
            project.id,
            "/tickets?view=mine&openOnly=true&limit=5",
          )}
          empty={t.overview.mineEmpty}
        />
      </div>
    </div>
  );
}
