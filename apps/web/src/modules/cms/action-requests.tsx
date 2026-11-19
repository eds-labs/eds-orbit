"use client";
import { useContext } from "react";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { useResource } from "@/lib/api";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { cmsPath, type RevisionDiff, type SiteList } from "./api";
import { cmsText } from "./labels";
import { DiffView } from "./editor/history";

// Content publication requests in Decisions (ADR 0029 §4.6, CH1.14d): the
// decider sees what the approval covers (version, websites, time) and, for
// an update, the difference against the live version.

type PublishOperation = {
  kind: "cms_publish";
  entryId: string;
  locale: string;
  title: string;
  slug: string;
  revision: number;
  revisionId?: string;
  previousRevisionId?: string | null;
  update: boolean;
  siteIds: string[];
  schedule: {
    mode: "now" | "at";
    at: string | null;
    local: string | null;
    timeZone: string;
  };
};

type UnpublishOperation = {
  kind: "cms_unpublish";
  entryId: string;
  locale: string;
  title: string;
  slug: string;
  siteIds: string[];
  replacementEntryId: string | null;
};

function useSiteNames(projectId: string) {
  const sites = useResource<SiteList>(cmsPath(projectId, "/sites"));
  return (ids: string[]) =>
    ids
      .map((id) => sites.data?.items.find((s) => s.id === id)?.name ?? id)
      .join(", ");
}

function EditorLink({ entryId, label }: { entryId: string; label: string }) {
  const shell = useContext(ShellContext);
  const href = shell?.hrefOf("cms.entries");
  return href ? <a href={`${href}?entry=${entryId}`}>{label}</a> : null;
}

function UpdateDiff({
  projectId,
  op,
}: {
  projectId: string;
  op: PublishOperation;
}) {
  const { locale } = useWorkspace();
  const t = cmsText(locale).history;
  const ready = op.update && op.previousRevisionId && op.revisionId;
  const diff = useResource<RevisionDiff>(
    ready
      ? cmsPath(
          projectId,
          `/entries/${op.entryId}/revisions/diff?from=${op.previousRevisionId}&to=${op.revisionId}`,
        )
      : null,
  );
  if (!ready) return null;
  return (
    <section>
      <h4>{cmsText(locale).decision.changes}</h4>
      <ResourceError error={diff.error} retry={diff.refresh} />
      {diff.data && <DiffView diff={diff.data} t={t} />}
    </section>
  );
}

const publishRenderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "cms_publish",
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation as PublishOperation;
    const t = cmsText(de ? "de" : "en").decision;
    const sites = useSiteNames(project.id);
    return (
      <article className="action-request">
        <h3>{op.update ? t.update(op.title) : t.publish(op.title)}</h3>
        <p>
          {t.revision(op.revision)} · {op.locale} · <code>{op.slug}</code>
        </p>
        <p>
          {t.sites}: {sites(op.siteIds)}
        </p>
        <p>
          {op.schedule.mode === "at" && op.schedule.local
            ? t.at(op.schedule.local.replace("T", " "), op.schedule.timeZone)
            : t.now}
        </p>
        <UpdateDiff projectId={project.id} op={op} />
        <EditorLink entryId={op.entryId} label={t.open} />
        <p className="panel-note">{t.note}</p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {t.approve}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => decide("reject")}
          >
            {t.reject}
          </Button>
        </div>
      </article>
    );
  },
};

const unpublishRenderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "cms_unpublish",
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation as UnpublishOperation;
    const t = cmsText(de ? "de" : "en").decision;
    const sites = useSiteNames(project.id);
    return (
      <article className="action-request">
        <h3>{t.unpublish(op.title)}</h3>
        <p>
          {op.locale} · <code>{op.slug}</code>
        </p>
        <p>
          {t.sites}: {sites(op.siteIds)}
        </p>
        <p>{op.replacementEntryId ? t.replacement : t.gone}</p>
        <EditorLink entryId={op.entryId} label={t.open} />
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {t.approve}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => decide("reject")}
          >
            {t.reject}
          </Button>
        </div>
      </article>
    );
  },
};

export const cmsActionRequests: Record<string, ActionRequestRenderer> = {
  "cms.entry.publish": publishRenderer,
  "cms.entry.unpublish": unpublishRenderer,
};
