"use client";
import {
  CalendarClock,
  CheckCircle2,
  FileText,
  Globe,
  Hourglass,
} from "lucide-react";
import { useResource, when } from "@/lib/api";
import { Badge, Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { Metric } from "@/platform/ui/metric";
import { AppLink } from "@/platform/ui/app-link";
import { useShell } from "@/platform/shell/shell-context";
import { cmsPath, type CmsStatus, type CmsSummary } from "./api";
import { cmsText } from "./labels";

// The content module's overview (ADR 0029, CH1.4, CH1.14a): counts by state,
// open decisions, websites, the approval rule from the server's settings and
// the entries edited last.

export function CmsOverview() {
  const { project, locale, t: word } = useWorkspace();
  const t = cmsText(locale);
  const status = useResource<CmsStatus>(cmsPath(project.id, "/status"));
  const summary = useResource<CmsSummary>(cmsPath(project.id, "/summary"));
  const s = summary.data;
  const shell = useShell();
  const entries = shell.hrefOf("cms.entries");
  const count = (n: number | undefined) => (n === undefined ? "—" : String(n));
  return (
    <div className="support-page">
      <PageHead
        title={t.module}
        description={t.intro}
        eyebrow={word("moduleEyebrow")}
      />
      <ResourceError
        error={status.error ?? summary.error}
        retry={() => (status.refresh(), summary.refresh())}
      />
      <div className="metrics-strip metrics-five">
        <Metric
          icon={FileText}
          label={t.overview.drafts}
          amount={count(s?.entries.draft)}
          href={entries}
        />
        <Metric
          icon={Hourglass}
          label={t.overview.waiting}
          amount={count(s?.waiting)}
          tone={s?.waiting ? "warning" : undefined}
        />
        <Metric
          icon={CalendarClock}
          label={t.overview.scheduled}
          amount={count(s?.entries.scheduled)}
        />
        <Metric
          icon={CheckCircle2}
          label={t.overview.published}
          amount={count(s?.entries.published)}
        />
        <Metric
          icon={Globe}
          label={t.overview.sites}
          amount={count(s?.sites)}
        />
      </div>
      {status.data && (
        <section className="panel" aria-labelledby="cms-approvers">
          <div className="panel-head">
            <h2 id="cms-approvers">{t.approversTitle}</h2>
          </div>
          <p>{t.approvers[status.data.settings.publishApprovers]}</p>
          {status.data.settings.fourEyes && <p>{t.fourEyes}</p>}
        </section>
      )}
      {s &&
        (s.recent.length ? (
          <section className="panel" aria-labelledby="cms-recent">
            <div className="panel-head">
              <h2 id="cms-recent">{t.overview.recent}</h2>
            </div>
            <ul className="settings-rows cms-recent">
              {s.recent.map((r) => (
                <li key={r.id}>
                  <AppLink
                    className="list-row"
                    href={`${entries}?entry=${encodeURIComponent(r.id)}`}
                  >
                    <strong className="list-row-title">
                      {r.title || t.entries.untitled}
                    </strong>
                    <span className="list-row-meta cms-entry-meta">
                      <Badge>{t.status[r.status]}</Badge>
                      <span>
                        {r.locale} ·{" "}
                        {when(r.updatedAt, locale, project.timezone)}
                      </span>
                    </span>
                  </AppLink>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <Empty
            icon={FileText}
            title={t.emptyTitle}
            description={t.emptyBody}
          />
        ))}
    </div>
  );
}
