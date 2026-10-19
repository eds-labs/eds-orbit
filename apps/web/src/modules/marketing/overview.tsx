"use client";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  CircleCheck,
  Eye,
  FileText,
  Link2,
  Pause,
  Plus,
  ShieldCheck,
  Target,
  Send,
  Wallet,
} from "lucide-react";
import {
  collectionPath,
  usd,
  useResource,
  value,
  when,
  type Dashboard,
  type Entity,
} from "@/lib/api";
import { modeLabel, type Locale } from "@/lib/i18n";
import { actionLabel, actionOrder, blockerReason } from "@/lib/readiness-text";
import {
  Badge,
  Button,
  Empty,
  Loading,
  Skeleton,
  Status,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";
import { useAttention } from "@/platform/shell/attention";
import { Metric } from "@/platform/ui/metric";
import {
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { AgentActivityPanel } from "./agent-activity";
import type { UpcomingPost } from "./assignments";
import { MissionEditor } from "./work";

const DAY = 24 * 3600 * 1000;
/** How many upcoming posts the overview lists. */
const NEXT_LIMIT = 6;
// A publication in one of these states is not going out any more.
const FINISHED = [
  "published",
  "published_test",
  "canceled",
  "failed",
  "vetoed",
];

/**
 * The start of the budget month that contains `now`, as an ISO string: the
 * first of the month at 00:00 UTC, the rule the server's monthly limit counts
 * from (`budgetMonthStart` in apps/api/src/platform/ai/budget.ts).
 */
export function monthStart(now: number): string {
  const at = new Date(now);
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1),
  ).toISOString();
}

/** Publications that went out in the last `days` days. */
export function publishedInLastDays(
  publications: Entity[],
  days: number,
  now: number,
) {
  return publications.filter((p) => {
    const at = Date.parse(String(p.data.scheduledAt));
    return p.data.status === "published" && at > now - days * DAY && at <= now;
  }).length;
}

/** Publications still to go out within the next `days` days, soonest first. */
export function nextPosts(publications: Entity[], days: number, now: number) {
  return publications
    .filter((p) => {
      const at = Date.parse(String(p.data.scheduledAt));
      return (
        !FINISHED.includes(String(p.data.status)) &&
        at >= now &&
        at <= now + days * DAY
      );
    })
    .sort((a, b) =>
      String(a.data.scheduledAt).localeCompare(String(b.data.scheduledAt)),
    );
}

const brief = (text: string, max = 120) =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

/** One row of `/ai-cost`; `reservedMicros` includes reservations in flight. */
type CostRow = {
  settledMicros: string;
  reservedMicros: string;
  unknownMicros: string;
};

/**
 * The month's AI spend in micros as the monthly limit counts it: settled plus
 * reserved, in-flight and unclear reservations. `pending` is the part not yet
 * settled. Null while or when unknown.
 */
function monthSpend(
  cost: { rows: CostRow[] } | null,
): { total: number; pending: number } | null {
  if (!cost) return null;
  let settled = 0;
  let pending = 0;
  for (const row of cost.rows) {
    settled += Number(row.settledMicros);
    pending += Number(row.reservedMicros) + Number(row.unknownMicros);
  }
  return { total: settled + pending, pending };
}

/** One row of the next-posts panel. */
type NextRow = {
  id: string;
  at: string;
  title: string;
  detail: string;
  status: string;
  href: string;
};

function NextPosts({
  now,
  publications,
}: {
  now: number;
  publications: Entity[];
}) {
  const { project, revision, locale, t } = useWorkspace();
  const posts = useResource<{ items: UpcomingPost[] }>(
    collectionPath(project.id, `assignment-posts?revision=${revision}`),
  );
  // A route that answers 404 (Orbit Agents off) or fails has no posts to show:
  // the plain publications stand in for it.
  const fromAgents = posts.data !== null;
  const loading = posts.loading;
  const rows: NextRow[] = fromAgents
    ? posts
        .data!.items.filter((p) => {
          const at = Date.parse(p.scheduledAt);
          return at >= now && at <= now + 7 * DAY;
        })
        .map((p) => ({
          id: p.id,
          at: p.scheduledAt,
          title: [p.channelName ?? p.channel, p.assignmentName]
            .filter(Boolean)
            .join(" · "),
          detail: brief(p.excerpt),
          status: p.status,
          href: "/approvals",
        }))
    : nextPosts(publications, 7, now).map((p) => ({
        id: p.id,
        at: String(p.data.scheduledAt),
        title: value(p, "channel"),
        detail: "",
        status: String(p.data.status),
        href: "/calendar",
      }));
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="panel next-posts">
      <div className="panel-head">
        <h2>{t("nextSevenDays")}</h2>
        <AppLink
          className="text-link"
          href={fromAgents ? "/approvals" : "/calendar"}
        >
          {t("viewAll")}
          <ArrowRight />
        </AppLink>
      </div>
      {loading ? (
        <Skeleton />
      ) : rows.length ? (
        <div className="data-list">
          {rows.slice(0, NEXT_LIMIT).map((row) => (
            <AppLink className="data-row" key={row.id} href={row.href}>
              <CalendarClock />
              <div>
                <strong>{row.title}</strong>
                <p>
                  {when(row.at, locale, project.timezone)}
                  {row.detail && ` · ${row.detail}`}
                </p>
              </div>
              <Status value={row.status} />
            </AppLink>
          ))}
        </div>
      ) : (
        <Empty
          title={t("nextSevenDaysEmpty")}
          description={t("nextSevenDaysHint")}
          icon={CalendarClock}
        />
      )}
    </section>
  );
}

/** The marketing overview, the root of the Marketing module. */
export function MarketingOverview() {
  const { project, t, locale, revision, canEdit } = useWorkspace();
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const missions = useCollection("missions");
  // Ruling R27: the number of the Approvals badge and the home card.
  const attention = useAttention();
  const approvals =
    attention.data && !attention.error
      ? String(attention.data.counts.approvals ?? 0)
      : "—";
  // One instant per load, so the cost request keeps its path between renders.
  const now = useMemo(() => Date.now(), [project.id, revision]);
  // The AI cost route is for editors; a viewer's budget stays unknown.
  const cost = useResource<{ rows: CostRow[] }>(
    canEdit
      ? collectionPath(
          project.id,
          `ai-cost?from=${encodeURIComponent(monthStart(now))}&to=${encodeURIComponent(new Date(now).toISOString())}`,
        )
      : null,
  );
  const [create, setCreate] = useState(false);
  const d = dashboard.data;
  const spent = monthSpend(cost.data);
  const limit = d?.budget.monthlyLimitMicros ?? null;
  return (
    <>
      <PageHead
        title="Marketing"
        description={t("marketingOverviewHint")}
        eyebrow={t("moduleEyebrow")}
      >
        <Button asChild variant="outline">
          <AppLink href="/content">
            <FileText data-icon="inline-start" />
            {t("createContent")}
          </AppLink>
        </Button>
        {canEdit && (
          <Button onClick={() => setCreate(true)}>
            <Plus data-icon="inline-start" />
            {t("newMission")}
          </Button>
        )}
      </PageHead>
      <ResourceError error={dashboard.error} retry={dashboard.refresh} />
      {dashboard.loading ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="mode-band">
              <div className="mode-icon">
                {d.project.paused ? <Pause /> : <Eye />}
              </div>
              <div>
                <h2>
                  {d.project.paused
                    ? t("paused")
                    : modeLabel(d.project.mode, t)}
                </h2>
                <p className="mode-desktop-copy">
                  {d.project.mode === "observe"
                    ? t("observeHint")
                    : locale === "de"
                      ? "Jede Aktion wird vor Ausführung gegen das aktuelle Mandat geprüft."
                      : "Every action is checked against the current mandate before execution."}
                </p>
                <p className="mode-mobile-copy">
                  {d.project.paused
                    ? locale === "de"
                      ? "Alle Aktionen pausiert."
                      : "All actions paused."
                    : d.project.mode === "observe"
                      ? locale === "de"
                        ? "Externes Publizieren ist aus."
                        : "External publishing is off."
                      : locale === "de"
                        ? "Mandat wird vor Ausführung geprüft."
                        : "Mandate checked before execution."}
                </p>
              </div>
              <Button asChild variant="outline">
                <AppLink href="/settings">{t("reviewSetup")}</AppLink>
              </Button>
            </div>
            <div className="metrics-strip metrics-four">
              <Metric
                icon={Target}
                label={t("activeMissions")}
                amount={
                  missions.data
                    ? String(
                        missions.data.items.filter((mission) =>
                          ["active", "running", "queued"].includes(
                            String(mission.data.status),
                          ),
                        ).length,
                      )
                    : "—"
                }
              />
              <Metric
                icon={ShieldCheck}
                label={t("openApprovals")}
                amount={approvals}
              />
              <Metric
                icon={Send}
                label={t("published7d")}
                amount={String(publishedInLastDays(d.publications, 7, now))}
              />
              <Metric
                icon={Wallet}
                label={t("aiBudgetMonth")}
                amount={spent ? usd(spent.total) : "—"}
                detail={
                  spent
                    ? [
                        limit === null
                          ? t("aiBudgetNoLimit")
                          : `${t("aiBudgetOf")} ${usd(limit)}`,
                        spent.pending > 0 &&
                          `${t("aiBudgetIncl")} ${usd(spent.pending)} ${t("aiBudgetReserved")}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined
                }
              />
            </div>
            <AgentActivityPanel />
            <NextPosts now={now} publications={d.publications} />
            <div className="overview-columns">
              <section className="panel">
                <div className="panel-head">
                  <h2>{t("missionControl")}</h2>
                  <AppLink className="text-link" href="/missions">
                    {t("viewAll")}
                    <ArrowRight />
                  </AppLink>
                </div>
                {missions.data?.items.length ? (
                  <div className="data-list">
                    {missions.data.items.slice(0, 4).map((m) => (
                      <AppLink className="data-row" key={m.id} href="/missions">
                        <Target />
                        <div>
                          <strong>{value(m, "title")}</strong>
                          <p>{value(m, "goal")}</p>
                        </div>
                        <Status value={m.data.status} />
                      </AppLink>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title={t("startMission")}
                    description={t("missionHint")}
                    icon={Target}
                  >
                    {canEdit && (
                      <Button onClick={() => setCreate(true)}>
                        {t("createMission")}
                      </Button>
                    )}
                  </Empty>
                )}
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>{t("readiness")}</h2>
                  <Status value={d.readiness.state} />
                </div>
                <div className="readiness-list">
                  <Readiness
                    icon={CircleCheck}
                    label={t("projectCreated")}
                    status={t("complete")}
                    ready
                    href="/settings"
                  />
                  <Readiness
                    icon={FileText}
                    label={t("facts")}
                    status={
                      (d.counts.verifiedFacts ?? 0) > 0
                        ? t("complete")
                        : t("required")
                    }
                    ready={(d.counts.verifiedFacts ?? 0) > 0}
                    href="/knowledge"
                  />
                  <Readiness
                    icon={Link2}
                    label={t("channels")}
                    status={
                      (d.counts.connectedConnectors ?? 0) > 0
                        ? t("complete")
                        : t("notConfigured")
                    }
                    ready={(d.counts.connectedConnectors ?? 0) > 0}
                    href="/connectors"
                  />
                  <Readiness
                    icon={Wallet}
                    label={t("spend")}
                    status={
                      d.budget.dailyLimitMicros !== null
                        ? t("complete")
                        : t("notConfigured")
                    }
                    ready={d.budget.dailyLimitMicros !== null}
                    href="/settings"
                  />
                </div>
                {d.readiness.actions && (
                  <ActionReadinessList
                    actions={d.readiness.actions}
                    locale={locale}
                  />
                )}
              </section>
            </div>
          </>
        )
      )}
      {create && <MissionEditor onClose={() => setCreate(false)} />}
    </>
  );
}
function Readiness({
  icon: Icon,
  label,
  status,
  ready = false,
  href,
}: {
  icon: typeof Target;
  label: string;
  status: string;
  ready?: boolean;
  href: string;
}) {
  return (
    <AppLink href={href} className="readiness-row">
      <Icon />
      <span>{label}</span>
      <Badge tone={ready ? "success" : "neutral"}>{status}</Badge>
    </AppLink>
  );
}
function ActionReadinessList({
  actions,
  locale,
}: {
  actions: NonNullable<Dashboard["readiness"]["actions"]>;
  locale: Locale;
}) {
  const groups = [
    ["internal", locale === "de" ? "Intern" : "Internal"],
    ["external", locale === "de" ? "Extern" : "External"],
  ] as const;
  return (
    <div className="action-readiness">
      {groups.map(([effect, heading]) => (
        <div key={effect}>
          <h3>{heading}</h3>
          <ul>
            {actionOrder
              .filter((name) => actions[name]?.effect === effect)
              .map((name) => {
                const action = actions[name]!;
                return (
                  <li key={name} data-action={name}>
                    <div>
                      <strong>{actionLabel(locale, name)}</strong>
                      {action.blockers.length > 0 && (
                        <p>
                          {action.blockers
                            .map((code) => blockerReason(locale, code))
                            .join(" ")}
                        </p>
                      )}
                    </div>
                    <Status value={action.state} />
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}
