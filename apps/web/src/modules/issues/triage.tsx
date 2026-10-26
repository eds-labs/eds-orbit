"use client";
import { useResource } from "@/lib/api";
import { Empty, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cn } from "@/lib/utils";
import { issuesPath, type IssuePage } from "./api";
import { IssueDetailView } from "./detail";
import { issuesText } from "./labels";
import { useOpenIssue } from "./list";
import { IssueRow } from "./shared";

// The triage queue (plan §5): new, in triage and needs info, and the issues
// with pending duplicate candidates; the open issue beside it shows the
// candidates to compare, confirm or reject.

export function TriageView() {
  const { project, locale } = useWorkspace();
  const t = issuesText(locale);
  const [issueId, openIssue] = useOpenIssue();
  const queue = useResource<IssuePage>(issuesPath(project.id, "/list?status=triage&sort=created&limit=100"));
  const duplicates = useResource<IssuePage>(issuesPath(project.id, "/list?status=all&duplicates=pending&limit=100"));
  const list = (page: typeof queue, empty: string) =>
    page.loading ? (
      <Loading />
    ) : page.error ? (
      <ResourceError error={page.error} retry={page.refresh} />
    ) : !page.data?.items.length ? (
      <Empty title={empty} />
    ) : (
      <ul className="support-rows">
        {page.data.items.map((i) => (
          <IssueRow key={i.id} issue={i} counts={i.counts} selected={issueId === i.id} onOpen={openIssue} />
        ))}
      </ul>
    );
  return (
    <div className="support-page">
      <PageHead title={t.nav.triage} description={t.intro} />
      <div className={cn("support-layout", issueId && "support-layout-open")}>
        <section className="support-list work-stack" aria-label={t.nav.triage}>
          <h2>{t.candidatesQueue}</h2>
          {list(duplicates, t.noDuplicates)}
          <h2>{t.triageQueue}</h2>
          {list(queue, t.none)}
        </section>
        {issueId && (
          <section className="support-detail">
            <IssueDetailView key={issueId} issueId={issueId} onBack={() => openIssue(null)} onChanged={() => {
                queue.refresh();
                duplicates.refresh();
              }} onOpen={openIssue} />
          </section>
        )}
      </div>
    </div>
  );
}
