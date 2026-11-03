"use client";
import { BarChart3 } from "lucide-react";
import { useResource } from "@/lib/api";
import { Empty, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { socialPath, type AnalyticsItem, type AnalyticsResponse, type PostMetrics, type PostMetricsPublication } from "./api";
import { localOf } from "./calendar/grid";
import { socialText } from "./labels";

// Post figures (ADR 0020, S8): the latest public counts per publication,
// read every six hours by the worker. Telegram has none; X only when the
// owner allows X's paid reads.

type Locale = "en" | "de";

export function MetricsList({ publications, locale }: { publications: PostMetricsPublication[]; locale: Locale }) {
  const all = socialText(locale);
  const t = all.analytics;
  return (
    <ul className="social-metrics">
      {publications.map((p) => {
        const platform = all.platform[p.platform];
        if (!p.available)
          return (
            <li key={p.publicationId} className="field-hint">
              {t.notAvailable(platform)}
            </li>
          );
        const figures = Object.entries(p.metrics).map(([name, value]) => (t.metric as Record<string, (n: number) => string>)[name]?.(value) ?? `${value} ${name}`);
        return (
          <li key={p.publicationId}>
            <strong>{platform}</strong>: {figures.length ? figures.join(" · ") : <span className="field-hint">{t.notRead}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function AnalyticsTable({ items, timeZone, locale }: { items: AnalyticsItem[]; timeZone: string; locale: Locale }) {
  const t = socialText(locale).analytics;
  if (!items.length) return <Empty icon={BarChart3} title={t.empty} />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">{t.published}</th>
          <th scope="col">{t.post}</th>
          <th scope="col">{t.figures}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.postId}>
            <td>{localOf(item.publishedAt, timeZone).replace("T", " ")}</td>
            <td>{item.title || item.excerpt}</td>
            <td>
              <MetricsList publications={item.publications} locale={locale} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Social → Analytics: the posts of the last 30 days with their figures. */
export function AnalyticsView() {
  const { project, locale } = useWorkspace();
  const t = socialText(locale).analytics;
  const page = useResource<AnalyticsResponse>(socialPath(project.id, "/analytics?days=30"));
  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro} />
      <ResourceError error={page.error} retry={page.refresh} />
      {page.loading && !page.data && <Loading label={t.title} />}
      {page.data && <AnalyticsTable items={page.data.items} timeZone={project.timezone} locale={locale} />}
    </div>
  );
}

/** The figures of one published post, for the calendar's panel. */
export function PostMetricsSection({ projectId, postId, locale }: { projectId: string; postId: string; locale: Locale }) {
  const t = socialText(locale).analytics;
  const metrics = useResource<PostMetrics>(socialPath(projectId, `/posts/${postId}/metrics`));
  if (!metrics.data?.publications.length) return null;
  return (
    <section aria-label={t.figures}>
      <h3>{t.figures}</h3>
      <MetricsList publications={metrics.data.publications} locale={locale} />
    </section>
  );
}
