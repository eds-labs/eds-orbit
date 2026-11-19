"use client";
import { useState } from "react";
import { post, useMutation, useResource, when } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import type {
  CmsSite,
  EntryDetail,
  PublicationList,
  RevisionDiff,
  RevisionList,
} from "../api";
import { cmsText, type HistoryText } from "../labels";
import { errorText } from "./panels";

// History of an entry (ADR 0029 §5, CH1.14d): its immutable versions with a
// difference against the draft or the live version, restoring a version into
// the draft, and the publication log per site.

/** A field value of a difference, short and readable. */
export function fieldValue(t: HistoryText, value: unknown): string {
  if (value === null || value === undefined || value === "") return t.empty;
  if (Array.isArray(value))
    return value.length
      ? `${value.length} × ${value.map(String).join(", ").slice(0, 80)}`
      : t.empty;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return keys.length ? keys.join(", ") : t.empty;
  }
  return String(value).slice(0, 200);
}

export function DiffView({ diff, t }: { diff: RevisionDiff; t: HistoryText }) {
  if (!diff.changed) return <p>{t.same}</p>;
  return (
    <div className="cms-diff">
      {diff.fields.length > 0 && (
        <dl className="detail-grid">
          {diff.fields.map((field) => (
            <div key={field.name}>
              <dt>{t.fieldNames[field.name] ?? field.name}</dt>
              <dd>
                <del>{fieldValue(t, field.from)}</del> →{" "}
                <ins>{fieldValue(t, field.to)}</ins>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {diff.body.length > 0 && (
        <ol className="cms-diff-body">
          {diff.body.map((op, i) =>
            op.op === "equal" ? (
              <li key={i} className="cms-diff-equal">
                {t.unchanged(op.count)}
              </li>
            ) : (
              <li
                key={i}
                className={
                  op.op === "added" ? "cms-diff-added" : "cms-diff-removed"
                }
              >
                <span className="sr-only">
                  {op.op === "added" ? t.added : t.removed}:{" "}
                </span>
                <span aria-hidden="true">{op.op === "added" ? "+" : "−"}</span>{" "}
                <span className="field-hint">{op.type}</span>{" "}
                {op.text || t.empty}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function DiffModal({
  base,
  from,
  to,
  onClose,
}: {
  base: string;
  from: { id: string; number: number };
  to: "draft" | { id: string; number: number };
  onClose: () => void;
}) {
  const { locale } = useWorkspace();
  const t = cmsText(locale).history;
  const target = to === "draft" ? "draft" : to.id;
  const diff = useResource<RevisionDiff>(
    `${base}/revisions/diff?from=${from.id}&to=${target}`,
  );
  return (
    <Modal
      title={t.diffTitle(
        from.number,
        to === "draft" ? t.draft : t.version(to.number),
      )}
      onClose={onClose}
      wide
    >
      <ResourceError error={diff.error} retry={diff.refresh} />
      {diff.data && <DiffView diff={diff.data} t={t} />}
    </Modal>
  );
}

export function HistoryPanel({
  detail,
  sites,
  editable,
  base,
  flush,
  draftVersion,
  onRestored,
}: {
  detail: EntryDetail;
  sites: CmsSite[];
  editable: boolean;
  base: string;
  flush: () => Promise<boolean>;
  draftVersion: () => number;
  onRestored: () => void;
}) {
  const { project, locale } = useWorkspace();
  const text = cmsText(locale);
  const t = text.history;
  const [before, setBefore] = useState<number | null>(null);
  const revisions = useResource<RevisionList>(
    // The list query is strict: no cache-busting parameters. The page remounts
    // this panel when a new version or publication appears.
    `${base}/revisions?limit=20${before ? `&before=${before}` : ""}`,
  );
  const publications = useResource<PublicationList>(
    `${base}/publications?limit=20`,
  );
  const [diff, setDiff] = useState<{
    from: { id: string; number: number };
    to: "draft" | { id: string; number: number };
  } | null>(null);
  const restore = useMutation();
  const live = detail.publishedRevision;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const doRestore = async (revisionId: string) => {
    if (!window.confirm(t.restoreConfirm)) return;
    if (!(await flush())) return;
    const done = await restore.run(() =>
      post(`${base}/revisions/${revisionId}/restore`, {
        draftVersion: draftVersion(),
      }),
    );
    if (done) onRestored();
  };
  return (
    <div className="cms-panel">
      <section aria-labelledby="cms-revisions" className="cms-fieldset">
        <h3 id="cms-revisions" className="cms-panel-title">
          {t.revisions}
        </h3>
        <ResourceError error={revisions.error} retry={revisions.refresh} />
        {revisions.data &&
          (revisions.data.items.length ? (
            <ul className="cms-revisions">
              {revisions.data.items.map((rev) => (
                <li key={rev.id} className="cms-revision">
                  <div>
                    <strong>#{rev.number}</strong>{" "}
                    {rev.live && <Badge tone="success">{t.live}</Badge>}{" "}
                    {rev.scheduled && <Badge tone="blue">{t.scheduled}</Badge>}
                    <span className="field-hint">
                      {" "}
                      {when(rev.createdAt, locale, project.timezone)} ·{" "}
                      {t.words(rev.wordCount)}
                    </span>
                    {rev.changeNote && (
                      <p className="field-hint">{rev.changeNote}</p>
                    )}
                  </div>
                  <div className="cms-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDiff({
                          from: { id: rev.id, number: rev.number },
                          to: "draft",
                        })
                      }
                    >
                      {t.compareDraft}
                    </Button>
                    {live && !rev.live && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDiff({
                            from: { id: live.id, number: live.number },
                            to: { id: rev.id, number: rev.number },
                          })
                        }
                      >
                        {t.compareLive}
                      </Button>
                    )}
                    {editable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={restore.pending}
                        onClick={() => void doRestore(rev.id)}
                      >
                        {t.restore}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">{t.none}</p>
          ))}
        {revisions.data?.nextBefore && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setBefore(revisions.data!.nextBefore)}
          >
            {t.more}
          </Button>
        )}
        {restore.error && (
          <Alert kind="error">{errorText(text.editor, restore.error)}</Alert>
        )}
      </section>
      <section aria-labelledby="cms-publications" className="cms-fieldset">
        <h3 id="cms-publications" className="cms-panel-title">
          {t.publications}
        </h3>
        <ResourceError
          error={publications.error}
          retry={publications.refresh}
        />
        {publications.data &&
          (publications.data.items.length ? (
            <ul className="cms-revisions">
              {publications.data.items.map((pub) => (
                <li key={pub.id} className="cms-revision">
                  <div>
                    <strong>{t.actions[pub.action] ?? pub.action}</strong> ·{" "}
                    {siteName(pub.siteId)}{" "}
                    <Badge
                      tone={
                        pub.status === "needs_attention" ||
                        pub.status === "failed"
                          ? "danger"
                          : pub.status === "cancelled"
                            ? "neutral"
                            : pub.status === "queued" ||
                                pub.status === "claimed"
                              ? "blue"
                              : "success"
                      }
                    >
                      {t.statuses[pub.status] ?? pub.status}
                    </Badge>
                    <span className="field-hint">
                      {" "}
                      {when(
                        pub.visibleAt ?? pub.scheduledAt,
                        locale,
                        project.timezone,
                      )}
                      {pub.errorCode ? ` · ${pub.errorCode}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">{t.noPublications}</p>
          ))}
      </section>
      {diff && (
        <DiffModal
          base={base}
          from={diff.from}
          to={diff.to}
          onClose={() => setDiff(null)}
        />
      )}
    </div>
  );
}
