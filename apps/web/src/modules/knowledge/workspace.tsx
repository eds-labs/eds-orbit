"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { useResource } from "@/lib/api";
import { Alert, Button, Input, Loading } from "@/components/ui/primitives";
import { knowledgeCopy } from "./workspace-text";
import { KnowledgeAddFlow } from "./add-flow";
import { GithubAppSummary, KnowledgeGithubPage } from "./github-page";
import { TechnicalNav } from "./technical-nav";
import { SourceList } from "./source-list";
import { countRemoved, StatementList } from "./statements";
import {
  analysisRunning,
  Field,
  siteRunActive,
  type Summary,
} from "./workspace-parts";
import type { KnowledgeTab } from "./knowledge";

export function KnowledgeWorkspaceGate({
  tab,
  fallback,
}: {
  tab: KnowledgeTab;
  fallback: ReactNode;
}) {
  const { project, revision, locale } = useWorkspace();
  const expert = useSearchParams()?.get("expert") === "1";
  const resource = useResource<Summary>(
    `/projects/${project.id}/knowledge-workspace?revision=${revision}`,
  );
  const retained = useRef<{ projectId: string; data: Summary } | null>(null);
  if (resource.data)
    retained.current = { projectId: project.id, data: resource.data };
  const data =
    resource.data ??
    (retained.current?.projectId === project.id ? retained.current.data : null);
  useEffect(() => {
    if (
      !data?.runs?.some((r) => analysisRunning(String(r.data.status))) &&
      !data?.siteRuns?.some((r) => siteRunActive(r.data.status))
    )
      return;
    const timer = setInterval(resource.refresh, 4000);
    return () => clearInterval(timer);
  }, [data, resource.refresh]);
  if (
    data?.enabled &&
    (expert || ["library", "health", "inspector", "impact"].includes(tab))
  )
    return (
      <>
        <TechnicalNav tab={tab} />
        {fallback}
      </>
    );
  if (data?.enabled)
    return (
      <WorkspaceView
        key={`${project.id}:${tab}`}
        data={data}
        tab={tab}
        refresh={resource.refresh}
      />
    );
  if (resource.loading && !data) return <Loading label="…" />;
  if (resource.error && resource.error.status !== 404)
    return (
      <section className="stack-gap">
        <Alert kind="error">{knowledgeCopy[locale].unavailable}</Alert>
        <Button variant="outline" onClick={resource.refresh}>
          {knowledgeCopy[locale].retry}
        </Button>
      </section>
    );
  return fallback;
}

function WorkspaceView({
  data,
  tab,
  refresh,
}: {
  data: Summary;
  tab: KnowledgeTab;
  refresh: () => void;
}) {
  const { locale, project, isOwner, identity } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const [query, setQuery] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const review = tab === "review" || tab === "conflicts";
  const removedCount = countRemoved(data);
  const listingRemoved = showRemoved && removedCount > 0;
  if (tab === "import")
    return <KnowledgeAddFlow data={data} refresh={refresh} />;
  if (tab === "github")
    return identity?.settingsCenter === "on" ? (
      <GithubAppSummary />
    ) : (
      <KnowledgeGithubPage />
    );
  if (["library", "health", "inspector", "impact"].includes(tab))
    return <LegacyExpert tab={tab} />;
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{tab === "sources" ? t.sources : review ? t.review : t.title}</h1>
          <p>
            {tab === "sources" ? t.sourcesHint : review ? t.reviewHint : t.hint}
          </p>
        </div>
        {isOwner && (
          <Button asChild>
            <AppLink href={shell.hrefOf("knowledge-import")}>
              <Plus aria-hidden="true" />
              {t.add}
            </AppLink>
          </Button>
        )}
      </header>
      {tab === "sources" ? (
        <SourceList data={data} refresh={refresh} t={t} />
      ) : (
        <>
          {!review && (data.profile.description || data.profile.audience) && (
            <section className="knowledge-profile" aria-label={t.title}>
              <h2>{project.name}</h2>
              {data.profile.description && (
                <p>{String(data.profile.description)}</p>
              )}
              {data.profile.audience && (
                <p>
                  <strong>{t.audience}: </strong>
                  {String(data.profile.audience)}
                </p>
              )}
              {isOwner && (
                <AppLink
                  className="text-link"
                  href={`${shell.hrefOf("knowledge-import")}?profile=1`}
                >
                  {t.editProfile}
                </AppLink>
              )}
            </section>
          )}
          <div className="knowledge-filters">
            <Field label={t.search}>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
          </div>
          {!review && removedCount > 0 && (
            <div>
              <Button
                variant="ghost"
                onClick={() => setShowRemoved(!listingRemoved)}
              >
                {listingRemoved
                  ? t.hideRemoved
                  : t.showRemoved.replace("{n}", String(removedCount))}
              </Button>
            </div>
          )}
          <StatementList
            data={data}
            review={review}
            query={query}
            listingRemoved={listingRemoved}
            refresh={refresh}
            t={t}
          />
          {review &&
            data.facts.some((f) => f.data.status === "conflicting") && (
              <AppLink
                className="text-link"
                href={shell.hrefOf("knowledge-conflicts") + "?expert=1"}
              >
                {t.legacyReview}
              </AppLink>
            )}
        </>
      )}
      <p className="knowledge-technical-link">
        <AppLink
          className="text-link"
          href={shell.hrefOf("knowledge-health") + "?expert=1"}
        >
          {t.technical}
        </AppLink>
      </p>
    </div>
  );
}
// Rendered only by the gate's legacy fallback; the gate recognizes explicit expert links.
function LegacyExpert({ tab }: { tab: KnowledgeTab }) {
  const { locale } = useWorkspace();
  return (
    <p>
      {knowledgeCopy[locale].technical}: {tab}
    </p>
  );
}
