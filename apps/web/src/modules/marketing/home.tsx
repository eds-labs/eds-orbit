"use client";
import { useMemo } from "react";
import { Bot, CalendarClock } from "lucide-react";
import {
  collectionPath,
  usd,
  useResource,
  value,
  when,
  type Entity,
} from "@/lib/api";
import { Badge, Empty, Skeleton, Status } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useAttention } from "@/platform/shell/attention";
import { useShell } from "@/platform/shell/shell-context";
import { ResourceError, useCollection } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import {
  runStatusText,
  type ActivityRun,
  type AgentActivity,
} from "./agent-activity";
import type { UpcomingPost } from "./assignments";
import { nextPosts } from "./overview";

/** How many upcoming posts the card lists. */
const POSTS = 3;
const DAY = 24 * 3600 * 1000;
// Missions in these states count as active, as on the overview.
const ACTIVE = ["active", "running", "queued"];
const RUN_TONE: Record<string, "blue" | "success" | "warning" | "danger"> = {
  planned: "blue",
  running: "blue",
  done: "success",
  partial: "warning",
  failed: "danger",
};

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

/** One row of the next posts. */
type PostRow = { id: string; at: string; title: string; status: string };

/**
 * The marketing card of the project home (UI restructure §5.2): the agents'
 * current run while Orbit Agents is on, the next three posts, and the
 * counts of active missions and open approvals. The full overview is one
 * click away; the card renders nothing while the module answers 404.
 */
export function MarketingHomeCard() {
  const { project, revision, t } = useWorkspace();
  const shell = useShell();
  const attention = useAttention();
  // One instant per load, so the post window stays put between renders.
  const now = useMemo(() => Date.now(), [project.id, revision]);
  const missions = useCollection("missions");
  const activity = useResource<AgentActivity>(
    collectionPath(project.id, `agent-activity?revision=${revision}`),
  );
  if (missions.error?.status === 404) return null;
  const active = missions.data
    ? String(
        missions.data.items.filter((m) =>
          ACTIVE.includes(String(m.data.status)),
        ).length,
      )
    : "—";
  const approvals =
    attention.data && !attention.error
      ? String(attention.data.counts.approvals ?? 0)
      : "—";
  return (
    <HomeCard
      id="home-card-marketing"
      title={t("marketingHomeTitle")}
      href={shell.hrefOf("marketing-overview")}
      className="marketing-home"
    >
      {/* A 404 means Orbit Agents is off: no run to show. */}
      {activity.error?.status !== 404 &&
        (activity.loading ? (
          <Skeleton />
        ) : activity.error ? (
          <ResourceError error={activity.error} retry={activity.refresh} />
        ) : (
          activity.data && <CurrentRun run={activity.data.runs[0] ?? null} />
        ))}
      <NextPosts now={now} />
      <p className="home-card-counts">
        <span>
          <strong>{active}</strong> {t("activeMissionsCount")}
        </span>
        <span>
          <strong>{approvals}</strong> {t("openApprovalsCount")}
        </span>
      </p>
    </HomeCard>
  );
}

/** The run the agents work on, or their latest: state, steps and cost. */
function CurrentRun({ run }: { run: ActivityRun | null }) {
  const { project, locale, t } = useWorkspace();
  const de = locale === "de";
  if (!run)
    return (
      <div className="home-run">
        <span className="home-run-icon" aria-hidden="true">
          <Bot />
        </span>
        <span className="home-run-text">
          <strong>{t("noRunYet")}</strong>
        </span>
      </div>
    );
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: project.timezone,
  }).format(new Date());
  const done = run.steps.filter((step) => step.status === "done").length;
  const detail = [
    run.date === today
      ? t("todaysRun")
      : `${t("lastRun")} ${when(run.plannedAt ?? run.updatedAt, locale, project.timezone)}`,
    fill(t("runSteps"), {
      done: String(done),
      total: String(run.steps.length),
    }),
    usd(run.costMicros),
  ].join(" · ");
  return (
    <div className="home-run">
      <span className="home-run-icon" aria-hidden="true">
        <Bot />
      </span>
      <span className="home-run-text">
        <strong>{run.assignmentName ?? "—"}</strong>
        <span>{detail}</span>
      </span>
      <Badge tone={RUN_TONE[run.status] ?? "neutral"}>
        {runStatusText(run.status, de)}
      </Badge>
    </div>
  );
}

/**
 * The next three posts of the coming week: the agents' assignment posts,
 * else (Orbit Agents off or the route failed) the scheduled publications.
 */
function NextPosts({ now }: { now: number }) {
  const { project, revision, locale, t } = useWorkspace();
  const posts = useResource<{ items: UpcomingPost[] }>(
    collectionPath(project.id, `assignment-posts?revision=${revision}`),
  );
  const fromAgents = posts.data !== null;
  // Asked for only once the assignment posts turned out to be unavailable.
  const publications = useResource<{ items: Entity[] }>(
    fromAgents || posts.loading
      ? null
      : collectionPath(project.id, `publications?revision=${revision}`),
  );
  const loading =
    posts.loading || (!fromAgents && !publications.data && !publications.error);
  const rows: PostRow[] = fromAgents
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
          status: p.status,
        }))
    : nextPosts(publications.data?.items ?? ([] as Entity[]), 7, now).map(
        (p) => ({
          id: p.id,
          at: String(p.data.scheduledAt),
          title: value(p, "channel"),
          status: String(p.data.status),
        }),
      );
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="home-card-list">
      <h3>{t("nextPosts")}</h3>
      {loading ? (
        <Skeleton />
      ) : !fromAgents && publications.error ? (
        <ResourceError
          error={publications.error}
          retry={publications.refresh}
        />
      ) : rows.length ? (
        <ul className="home-posts">
          {rows.slice(0, POSTS).map((row) => (
            <li key={row.id}>
              <CalendarClock aria-hidden />
              <span className="home-post-when">
                {when(row.at, locale, project.timezone)}
              </span>
              <span className="home-post-title">{row.title}</span>
              <Status value={row.status} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={t("nextSevenDaysEmpty")} icon={CalendarClock} />
      )}
    </div>
  );
}
