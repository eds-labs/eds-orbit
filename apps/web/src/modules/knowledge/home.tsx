"use client";
import { Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { useResource } from "@/lib/api";
import { knowledgeCopy } from "./workspace-text";
import { AppLink } from "@/platform/ui/app-link";
import { figure, knowledgeText, useKnowledgeData } from "./overview";

/**
 * The knowledge card of the project home (UI restructure §5.2): sources,
 * verified facts, conflicts and, for owners, the active index generation.
 * It shares the overview's reads and renders nothing while the module is off.
 */
export function KnowledgeHomeCard() {
  const shell = useShell();
  return shell.features?.knowledgeWorkspace ? (
    <WorkspaceHomeCard />
  ) : (
    <LegacyKnowledgeHomeCard />
  );
}
function WorkspaceHomeCard() {
  const { project, locale, isOwner, revision } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const resource = useResource<{
    proposals: Array<{ data: Record<string, unknown> }>;
    drafts: unknown[];
    facts: Array<{ data: Record<string, unknown> }>;
  }>(`/projects/${project.id}/knowledge-workspace?revision=${revision}`);
  if (resource.error?.status === 404) return null;
  const data = resource.data;
  return (
    <HomeCard
      id="home-card-knowledge"
      title={t.title}
      href={shell.hrefOf("knowledge")}
    >
      {resource.loading ? (
        <Skeleton />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.refresh} />
      ) : (
        <>
          <dl className="home-counts">
            <div>
              <dt>{t.accepted}</dt>
              <dd>
                {data?.facts.filter((f) => f.data.status === "verified")
                  .length ?? "—"}
              </dd>
            </div>
            <div>
              <dt>{t.review}</dt>
              <dd>
                {data?.proposals.filter((p) =>
                  ["pending", "needs_review"].includes(String(p.data.status)),
                ).length ?? "—"}
              </dd>
            </div>
            <div>
              <dt>{t.sources}</dt>
              <dd>{data?.drafts.length ?? "—"}</dd>
            </div>
          </dl>
          {isOwner && (
            <AppLink
              className="text-link"
              href={shell.hrefOf("knowledge-import")}
            >
              {t.add}
            </AppLink>
          )}
        </>
      )}
    </HomeCard>
  );
}
function LegacyKnowledgeHomeCard() {
  const { t, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const text = knowledgeText(locale);
  const data = useKnowledgeData();
  if (data.health.error?.status === 404) return null;
  const title = t("knowledge");
  return (
    <HomeCard
      id="home-card-knowledge"
      title={title}
      href={shell.hrefOf("knowledge")}
      className="knowledge-home"
    >
      {data.health.loading ? (
        <Skeleton />
      ) : data.health.error ? (
        <ResourceError error={data.health.error} retry={data.health.refresh} />
      ) : (
        <dl className="home-counts">
          <div>
            <dt>{t("sources")}</dt>
            <dd>{data.sources.data ? data.listed.length : "—"}</dd>
          </div>
          <div>
            <dt>{text.verifiedFacts}</dt>
            <dd>{figure(data.verified)}</dd>
          </div>
          <div data-tone={data.conflicts?.length ? "warning" : undefined}>
            <dt>{t("conflicts")}</dt>
            <dd>{figure(data.conflicts?.length)}</dd>
          </div>
          {isOwner && data.active !== undefined && (
            <div>
              <dt>{text.indexGeneration}</dt>
              <dd>{figure(data.active?.generation)}</dd>
            </div>
          )}
        </dl>
      )}
    </HomeCard>
  );
}
