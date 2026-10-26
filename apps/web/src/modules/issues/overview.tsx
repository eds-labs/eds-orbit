"use client";
import { AlertOctagon, Bug, CheckCircle2, Copy, Inbox, Rocket, Sparkles } from "lucide-react";
import { useResource } from "@/lib/api";
import { Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { Metric } from "@/platform/ui/metric";
import { hours, issuesPath, type Overview } from "./api";
import { issuesText } from "./labels";
import { IssueRow } from "./shared";

// The issue center's dashboard (plan §2.9) and its home card. Figures show
// "—" until they load or when there is no data; nothing is estimated.

export function IssuesOverview() {
  const { project, locale, t: word } = useWorkspace();
  const shell = useShell();
  const t = issuesText(locale);
  const overview = useResource<Overview>(issuesPath(project.id, "/overview"));
  const o = overview.data;
  const count = (n: number | undefined) => (o ? String(n) : "—");
  const breakdown = (rows: Array<[string, number]>) =>
    rows.length ? (
      <ul className="settings-rows">
        {rows.map(([label, n]) => (
          <li key={label} className="work-settings-row">
            <span>{label}</span>
            <strong>{n}</strong>
          </li>
        ))}
      </ul>
    ) : (
      <Empty title={t.none} />
    );
  return (
    <div className="support-page">
      <PageHead title={t.module} description={t.intro} eyebrow={word("moduleEyebrow")}>
        <AppLink className="text-link" href={shell.hrefOf("issues-list")}>
          {t.nav.list}
        </AppLink>
      </PageHead>
      <ResourceError error={overview.error} retry={overview.refresh} />
      <div className="metrics-strip metrics-four">
        <Metric icon={Bug} label={t.metrics.open} amount={count(o?.metrics.open)} href={shell.hrefOf("issues-list")} />
        <Metric
          icon={AlertOctagon}
          label={t.metrics.critical}
          amount={count(o?.metrics.critical)}
          tone={o && o.metrics.critical > 0 ? "warning" : undefined}
          href={`${shell.hrefOf("issues-list")}?severity=s1_critical`}
        />
        <Metric icon={Sparkles} label={t.metrics.newWeek} amount={count(o?.metrics.newLast7Days)} />
        <Metric icon={Inbox} label={t.metrics.triage} amount={count(o?.metrics.awaitingTriage)} href={shell.hrefOf("issues-triage")} />
        <Metric icon={Copy} label={t.metrics.duplicates} amount={count(o?.metrics.duplicatesPending)} href={shell.hrefOf("issues-triage")} />
        <Metric icon={CheckCircle2} label={t.metrics.fixReady} amount={count(o?.metrics.fixReadyNotReleased)} href={shell.hrefOf("issues-releases")} />
        <Metric icon={Rocket} label={t.metrics.released} amount={count(o?.metrics.releasedLast30Days)} />
      </div>
      <div className="work-columns-2">
        <section className="panel" aria-labelledby="issues-critical">
          <div className="panel-head">
            <h2 id="issues-critical">{t.criticalList}</h2>
          </div>
          {overview.loading ? <Skeleton /> : !o?.critical.length ? <Empty title={t.none} /> : (
            <ul className="support-rows">{o.critical.map((i) => <IssueRow key={i.id} issue={i} />)}</ul>
          )}
        </section>
        <section className="panel" aria-labelledby="issues-reported">
          <div className="panel-head">
            <h2 id="issues-reported">{t.mostReported}</h2>
          </div>
          {overview.loading ? <Skeleton /> : !o?.mostReported.length ? <Empty title={t.none} /> : (
            <ul className="support-rows">{o.mostReported.map((i) => <IssueRow key={i.id} issue={i} />)}</ul>
          )}
        </section>
        <section className="panel" aria-labelledby="issues-components">
          <div className="panel-head">
            <h2 id="issues-components">{t.byComponent}</h2>
          </div>
          {o ? breakdown(o.byComponent.map((c) => [c.component, c.open])) : <Skeleton />}
        </section>
        <section className="panel" aria-labelledby="issues-sources">
          <div className="panel-head">
            <h2 id="issues-sources">{t.bySource}</h2>
          </div>
          {o ? breakdown(Object.entries(o.bySource).map(([k, n]) => [t.source[k] ?? k, n])) : <Skeleton />}
        </section>
        <section className="panel" aria-labelledby="issues-status">
          <div className="panel-head">
            <h2 id="issues-status">{t.byStatus}</h2>
          </div>
          {o ? breakdown(Object.entries(o.byStatus).map(([k, n]) => [t.status[k as keyof typeof t.status] ?? k, n])) : <Skeleton />}
          {o && (
            <>
              <h3>{t.age.title}</h3>
              {breakdown([
                [t.age.under_7d, o.openAge.under_7d],
                [t.age.under_30d, o.openAge.under_30d],
                [t.age.over_30d, o.openAge.over_30d],
              ])}
            </>
          )}
        </section>
        <section className="panel" aria-labelledby="issues-lead">
          <div className="panel-head">
            <h2 id="issues-lead">{t.lead.title}</h2>
          </div>
          {o ? (
            <dl className="home-counts">
              {(["newToConfirmed", "confirmedToFixReady", "fixReadyToReleased", "newToReleased"] as const).map((k) => (
                <div key={k}>
                  <dt>{t.lead[k]}</dt>
                  <dd>{hours(o.leadTimesHours[k], locale)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Skeleton />
          )}
        </section>
      </div>
    </div>
  );
}

export function IssuesHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = issuesText(locale);
  const overview = useResource<Overview>(issuesPath(project.id, "/overview"));
  if (overview.error?.status === 404) return null;
  const m = overview.data?.metrics;
  return (
    <HomeCard id="home-card-issues" title={t.home.title} href={shell.hrefOf("issues")}>
      {overview.loading ? (
        <Skeleton />
      ) : overview.error ? (
        <ResourceError error={overview.error} retry={overview.refresh} />
      ) : (
        <dl className="home-counts">
          <div data-tone={m && m.critical > 0 ? "critical" : undefined}>
            <dt>{t.home.critical}</dt>
            <dd>{m ? m.critical : "—"}</dd>
          </div>
          <div>
            <dt>{t.home.triage}</dt>
            <dd>{m ? m.awaitingTriage : "—"}</dd>
          </div>
          <div>
            <dt>{t.home.fixReady}</dt>
            <dd>{m ? m.fixReadyNotReleased : "—"}</dd>
          </div>
        </dl>
      )}
    </HomeCard>
  );
}
