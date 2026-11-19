"use client";
import { FileText } from "lucide-react";
import { useResource } from "@/lib/api";
import { Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cmsPath, type CmsStatus } from "./api";
import { cmsText } from "./labels";

// The content module's overview (ADR 0029, CH1.4): the approval rule from the
// server's settings and the empty state until entries exist.

export function CmsOverview() {
  const { project, locale, t: word } = useWorkspace();
  const t = cmsText(locale);
  const status = useResource<CmsStatus>(cmsPath(project.id, "/status"));
  return (
    <div className="support-page">
      <PageHead
        title={t.module}
        description={t.intro}
        eyebrow={word("moduleEyebrow")}
      />
      <ResourceError error={status.error} retry={status.refresh} />
      {status.data && (
        <>
          <section aria-labelledby="cms-approvers">
            <h2 id="cms-approvers">{t.approversTitle}</h2>
            <p>{t.approvers[status.data.settings.publishApprovers]}</p>
            {status.data.settings.fourEyes && <p>{t.fourEyes}</p>}
          </section>
          <Empty
            icon={FileText}
            title={t.emptyTitle}
            description={t.emptyBody}
          />
        </>
      )}
    </div>
  );
}
