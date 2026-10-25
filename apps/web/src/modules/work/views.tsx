"use client";
import { useRouter } from "next/navigation";
import { AlarmClock, CalendarClock, ListTodo, OctagonAlert } from "lucide-react";
import { useResource } from "@/lib/api";
import { Badge, Button, Empty, Loading, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { Metric } from "@/platform/ui/metric";
import { day, workPath, type Initiative, type Milestone, type MyTasks, type Overview } from "./api";
import { workText } from "./labels";
import { InitiativeCard } from "./initiatives";
import { TaskRow, useWorkLists } from "./shared";

// The module's overview, milestones, my tasks and the home card (plan
// §5.1, §5.4). Figures show "—" until they load.

export function WorkOverview() {
  const { project, locale, t: word } = useWorkspace();
  const shell = useShell();
  const t = workText(locale);
  const lists = useWorkLists();
  const overview = useResource<Overview>(workPath(project.id, "/overview"));
  const o = overview.data;
  const count = (n: number | undefined) => (o ? String(n) : "—");
  return (
    <div className="support-page">
      <PageHead title={t.module} description={t.intro} eyebrow={word("moduleEyebrow")}>
        <Button asChild variant="outline">
          <AppLink href={shell.hrefOf("work-board")}>{t.board}</AppLink>
        </Button>
        <Button asChild variant="outline">
          <AppLink href={shell.hrefOf("work-tasks")}>{t.allTasks}</AppLink>
        </Button>
      </PageHead>
      <ResourceError error={overview.error} retry={overview.refresh} />
      <div className="metrics-strip metrics-four">
        <Metric icon={ListTodo} label={t.metrics.open} amount={count(o?.counts.open)} href={shell.hrefOf("work-tasks")} />
        <Metric
          icon={AlarmClock}
          label={t.metrics.overdue}
          amount={count(o?.counts.overdue)}
          tone={o && o.counts.overdue > 0 ? "warning" : undefined}
        />
        <Metric icon={CalendarClock} label={t.metrics.dueThisWeek} amount={count(o?.counts.dueThisWeek)} />
        <Metric
          icon={OctagonAlert}
          label={t.metrics.blocked}
          amount={count(o?.counts.blocked)}
          tone={o && o.counts.blocked > 0 ? "warning" : undefined}
          href={`${shell.hrefOf("work-tasks")}?category=blocked`}
        />
      </div>
      <div className="work-columns-2">
        <section className="panel" aria-labelledby="work-active">
          <div className="panel-head">
            <h2 id="work-active">{t.activeInitiatives}</h2>
            <AppLink className="text-link" href={shell.hrefOf("work-initiatives")}>
              {t.nav.initiatives}
            </AppLink>
          </div>
          {overview.loading ? (
            <Skeleton />
          ) : !o?.initiatives.length ? (
            <Empty title={t.noInitiatives} />
          ) : (
            <ul className="work-initiatives">
              {o.initiatives.map((i: Initiative) => (
                <InitiativeLink key={i.id} initiative={i} />
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="work-next">
          <div className="panel-head">
            <h2 id="work-next">{t.myNext}</h2>
            <AppLink className="text-link" href={shell.hrefOf("work-my")}>
              {t.nav.my}
            </AppLink>
          </div>
          {overview.loading ? (
            <Skeleton />
          ) : !o?.myNext.length ? (
            <Empty title={t.noTasks} />
          ) : (
            <ul className="support-rows">
              {o.myNext.map((task) => (
                <TaskRow key={task.id} task={task} statuses={lists.statuses} members={lists.members} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function InitiativeLink({ initiative }: { initiative: Initiative }) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  return (
    <InitiativeCard
      initiative={initiative}
      t={workText(locale)}
      onOpen={() => router.push(`${shell.hrefOf("work-initiatives")}?initiative=${encodeURIComponent(initiative.id)}`)}
    />
  );
}

export function MilestonesView() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = workText(locale);
  const milestones = useResource<{ items: Milestone[] }>(workPath(project.id, "/milestones"));
  const initiatives = useResource<{ items: Initiative[] }>(workPath(project.id, "/initiatives"));
  const today = new Date().toISOString().slice(0, 10);
  const byInitiative = new Map<string, Milestone[]>();
  for (const m of milestones.data?.items ?? []) byInitiative.set(m.initiativeId, [...(byInitiative.get(m.initiativeId) ?? []), m]);
  return (
    <div className="support-page">
      <PageHead title={t.nav.milestones} description={t.intro} />
      {milestones.loading || initiatives.loading ? (
        <Loading />
      ) : milestones.error ? (
        <ResourceError error={milestones.error} retry={milestones.refresh} />
      ) : !milestones.data?.items.length ? (
        <Empty title={t.noMilestones} />
      ) : (
        (initiatives.data?.items ?? [])
          .filter((i) => byInitiative.has(i.id))
          .map((i) => (
            <section key={i.id} className="panel" aria-labelledby={`work-ms-${i.id}`}>
              <div className="panel-head">
                <h2 id={`work-ms-${i.id}`}>
                  {i.key} · {i.title}
                </h2>
                <AppLink className="text-link" href={`${shell.hrefOf("work-initiatives")}?initiative=${encodeURIComponent(i.id)}`}>
                  {t.nav.initiatives}
                </AppLink>
              </div>
              <ul className="work-checklist">
                {byInitiative.get(i.id)!.map((m) => {
                  const late = m.status === "open" && m.dueDate !== null && m.dueDate < today && (m.tasks?.open ?? 0) > 0;
                  return (
                    <li key={m.id}>
                      <span>
                        <strong>{m.title}</strong> · {day(m.dueDate, locale)}
                        {m.tasks && ` · ${m.tasks.total - m.tasks.open}/${m.tasks.total}`}
                      </span>
                      <span className="support-row-badges">
                        <Badge tone={m.status === "reached" ? "success" : m.status === "missed" ? "danger" : "neutral"}>{t.milestoneStatus[m.status]}</Badge>
                        {late && <Badge tone="danger">{t.metrics.overdue}</Badge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
      )}
    </div>
  );
}

export function MyTasksView() {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const lists = useWorkLists();
  const mine = useResource<MyTasks>(workPath(project.id, "/my"));
  const groups = ["overdue", "today", "week", "later", "none"] as const;
  return (
    <div className="support-page">
      <PageHead title={t.nav.my} description={t.intro} />
      {mine.loading ? (
        <Loading />
      ) : mine.error ? (
        <ResourceError error={mine.error} retry={mine.refresh} />
      ) : groups.every((g) => !mine.data?.[g].length) ? (
        <Empty title={t.noTasks} />
      ) : (
        groups
          .filter((g) => mine.data![g].length)
          .map((g) => (
            <section key={g} className="work-section" aria-labelledby={`work-my-${g}`}>
              <h2 id={`work-my-${g}`} data-tone={g === "overdue" ? "critical" : undefined}>
                {t.my[g]} ({mine.data![g].length})
              </h2>
              <ul className="support-rows">
                {mine.data![g].map((task) => (
                  <TaskRow key={task.id} task={task} statuses={lists.statuses} members={lists.members} />
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  );
}

/** The project home's card: my open, overdue and due-this-week counts. */
export function WorkHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = workText(locale);
  const mine = useResource<MyTasks>(workPath(project.id, "/my"));
  if (mine.error?.status === 404) return null;
  const m = mine.data;
  const open = m ? Object.values(m).reduce((n, list) => n + list.length, 0) : undefined;
  return (
    <HomeCard id="home-card-work" title={t.home.title} href={shell.hrefOf("work")}>
      {mine.loading ? (
        <Skeleton />
      ) : mine.error ? (
        <ResourceError error={mine.error} retry={mine.refresh} />
      ) : (
        <dl className="home-counts">
          <div>
            <dt>{t.home.mine}</dt>
            <dd>{open ?? "—"}</dd>
          </div>
          <div data-tone={m && m.overdue.length > 0 ? "critical" : undefined}>
            <dt>{t.home.overdue}</dt>
            <dd>{m ? m.overdue.length : "—"}</dd>
          </div>
          <div>
            <dt>{t.home.week}</dt>
            <dd>{m ? m.today.length + m.week.length : "—"}</dd>
          </div>
        </dl>
      )}
    </HomeCard>
  );
}
