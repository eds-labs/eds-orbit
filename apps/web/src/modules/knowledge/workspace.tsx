"use client";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  Plus,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { cn } from "@/lib/utils";
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
import {
  analysisRunning,
  Field,
  costText,
  listedSources,
  siteRunActive,
  SiteRunSummary,
  visibleDrafts,
  WorkspaceError,
  type Preview,
  type Summary,
} from "./workspace-parts";
import type { KnowledgeTab } from "./knowledge";
import { sourceExpiry } from "./overview";
import { useIndexStatus, type SourceIndexStatus } from "./index-status";

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
function SourceList({
  data,
  refresh,
  t,
}: {
  data: Summary;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale, isOwner, revision } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const index = useIndexStatus(project.id, revision);
  const focused = useSearchParams()?.get("source") ?? null;
  const [confirmRefresh, setConfirmRefresh] = useState<Entity | null>(null);
  const drafts = visibleDrafts(data.drafts);
  useEffect(() => {
    if (!focused) return;
    const row = document.getElementById(`knowledge-source-${focused}`);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }, [focused]);
  const refreshSource = async (d: Entity) => {
    setConfirmRefresh(null);
    const p = await mutation.run(() =>
      action<Preview>(project.id, "knowledge-draft-preview", { draftId: d.id }),
    );
    if (p)
      window.location.assign(
        `${shell.hrefOf("knowledge-import")}?draft=${d.id}&preview=${p.id}`,
      );
  };
  return (
    <section className="stack-gap">
      {!drafts.length && !data.sources.length && (
        <Empty title={t.noSources} description={t.emptyHint} />
      )}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      {confirmRefresh && (
        <Modal
          title={t.refreshTitle}
          description={t.refreshHint}
          onClose={() => setConfirmRefresh(null)}
        >
          <div className="form-actions">
            <Button variant="outline" onClick={() => setConfirmRefresh(null)}>
              {t.cancel}
            </Button>
            <Button
              disabled={mutation.pending}
              onClick={() => refreshSource(confirmRefresh)}
            >
              {t.refreshConfirm}
            </Button>
          </div>
        </Modal>
      )}
      {drafts.map((d) => {
        const i = d.data.input as KnowledgeDraft;
        const active = data.runs.find((r) => r.id === d.data.activeRunId);
        // Runs arrive newest first; only the latest one's outcome still counts.
        const latest = data.runs.find((r) => r.data.draftId === d.id);
        const failed =
          !active && ["failed", "unknown"].includes(String(latest?.data.status))
            ? latest
            : undefined;
        // "Read successfully before": the draft has a successful read date, or
        // one of its runs completed. Either way there is something to edit.
        const readBefore =
          Boolean(d.data.lastSuccessfulSyncAt) ||
          data.runs.some(
            (r) => r.data.draftId === d.id && r.data.status === "completed",
          );
        const outcome =
          !active && latest?.data.status === "completed" ? latest : undefined;
        const status =
          active?.data.status ??
          failed?.data.status ??
          (d.data.status === "draft" && d.data.lastSuccessfulSyncAt
            ? "ready"
            : d.data.status);
        return (
          <article className="knowledge-source" key={d.id}>
            <div>
              <h2>{i.name}</h2>
              <p>
                {t[i.kind]}
                {i.repository ? ` · ${i.repository}` : ""}
              </p>
              <Badge tone={failed ? "danger" : "neutral"}>
                {workspaceStatus(String(status), t)}
              </Badge>
              <p>
                {t.lastRead}: {when(d.data.lastSuccessfulSyncAt, locale)}
              </p>
              {active && <p role="status">{t.runningHint}</p>}
              {outcome && typeof outcome.data.proposalCount === "number" && (
                <p>
                  {t.analysisProposals.replace(
                    "{n}",
                    String(outcome.data.proposalCount),
                  )}
                  {Number(outcome.data.costMicros) > 0 &&
                    ` · ${t.analysisCost.replace("{cost}", costText(Number(outcome.data.costMicros), t))}`}
                </p>
              )}
              {outcome && Number(outcome.data.droppedProposals) > 0 && (
                <p>
                  {t.analysisDropped.replace(
                    "{n}",
                    String(outcome.data.droppedProposals),
                  )}
                </p>
              )}
              {failed && (
                <WorkspaceError code={String(failed.data.error ?? "")} t={t} />
              )}
              {data.proposals.some((p) => p.data.draftId === d.id) && (
                <details>
                  <summary>{t.history}</summary>
                  {data.proposals
                    .filter((p) => p.data.draftId === d.id)
                    .map((p) => (
                      <Proposal
                        key={p.id}
                        proposal={p}
                        review={false}
                        refresh={refresh}
                        t={t}
                      />
                    ))}
                </details>
              )}
            </div>
            {isOwner && (
              <div className="form-actions">
                <Button
                  variant="outline"
                  disabled={mutation.pending || Boolean(active)}
                  onClick={() => setConfirmRefresh(d)}
                >
                  <RefreshCw aria-hidden="true" />
                  {t.update}
                </Button>
                <AppLink
                  className="text-link"
                  href={`${shell.hrefOf("knowledge-import")}?draft=${d.id}`}
                >
                  {readBefore ? t.edit : t.resume}
                </AppLink>
              </div>
            )}
          </article>
        );
      })}
      {listedSources(data.sources).map((s) => (
        <ManagedSource
          key={s.id}
          source={s}
          index={index.byId.get(s.id)}
          hasFacts={data.facts.some(
            (f) => f.data.sourceId === s.id && f.data.status !== "revoked",
          )}
          siteRun={data.siteRuns?.find((r) => r.data.sourceId === s.id)}
          focused={focused === s.id}
          refresh={() => {
            refresh();
            index.refresh();
          }}
          t={t}
        />
      ))}
    </section>
  );
}
/**
 * A source that is maintained directly rather than through the review flow:
 * its one current state, what that means, and the owner's next step.
 */
function ManagedSource({
  source: s,
  index,
  hasFacts,
  siteRun,
  focused,
  refresh,
  t,
}: {
  source: Entity;
  index: SourceIndexStatus | undefined;
  hasFacts: boolean;
  /** The source's latest site read, when it is a GitBook or website source. */
  siteRun?: Entity;
  focused: boolean;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const [removing, setRemoving] = useState(false);
  const [alreadyRunning, setAlreadyRunning] = useState(false);
  const now = useMemo(() => Date.now(), [s]);
  const isSite = ["gitbook", "website"].includes(String(s.data.type));
  // Read now and weekly updates need the page list of a first read.
  const hasSite = Boolean(s.data.site);
  const reading = siteRun ? siteRunActive(siteRun.data.status) : false;
  const weekly = Number(s.data.syncEveryHours ?? 0) > 0;
  const paused = s.data.status === "paused";
  const expiry = sourceExpiry(s.data, now);
  const empty = index?.documents === 0;
  const date = expiry.expiresAt
    ? when(expiry.expiresAt.toISOString(), locale)
    : "";
  const state = paused
    ? { label: t.paused, tone: "neutral" as const, hint: t.pausedHint }
    : expiry.state === "stale" && !expiry.expiresAt
      ? {
          label: t.neverRead,
          tone: "danger" as const,
          hint: empty ? t.neverReadEmpty : t.neverReadHint,
        }
      : expiry.state === "stale"
        ? {
            label: t.staleSource,
            tone: "danger" as const,
            hint: t.staleHint.replace("{date}", date),
          }
        : expiry.state === "expiring"
          ? {
              label: t.expiringSource,
              tone: "warning" as const,
              hint: t.expiringHint.replace("{date}", date),
            }
          : expiry.state === "manual"
            ? { label: t.manualSource, tone: "neutral" as const, hint: "" }
            : { label: t.freshSource, tone: "success" as const, hint: "" };
  const setPaused = (next: boolean) =>
    mutation.run(() =>
      action(project.id, "source-pause", { sourceId: s.id, paused: next }),
    );
  const readNow = async () => {
    setAlreadyRunning(false);
    const known = (s.data.site as { lastRunId?: string } | undefined)
      ?.lastRunId;
    const run = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-site-refresh", { sourceId: s.id }),
    );
    // An active run comes back as it is; it is not a new start.
    if (run && run.id === known) setAlreadyRunning(true);
  };
  const setWeekly = (autoUpdate: boolean) =>
    mutation.run(() =>
      action(project.id, "knowledge-site-settings", {
        sourceId: s.id,
        autoUpdate,
      }),
    );
  const remove = async () => {
    setRemoving(false);
    await mutation.run(() =>
      action(project.id, "revoke-source", { sourceId: s.id }),
    );
  };
  return (
    <article
      id={`knowledge-source-${s.id}`}
      tabIndex={-1}
      className={cn("knowledge-source", focused && "knowledge-source-focused")}
    >
      <div>
        <h2>{String(s.data.name)}</h2>
        <Badge tone={state.tone}>{state.label}</Badge>
        {state.hint && <p>{state.hint}</p>}
        <p>
          {t.lastRead}: {when(s.data.lastSuccessfulSyncAt, locale)}
        </p>
        {isSite && siteRun && <SiteRunSummary run={siteRun} t={t} />}
        {isSite && <p>{weekly ? t.weeklyIsOn : t.weeklyIsOff}</p>}
        {alreadyRunning && <Alert>{t.siteAlreadyRunning}</Alert>}
        {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      </div>
      <div className="form-actions">
        {hasSite && isOwner && !paused && (
          <Button
            variant="outline"
            disabled={mutation.pending || reading}
            onClick={readNow}
          >
            <RefreshCw aria-hidden="true" />
            {reading ? t.readNowRunning : t.readNow}
          </Button>
        )}
        {hasSite && isOwner && (
          <label className="knowledge-weekly">
            <input
              type="checkbox"
              checked={weekly}
              disabled={mutation.pending}
              onChange={(e) => setWeekly(e.target.checked)}
            />
            {t.weeklySwitch}
          </label>
        )}
        {isSite && isOwner && !paused && !reading && (
          <AppLink
            className="text-link"
            href={`${shell.hrefOf("knowledge-import")}?site=${s.id}`}
          >
            {t.readContents}
          </AppLink>
        )}
        {index && !empty && (
          <AppLink
            className="text-link"
            href={`${shell.hrefOf("knowledge-library")}?source=${s.id}`}
          >
            {t.library}
          </AppLink>
        )}
        {isOwner && index && (!isSite || !empty) && (
          <AppLink
            className="text-link"
            href={`${shell.hrefOf("knowledge-sources")}?expert=1&source=${s.id}`}
          >
            {empty ? t.readContents : t.manageSource}
          </AppLink>
        )}
        {isOwner && paused && (
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() => setPaused(false)}
          >
            <Play aria-hidden="true" />
            {t.resume}
          </Button>
        )}
        {isOwner && index && !paused && !empty && (
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() => setPaused(true)}
          >
            <Pause aria-hidden="true" />
            {t.pause}
          </Button>
        )}
        {isOwner && empty && !hasFacts && (
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
      {removing && (
        <Modal
          title={t.removeSourceTitle}
          description={t.removeSourceHint}
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
function Proposal({
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
