"use client";

import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { WidgetResource } from "@/platform/ui/widget-resource";
import { cmsPath, type CmsSummary } from "./api";
import { cmsText } from "./labels";

export function CmsHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = cmsText(locale);
  return (
    <WidgetResource<CmsSummary>
      id="home-card-cms"
      title={t.module}
      href={shell.hrefOf("cms.entries")}
      path={cmsPath(project.id, "/summary")}
    >
      {({ entries, waiting }) => (
        <dl className="home-counts">
          <div>
            <dt>{t.overview.drafts}</dt>
            <dd>{entries.draft}</dd>
          </div>
          <div data-tone={waiting ? "warning" : undefined}>
            <dt>{t.overview.waiting}</dt>
            <dd>{waiting}</dd>
          </div>
          <div>
            <dt>{t.overview.scheduled}</dt>
            <dd>{entries.scheduled}</dd>
          </div>
        </dl>
      )}
    </WidgetResource>
  );
}
