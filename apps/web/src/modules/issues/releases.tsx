"use client";
import { useResource } from "@/lib/api";
import { Badge, Empty, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { issuesPath, type Releases } from "./api";
import { DeliveryList } from "./detail";
import { issuesText } from "./labels";
import { SeverityBadge, StatusBadge } from "./shared";

// Releases (plan §5, WP3.11): fixes that are ready or released, with their
// deployments per environment. Merged is not released; only a production
// deployment of a ready fix or a person's confirmation releases an issue.

export function ReleasesView() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = issuesText(locale);
  const releases = useResource<Releases>(issuesPath(project.id, "/releases"));
  return (
    <div className="support-page">
      <PageHead title={t.nav.releases} description={t.releasesIntro} />
      <p className="support-muted">{t.mergedNotReleased}</p>
      {releases.loading ? (
        <Loading />
      ) : releases.error ? (
        <ResourceError error={releases.error} retry={releases.refresh} />
      ) : !releases.data?.items.length ? (
        <Empty title={t.noReleases} />
      ) : (
        <ul className="support-rows">
          {releases.data.items.map((r) => {
            const live = r.deployments.some((d) => d.environment && releases.data!.productionEnvironments.includes(d.environment));
            return (
              <li key={r.id} className="panel work-stack">
                <AppLink className="support-row" href={`${shell.hrefOf("issues-list")}?issue=${encodeURIComponent(r.id)}`}>
                  <span className="support-row-title">
                    {r.key} {r.title}
                  </span>
                  <span className="support-row-badges">
                    <StatusBadge status={r.status} />
                    <SeverityBadge severity={r.severity} />
                    {r.merged && <Badge>{t.deliveryKind.pr_merged}</Badge>}
                    {live && <Badge tone="success">{t.production}</Badge>}
                  </span>
                </AppLink>
                {r.deployments.length ? <DeliveryList t={t} items={r.deployments} locale={locale} /> : <span className="support-muted">{t.none}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
