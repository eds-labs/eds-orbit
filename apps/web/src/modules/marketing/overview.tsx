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
import type { Locale } from "@/lib/i18n";
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
import {
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { AgentActivityPanel } from "./agent-activity";
import { openExceptions } from "./approval-lists";
import { approvalItems } from "./draft-cleanup";
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
 * The instant the current month began in `timeZone`, as an ISO string, so the
 * month's spend counts from the project's own midnight.
 */
export function monthStart(now: number, timeZone: string): string {
  const wall = (ms: number) => {
    const part = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<string, number>;
    return Date.UTC(
      part.year!,
      part.month! - 1,
      part.day!,
      part.hour!,
      part.minute!,
      part.second!,
    );
  };
  // The zone's offset at an instant: its wall clock read as UTC, minus the instant.
  const offset = (ms: number) => wall(ms) - Math.floor(ms / 1000) * 1000;
  const first = new Date(wall(now));
  const local = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  // A second pass covers a month whose first day has another offset than `local`.
  const guess = local - offset(local);
  return new Date(local - offset(guess)).toISOString();
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

/** The month's settled AI spend in micros; null while or when unknown. */
function settledSpend(
  cost: { rows: { settledMicros: string }[] } | null,
): number | null {
  return cost
    ? cost.rows.reduce((sum, row) => sum + Number(row.settledMicros), 0)
    : null;
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

/**
 * The marketing overview, the root of the Marketing module. `embedded` is the
 * project home's section until it gets its own cards (it keeps its heading).
 */
export function MarketingOverview({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { project, t, locale, revision, canEdit } = useWorkspace();
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const missions = useCollection("missions");
  const content = useCollection("content");
  // One instant per load, so the cost request keeps its path between renders.
  const now = useMemo(() => Date.now(), [project.id, revision]);
  // The AI cost route is for editors; a viewer's budget stays unknown.
  const cost = useResource<{ rows: { settledMicros: string }[] }>(
    canEdit
      ? collectionPath(
          project.id,
          `ai-cost?from=${encodeURIComponent(monthStart(now, project.timezone))}&to=${encodeURIComponent(new Date(now).toISOString())}`,
        )
      : null,
  );
  const [create, setCreate] = useState(false);
  const d = dashboard.data;
  const spent = settledSpend(cost.data);
  const limit = d?.budget.monthlyLimitMicros ?? null;
  return (
    <>
      <PageHead
        title={embedded ? t("heading") : "Marketing"}
        description={embedded ? t("subtitle") : t("marketingOverviewHint")}
        eyebrow={embedded ? undefined : t("moduleEyebrow")}
        as={embedded ? "h2" : "h1"}
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
                    : d.project.mode === "observe"
                      ? t("observe")
                      : d.project.mode}
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
                amount={
                  content.data
                    ? String(
                        approvalItems(content.data.items).length +
                          openExceptions(d.exceptions).length,
                      )
                    : "—"
                }
              />
              <Metric
                icon={Send}
                label={t("published7d")}
                amount={String(publishedInLastDays(d.publications, 7, now))}
              />
              <Metric
                icon={Wallet}
                label={t("aiBudgetMonth")}
                amount={spent !== null && limit !== null ? usd(spent) : "—"}
                detail={
                  spent === null
                    ? undefined
                    : limit === null
                      ? `${usd(spent)} ${t("aiBudgetSpent")} · ${t("aiBudgetNoLimit")}`
                      : `${t("aiBudgetOf")} ${usd(limit)}`
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
function Metric({
  icon: Icon,
  label,
  amount,
  detail,
}: {
  icon: typeof Target;
  label: string;
  amount: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">
        <Icon />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{amount}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
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
