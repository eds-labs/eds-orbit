"use client";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  Plus,
  ExternalLink,
  CheckCircle2,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { action, useResource, useMutation, when, type Entity } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Modal,
  Textarea,
  Loading,
  Empty,
} from "@/components/ui/primitives";
import type { KnowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace";
import {
  knowledgeCopy,
  workspaceStatus,
  type KnowledgeCopy,
} from "./workspace-text";
import { KnowledgeAddFlow } from "./add-flow";
import { KnowledgeGithubPage } from "./github-page";
import { SourceList } from "./source-list";
import {
  analysisRunning,
  Field,
  siteRunActive,
  WorkspaceError,
  type Preview,
  type Summary,
} from "./workspace-parts";
import type { KnowledgeTab } from "./knowledge";

const topics = [
  "description",
  "audience",
  "platforms",
  "features",
  "limitations",
] as const;
const textOf = (p: Entity) => String(p.data.statement ?? p.data.value ?? "");
const inputClass = "input";

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
    return fallback;
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
  const { locale, project, isOwner } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const review = tab === "review" || tab === "conflicts";
  const pausedSources = new Set(
    data.sources.filter((s) => s.data.status === "paused").map((s) => s.id),
  );
  // Withdrawing a fact or pausing a source elsewhere leaves the proposal
  // "accepted"; what is really in use decides, so the list never calls
  // unused knowledge confirmed.
  const factStatus = new Map(data.facts.map((f) => [f.id, f.data.status]));
  const isRemoved = (p: Entity) =>
    p.data.status === "removed" ||
    (p.data.status === "accepted" &&
      (factStatus.get(String(p.data.factId)) === "revoked" ||
        pausedSources.has(String(p.data.sourceId))));
  const removedCount = data.proposals.filter(isRemoved).length;
  const listingRemoved = showRemoved && removedCount > 0;
  const proposals = data.proposals.filter((p) =>
    review
      ? ["pending", "needs_review"].includes(String(p.data.status))
      : listingRemoved
        ? isRemoved(p)
        : p.data.status === "accepted" && !isRemoved(p),
  );
  const filtered = proposals.filter(
    (p) =>
      (!topic || p.data.topic === topic) &&
      textOf(p).toLowerCase().includes(query.toLowerCase()),
  );
  const oldFacts = data.facts.filter(
    (f) =>
      f.data.status === "verified" &&
      !String(f.data.key).startsWith("knowledge.") &&
      !pausedSources.has(String(f.data.sourceId)) &&
      String(f.data.value).toLowerCase().includes(query.toLowerCase()),
  );
  const shownOldFacts = !review && !topic && !listingRemoved ? oldFacts : [];
  if (tab === "import")
    return <KnowledgeAddFlow data={data} refresh={refresh} />;
  if (tab === "github") return <KnowledgeGithubPage />;
  if (["library", "health", "inspector", "impact"].includes(tab))
    return <LegacyExpert tab={tab} />;
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{tab === "sources" ? t.sources : review ? t.review : t.title}</h1>
          <p>{t.hint}</p>
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
            <Field label={t.all}>
              <select
                className={inputClass}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              >
                <option value="">{t.all}</option>
                {topics.map((x) => (
                  <option key={x} value={x}>
                    {t[x]}
                  </option>
                ))}
              </select>
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
          {!filtered.length && !shownOldFacts.length ? (
            <Empty
              title={query || topic ? t.noMatch : review ? t.noReview : t.empty}
              description={review ? t.noReviewHint : t.emptyHint}
            />
          ) : (
            <div className="knowledge-statements">
              {filtered.map((p) => (
                <Proposal
                  key={`${p.id}:${p.version}`}
                  proposal={p}
                  review={review}
                  rights={
                    (
                      data.drafts.find((d) => d.id === p.data.draftId)?.data
                        .input as KnowledgeDraft | undefined
                    )?.rights
                  }
                  manage={!review && !listingRemoved}
                  removed={listingRemoved}
                  facts={data.facts}
                  refresh={refresh}
                  t={t}
                />
              ))}
              {shownOldFacts.map((f) => (
                <article key={f.id} className="knowledge-statement">
                  <Badge tone="success">{t.accepted}</Badge>
                  <p>{String(f.data.value)}</p>
                  <details>
                    <summary>{t.evidence}</summary>
                    <p>{String(f.data.key)}</p>
                    <AppLink
                      className="text-link"
                      href={shell.hrefOf("knowledge-facts") + "?expert=1"}
                    >
                      {t.facts}
                    </AppLink>
                  </details>
                </article>
              ))}
            </div>
          )}
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
      <details className="knowledge-advanced">
        <summary>{t.advanced}</summary>
        <nav aria-label={t.advanced}>
          {(
            [
              ["facts", t.facts],
              ["library", t.library],
              ["health", t.health],
              ["inspector", t.inspector],
              ["impact", t.impact],
              ["import", t.advancedImport],
            ] as const
          ).map(([key, label]) => (
            <AppLink
              key={key}
              className="text-link"
              href={shell.hrefOf(`knowledge-${key}`) + "?expert=1"}
            >
              {label}
            </AppLink>
          ))}
          {isOwner && (
            <AppLink
              className="text-link"
              href={shell.hrefOf("knowledge-github")}
            >
              {t.configure}
            </AppLink>
          )}
        </nav>
      </details>
    </div>
  );
}
// Rendered only by the gate's legacy fallback; the gate recognizes explicit expert links.
function LegacyExpert({ tab }: { tab: KnowledgeTab }) {
  const { locale } = useWorkspace();
  return (
    <p>
      {knowledgeCopy[locale].advanced}: {tab}
    </p>
  );
}
export function Proposal({
  proposal: p,
  review,
  rights,
  manage = false,
  removed = false,
  facts = [],
  refresh,
  t,
}: {
  proposal: Entity;
  review: boolean;
  /** What the owner chose on the draft; the form starts from it. */
  rights?: KnowledgeDraft["rights"];
  /** Offers correcting and removing a confirmed statement. */
  manage?: boolean;
  /** Listed among removed statements: offers bringing it back. */
  removed?: boolean;
  facts?: Entity[];
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, isOwner, locale } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const d = p.data as Record<string, any>;
  const [statement, setStatement] = useState(String(d.statement));
  const [publicUse, setPublicUse] = useState(rights?.publicUse ?? false);
  const [marketing, setMarketing] = useState(rights?.marketing ?? true);
  const [support, setSupport] = useState(rights?.support ?? true);
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const changed = review && d.status === "needs_review";
  const restorable = Boolean(d.factId && d.sourceId);
  const sharedFacts = facts.filter(
    (f) =>
      f.id !== d.factId &&
      f.data.sourceId === d.sourceId &&
      f.data.status === "verified",
  ).length;
  const onProposal = (name: string, extra: Record<string, unknown> = {}) =>
    mutation.run(() =>
      action(project.id, name, {
        proposalId: p.id,
        version: p.version,
        ...extra,
      }),
    );
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onProposal("knowledge-proposal-edit", { statement }))
      setEditing(false);
  };
  const remove = async () => {
    setRemoving(false);
    await onProposal("knowledge-proposal-remove");
  };
  const decide = (decision: "accept" | "reject") =>
    mutation.run(() =>
      action(project.id, "knowledge-proposal-decide", {
        proposalId: p.id,
        version: p.version,
        decision,
        statement,
        publicUse,
        audiences: [
          ...(marketing ? ["marketing"] : []),
          ...(support ? ["support"] : []),
        ],
      }),
    );
  return (
    <article className="knowledge-statement">
      <div className="knowledge-badges">
        <Badge
          tone={
            removed
              ? "neutral"
              : d.status === "accepted"
                ? "success"
                : "warning"
          }
        >
          {removed ? t.removed : workspaceStatus(String(d.status), t)}
        </Badge>
        <span>{t[d.topic as keyof KnowledgeCopy]}</span>
        <span>{workspaceStatus(String(d.stage), t)}</span>
      </div>
      {editing ? (
        <form onSubmit={saveEdit} className="stack-gap">
          <Field label={t.statement}>
            <Textarea
              required
              maxLength={1000}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </Field>
          {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
          <div className="form-actions">
            <Button type="submit" disabled={mutation.pending}>
              {t.saveEdit}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setStatement(String(d.statement));
                setEditing(false);
              }}
            >
              {t.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <h2>{String(d.statement)}</h2>
      )}
      {changed ? (
        <Alert kind="warning">{t.changedHint}</Alert>
      ) : (
        review && <p>{String(d.reason)}</p>
      )}
      <details>
        <summary>{t.evidence}</summary>
        <p>{t.stageHint}</p>
        {d.evidence && (
          <>
            <p>
              {String(d.evidence.path)} · {String(d.evidence.startLine)}–
              {String(d.evidence.endLine)}
            </p>
            {d.evidence.commit && (
              <p className="knowledge-path">
                {t.commit}: {String(d.evidence.commit)}
              </p>
            )}
            <blockquote className="knowledge-quote">
              {String(d.evidence.quote)}
            </blockquote>
            {d.evidence.url && (
              <a
                className="text-link"
                href={String(d.evidence.url)}
                target="_blank"
                rel="noreferrer"
              >
                {t.evidence}
                <ExternalLink aria-hidden="true" />
              </a>
            )}
          </>
        )}
        {d.status === "accepted" && (
          <p>
            {d.publicUse ? t.public : t.internal} ·{" "}
            {((d.audiences as string[]) ?? [])
              .map((a) => t[a as keyof KnowledgeCopy])
              .join(", ")}
          </p>
        )}
        {d.sourceId && (
          <p>
            <AppLink
              className="text-link"
              href={`${shell.hrefOf("knowledge-library")}?source=${d.sourceId}`}
            >
              {t.library}
            </AppLink>
          </p>
        )}
        <Button variant="ghost" onClick={() => setHistory(!history)}>
          {t.loadHistory}
        </Button>
        {history && <ProposalHistory id={p.id} t={t} locale={locale} />}
      </details>
      {review && !changed && isOwner && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide("accept");
          }}
          className="stack-gap"
        >
          <Field label={t.statement}>
            <Textarea
              required
              maxLength={1000}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </Field>
          <fieldset className="knowledge-usage">
            <legend>{t.usage}</legend>
            <label>
              <input
                type="checkbox"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
              />
              {t.marketing}
            </label>
            <label>
              <input
                type="checkbox"
                checked={support}
                onChange={(e) => setSupport(e.target.checked)}
              />
              {t.support}
            </label>
            <label>
              <input
                type="checkbox"
                checked={publicUse}
                onChange={(e) => setPublicUse(e.target.checked)}
              />
              {t.publicUse}
            </label>
          </fieldset>
          {!publicUse && (marketing || support) && (
            <Alert>{t.publicNeeded}</Alert>
          )}
          {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
          <div className="form-actions">
            <Button
              type="submit"
              disabled={mutation.pending || (!marketing && !support)}
            >
              <CheckCircle2 aria-hidden="true" />
              {t.accept}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={mutation.pending}
              onClick={() => decide("reject")}
            >
              {t.reject}
            </Button>
          </div>
        </form>
      )}
      {isOwner && !editing && (changed || manage || removed) && (
        <>
          {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
          <div className="form-actions">
            {manage && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" />
                {t.edit}
              </Button>
            )}
            {changed && restorable && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() => onProposal("knowledge-proposal-restore")}
              >
                <CheckCircle2 aria-hidden="true" />
                {t.keepUsing}
              </Button>
            )}
            {removed && restorable && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() => onProposal("knowledge-proposal-restore")}
              >
                <RotateCcw aria-hidden="true" />
                {t.restore}
              </Button>
            )}
            {(manage || changed) && (
              <Button
                variant="ghost"
                disabled={mutation.pending}
                onClick={() => setRemoving(true)}
              >
                <Trash2 aria-hidden="true" />
                {t.remove}
              </Button>
            )}
          </div>
        </>
      )}
      {removing && (
        <Modal
          title={t.removeTitle}
          description={
            sharedFacts
              ? `${t.removeHint} ${t.removeShared.replace("{n}", String(sharedFacts))}`
              : t.removeHint
          }
          onClose={() => setRemoving(false)}
        >
          <div className="form-actions">
            <Button variant="outline" onClick={() => setRemoving(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive" onClick={remove}>
              {t.remove}
            </Button>
          </div>
        </Modal>
      )}
    </article>
  );
}
function ProposalHistory({
  id,
  t,
  locale,
}: {
  id: string;
  t: KnowledgeCopy;
  locale: string;
}) {
  const { project } = useWorkspace();
  const r = useResource<{
    items: { version: number; createdAt: string; data: Record<string, any> }[];
  }>(`/projects/${project.id}/knowledge/proposals/${id}/history`);
  return (
    <section aria-label={t.history}>
      {r.loading ? (
        <Loading label={t.history} />
      ) : r.error ? (
        <Alert kind="error">{t.unavailable}</Alert>
      ) : (
        <ol>
          {r.data?.items.map((v) => (
            <li key={v.version}>
              {t.version} {v.version} · {when(v.createdAt, locale)} ·{" "}
              {workspaceStatus(String(v.data.status), t)}
              <p>{String(v.data.statement ?? "")}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
