"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { useResource, usd } from "@/lib/api";
import { Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { supportPath, type Inbox } from "./api";
import { supportText } from "./labels";

// Support statistics (WP5.7): volume, response and resolution times,
// backlog, reopen rate, SLA, AI and cost, for a range and an inbox.

/** The query of the last `days` days, optionally for one inbox. */
export function statsQuery(
  days: number,
  inboxId: string | null,
  now = new Date(),
) {
  const params = new URLSearchParams({
    from: new Date(now.getTime() - days * 86_400_000).toISOString(),
    to: now.toISOString(),
  });
  if (inboxId) params.set("inboxId", inboxId);
  return params.toString();
}

/** Minutes as minutes, hours or days. */
export function durationLabel(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round((minutes / 60) * 10) / 10} h`;
  return `${Math.round((minutes / 1440) * 10) / 10} d`;
}

export function percent(rate: number | null | undefined) {
  return rate === null || rate === undefined
    ? "—"
    : `${Math.round(rate * 100)} %`;
}

type Stats = {
  volume: { total: number; byChannel: Record<string, number> };
  firstResponse: { count: number; medianMinutes: number | null };
  resolution: { count: number; medianMinutes: number | null };
  backlog: { open: number; ages: Record<string, number> };
  reopenRate: number | null;
  sla: { attainment: number | null; breaches: number };
  ai: {
    drafts: number;
    acceptanceRate: number | null;
    sentUnchanged: number;
    sentEdited: number;
    handoffs: number;
    costMicros: number;
    costPerTicketMicros: number | null;
  };
};

export function SupportStats() {
  const { project, locale } = useWorkspace();
  const t = supportText(locale);
  const [days, setDays] = useState(30);
  const [inboxId, setInboxId] = useState<string | null>(null);
  const inboxes = useResource<{ items: Inbox[] }>(
    supportPath(project.id, "/inboxes"),
  );
  const [now] = useState(() => new Date());
  const query = statsQuery(days, inboxId, now);
  const stats = useResource<Stats>(supportPath(project.id, `/stats?${query}`));
  const s = stats.data;
  const card = (label: string, value: string) => (
    <div className="support-stat" key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <div className="support-page">
      <PageHead title={t.stats.title} description={t.stats.intro} />
      <div className="support-filters">
        <select
          aria-label={t.stats.range}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {[7, 30, 90].map((d) => (
            <option key={d} value={d}>
              {t.stats.lastDays.replace("{n}", String(d))}
            </option>
          ))}
        </select>
        <select
          aria-label={t.stats.inbox}
          value={inboxId ?? ""}
          onChange={(e) => setInboxId(e.target.value || null)}
        >
          <option value="">{t.stats.allInboxes}</option>
          {(inboxes.data?.items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <a
          className="button button-outline button-sm"
          href={`/api${supportPath(project.id, `/stats/export?${query}`)}`}
        >
          <Download aria-hidden size={16} /> CSV
        </a>
      </div>
      {stats.loading ? (
        <Loading />
      ) : stats.error || !s ? (
        <ResourceError error={stats.error} retry={stats.refresh} />
      ) : (
        <dl className="support-stats">
          {card(t.stats.tickets, String(s.volume.total))}
          {card(
            t.stats.firstResponse,
            durationLabel(s.firstResponse.medianMinutes),
          )}
          {card(t.stats.resolution, durationLabel(s.resolution.medianMinutes))}
          {card(t.stats.backlog, String(s.backlog.open))}
          {card(t.stats.reopenRate, percent(s.reopenRate))}
          {card(t.stats.slaAttainment, percent(s.sla.attainment))}
          {card(t.stats.breaches, String(s.sla.breaches))}
          {card(t.stats.drafts, String(s.ai.drafts))}
          {card(t.stats.acceptance, percent(s.ai.acceptanceRate))}
          {card(
            t.stats.unchanged,
            `${s.ai.sentUnchanged} / ${s.ai.sentUnchanged + s.ai.sentEdited}`,
          )}
          {card(t.stats.handoffs, String(s.ai.handoffs))}
          {card(t.stats.aiCost, usd(s.ai.costMicros))}
          {card(t.stats.costPerTicket, usd(s.ai.costPerTicketMicros ?? 0))}
        </dl>
      )}
    </div>
  );
}
