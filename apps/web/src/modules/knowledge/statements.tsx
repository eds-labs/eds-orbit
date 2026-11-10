"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  ExternalLink,
  Pencil,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { action, useMutation, useResource, when, type Entity } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  Textarea,
} from "@/components/ui/primitives";
import type { KnowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace";
import {
  bulkSummary,
  confirmAll,
  decisionPayload,
  effectiveRights,
  effectiveStatement,
  groupByTopic,
  MAX_STATEMENT_LENGTH,
  selectable,
  type EffectiveRights,
  type StatementEdit,
  draftReplaced,
} from "./statements-model";
import { workspaceStatus, type KnowledgeCopy } from "./workspace-text";
import { Field, WorkspaceError, type Summary } from "./workspace-parts";

const textOf = (p: Entity) => String(p.data.statement ?? p.data.value ?? "");

/**
 * Withdrawing a fact or pausing a source elsewhere leaves the proposal
 * "accepted"; what is really in use decides, so the list never calls unused
 * knowledge confirmed.
 */
function removedCheck(data: Summary) {
  const paused = pausedSources(data);
  const factStatus = new Map(data.facts.map((f) => [f.id, f.data.status]));
  return (p: Entity) =>
    p.data.status === "removed" ||
    (p.data.status === "accepted" &&
      (factStatus.get(String(p.data.factId)) === "revoked" ||
        paused.has(String(p.data.sourceId))));
}
const pausedSources = (data: Summary) =>
  new Set(
    data.sources.filter((s) => s.data.status === "paused").map((s) => s.id),
  );
export const countRemoved = (data: Summary) =>
  data.proposals.filter(removedCheck(data)).length;

/** Listed and still selectable; the same set when nothing dropped out. */
export function keptSelection(
  selected: Set<string>,
  listed: Entity[],
  drafts: Entity[],
  edits: Record<string, StatementEdit>,
): Set<string> {
  const kept = new Set(
    listed
      .filter((p) => selected.has(p.id) && selectable(p, drafts, edits[p.id]))
      .map((p) => p.id),
  );
  return kept.size === selected.size ? selected : kept;
}

/** The message `useMutation` would show: the API's error code. */
const codeOf = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

export function StatementList({
  data,
  review,
  query,
  listingRemoved,
  refresh,
  t,
}: {
  data: Summary;
  review: boolean;
  query: string;
  listingRemoved: boolean;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, isOwner } = useWorkspace();
  const shell = useShell();
  // Above the cards: a card is keyed by its version and may leave the list.
  const [edits, setEdits] = useState<Record<string, StatementEdit>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const bulk = useMutation(refresh);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isRemoved = removedCheck(data);
  const listed = data.proposals.filter((p) =>
    review
      ? ["pending", "needs_review"].includes(String(p.data.status))
      : listingRemoved
        ? isRemoved(p)
        : p.data.status === "accepted" && !isRemoved(p),
  );
  const needle = query.toLowerCase();
  const filtered = listed.filter((p) =>
    textOf(p).toLowerCase().includes(needle),
  );
  const paused = pausedSources(data);
  const oldFacts =
    review || listingRemoved
      ? []
      : data.facts.filter(
          (f) =>
            f.data.status === "verified" &&
            !String(f.data.key).startsWith("knowledge.") &&
            !paused.has(String(f.data.sourceId)) &&
            String(f.data.value).toLowerCase().includes(needle),
        );

  // Adjusted during render so a dropped id never reaches the bar.
  const kept = keptSelection(selected, listed, data.drafts, edits);
  if (kept !== selected) setSelected(kept);
  const staleEdits = Object.keys(edits).filter(
    (id) => !listed.some((p) => p.id === id),
  );
  if (staleEdits.length)
    setEdits(
      Object.fromEntries(
        Object.entries(edits).filter(([id]) => !staleEdits.includes(id)),
      ),
    );

  // A statement hidden by the search stays selected but is not confirmed:
  // the bar only ever acts on what the owner can see.
  const chosen = filtered.filter((p) => kept.has(p.id));
  const changed = review
    ? filtered.filter((p) => p.data.status === "needs_review")
    : [];
  const groups = groupByTopic(filtered.filter((p) => !changed.includes(p)));

  const edit = (id: string, patch: StatementEdit) =>
    setEdits((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
  const select = (ids: string[], on: boolean) => {
    setResult(null);
    setSelected((all) => {
      const next = new Set(all);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  const confirmSelection = () =>
    bulk.run(async () => {
      setResult(null);
      setFailures({});
      const outcome = await confirmAll(
        chosen,
        async (p) => {
          // Leaving the page stops the remainder; those stay pending.
          if (!mounted.current) throw new Error("PAGE_LEFT");
          await action(
            project.id,
            "knowledge-proposal-decide",
            decisionPayload(p, data.drafts, edits[p.id]),
          );
        },
        codeOf,
      );
      setFailures(
        Object.fromEntries(outcome.failed.map((f) => [f.id, f.code])),
      );
      select(outcome.done, false);
      setResult(
        t.bulkResult
          .replace("{done}", String(outcome.done.length))
          .replace("{total}", String(chosen.length)),
      );
    });

  const card = (p: Entity) =>
    review && p.data.status !== "needs_review" ? (
      <ReviewCard
        key={`${p.id}:${p.version}`}
        proposal={p}
        drafts={data.drafts}
        edit={edits[p.id]}
        onEdit={(patch) => edit(p.id, patch)}
        selected={kept.has(p.id)}
        onSelect={(on) => select([p.id], on)}
        failure={failures[p.id]}
        busy={bulk.pending}
        refresh={refresh}
        t={t}
      />
    ) : (
      <Proposal
        key={`${p.id}:${p.version}`}
        proposal={p}
        review={review}
        manage={!review && !listingRemoved}
        removed={listingRemoved}
        facts={data.facts}
        refresh={refresh}
        t={t}
      />
    );

  return (
    <div className="knowledge-statement-list stack-gap">
      {!filtered.length && !oldFacts.length ? (
        <Empty
          title={query ? t.noMatch : review ? t.noReview : t.empty}
          description={review ? t.noReviewHint : t.emptyHint}
        />
      ) : (
        <>
          {changed.length > 0 && (
            <TopicGroup title={t.changedGroup} count={changed.length}>
              {changed.map(card)}
            </TopicGroup>
          )}
          {groups.map(({ topic, items }) => {
            const open = items.filter((p) =>
              selectable(p, data.drafts, edits[p.id]),
            );
            return (
              <TopicGroup
                key={topic}
                title={t[topic]}
                count={items.length}
                action={
                  review && isOwner && open.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={bulk.pending}
                      onClick={() =>
                        select(
                          open.map((p) => p.id),
                          true,
                        )
                      }
                    >
                      {t.selectAll}
                    </Button>
                  ) : undefined
                }
              >
                {items.map(card)}
              </TopicGroup>
            );
          })}
          {oldFacts.length > 0 && (
            <TopicGroup title={t.otherKnowledge} count={oldFacts.length}>
              {oldFacts.map((f) => (
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
                      {t.technical}
                    </AppLink>
                  </details>
                </article>
              ))}
            </TopicGroup>
          )}
        </>
      )}
      {isOwner && (chosen.length > 0 || result) && (
        <BulkBar
          summary={
            chosen.length > 0
              ? bulkSummary(chosen, data.drafts, edits, t)
              : null
          }
          running={bulk.pending}
          result={result}
          onConfirm={() => void confirmSelection()}
          t={t}
        />
      )}
    </div>
  );
}

function TopicGroup({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="knowledge-topic">
      <div className="knowledge-topic-head">
        <h2>
          {title} <span className="knowledge-topic-count">{count}</span>
        </h2>
        {action}
      </div>
      <div className="knowledge-statements">{children}</div>
    </section>
  );
}

export function BulkBar({
  summary,
  running,
  result,
  onConfirm,
  t,
}: {
  /** Null once nothing is selected; the result line may still be showing. */
  summary: { text: string; needsPublicNote: boolean } | null;
  running: boolean;
  result: string | null;
  onConfirm: () => void;
  t: KnowledgeCopy;
}) {
  return (
    <div className="knowledge-bulk-bar">
      <div className="knowledge-bulk-text">
        {summary && <p className="knowledge-bulk-summary">{summary.text}</p>}
        {summary?.needsPublicNote && <p>{t.publicNeeded}</p>}
        {result && <p role="status">{result}</p>}
      </div>
      {summary && (
        <Button disabled={running} onClick={onConfirm}>
          <CheckCircle2 aria-hidden="true" />
          {t.bulkConfirm}
        </Button>
      )}
    </div>
  );
}

/** The statement text and the three rights; every change goes to the card's edit. */
export function AdjustForm({
  statement,
  rights,
  onChange,
  busy = false,
  t,
}: {
  statement: string;
  rights: EffectiveRights;
  onChange: (patch: StatementEdit) => void;
  /** A request is on its way with the values fixed at the click. */
  busy?: boolean;
  t: KnowledgeCopy;
}) {
  return (
    <div className="stack-gap">
      <Field label={t.statement}>
        <Textarea
          required
          maxLength={MAX_STATEMENT_LENGTH}
          value={statement}
          disabled={busy}
          onChange={(e) => onChange({ statement: e.target.value })}
        />
      </Field>
      <fieldset className="knowledge-usage">
        <legend>{t.usage}</legend>
        <label>
          <input
            type="checkbox"
            checked={rights.marketing}
            disabled={busy}
            onChange={(e) => onChange({ marketing: e.target.checked })}
          />
          {t.marketing}
        </label>
        <label>
          <input
            type="checkbox"
            checked={rights.support}
            disabled={busy}
            onChange={(e) => onChange({ support: e.target.checked })}
          />
          {t.support}
        </label>
        <label>
          <input
            type="checkbox"
            checked={rights.publicUse}
            disabled={busy}
            onChange={(e) => onChange({ publicUse: e.target.checked })}
          />
          {t.publicUse}
        </label>
      </fieldset>
      {!rights.publicUse && (rights.marketing || rights.support) && (
        <Alert>{t.publicNeeded}</Alert>
      )}
    </div>
  );
}

/** Where the evidence sits, its quote and its link. */
function Evidence({
  evidence,
  commit = false,
  t,
}: {
  evidence: Record<string, any>;
  commit?: boolean;
  t: KnowledgeCopy;
}) {
  return (
    <>
      <p>
        {String(evidence.path)} · {String(evidence.startLine)}–
        {String(evidence.endLine)}
      </p>
      {commit && evidence.commit && (
        <p className="knowledge-path">
          {t.commit}: {String(evidence.commit)}
        </p>
      )}
      <blockquote className="knowledge-quote">
        {String(evidence.quote)}
      </blockquote>
      {evidence.url && (
        <a
          className="text-link"
          href={String(evidence.url)}
          target="_blank"
          rel="noreferrer"
        >
          {t.evidence}
          <ExternalLink aria-hidden="true" />
        </a>
      )}
    </>
  );
}

function rightsLine(rights: EffectiveRights, t: KnowledgeCopy) {
  const audiences =
    rights.marketing && rights.support
      ? t.bulkBoth
      : rights.marketing
        ? t.marketing
        : t.support;
  return `${audiences} · ${rights.publicUse ? t.public : t.internal}`;
}

export function ReviewCard({
  proposal: p,
  drafts,
  edit,
  onEdit,
  selected,
  onSelect,
  failure,
  busy,
  refresh,
  t,
}: {
  proposal: Entity;
  drafts: Entity[];
  edit?: StatementEdit;
  onEdit: (patch: StatementEdit) => void;
  selected: boolean;
  onSelect: (on: boolean) => void;
  /** Why this card failed in the last bulk confirm. */
  failure?: string;
  /** A bulk confirm is running. */
  busy: boolean;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, isOwner, locale } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const [adjusting, setAdjusting] = useState(false);
  const [history, setHistory] = useState(false);
  const d = p.data as Record<string, any>;
  const rights = effectiveRights(p, drafts, edit);
  const canConfirm = selectable(p, drafts, edit);
  const replaced = draftReplaced(p, drafts);
  const sourceName = (
    drafts.find((x) => x.id === d.draftId)?.data.input as
      KnowledgeDraft | undefined
  )?.name;
  const headingId = `statement-${p.id}`;
  const error = mutation.error ?? failure;
  const pending = mutation.pending || busy;
  const confirm = () =>
    mutation.run(() =>
      action(
        project.id,
        "knowledge-proposal-decide",
        decisionPayload(p, drafts, edit),
      ),
    );
  // Only the id, version and decision: rejecting needs no valid text or audience.
  const reject = () =>
    mutation.run(() =>
      action(project.id, "knowledge-proposal-decide", {
        proposalId: p.id,
        version: p.version,
        decision: "reject",
      }),
    );
  return (
    <article className="knowledge-statement">
      <div className="knowledge-review-head">
        {isOwner && canConfirm && (
          <label className="knowledge-review-check">
            <input
              type="checkbox"
              aria-labelledby={headingId}
              checked={selected}
              disabled={busy}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>
        )}
        <h3 id={headingId}>{effectiveStatement(p, edit)}</h3>
      </div>
      {sourceName && <p className="knowledge-review-source">{sourceName}</p>}
      {d.evidence && <Evidence evidence={d.evidence} t={t} />}
      {d.reason && <p>{String(d.reason)}</p>}
      {replaced ? (
        <Alert kind="warning">{t.replacedHint}</Alert>
      ) : rights.marketing || rights.support ? (
        <p className="knowledge-review-rights">{rightsLine(rights, t)}</p>
      ) : (
        isOwner && <Alert kind="warning">{t.noAudienceHint}</Alert>
      )}
      <details>
        <summary>{t.moreEvidence}</summary>
        {d.stage && <p>{workspaceStatus(String(d.stage), t)}</p>}
        <p>{t.stageHint}</p>
        {d.evidence?.commit && (
          <p className="knowledge-path">
            {t.commit}: {String(d.evidence.commit)}
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
      {isOwner && (
        <>
          {adjusting && (
            <AdjustForm
              statement={effectiveStatement(p, edit)}
              rights={rights}
              onChange={onEdit}
              busy={pending}
              t={t}
            />
          )}
          {error && <WorkspaceError code={error} t={t} />}
          <div className="form-actions">
            {!replaced && (
              <Button disabled={pending || !canConfirm} onClick={confirm}>
                <CheckCircle2 aria-hidden="true" />
                {t.accept}
              </Button>
            )}
            <Button variant="outline" disabled={pending} onClick={reject}>
              {t.reject}
            </Button>
            {!replaced && (
              <Button
                variant="ghost"
                aria-expanded={adjusting}
                disabled={pending}
                onClick={() => setAdjusting(!adjusting)}
              >
                <SlidersHorizontal aria-hidden="true" />
                {t.adjust}
              </Button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

export function Proposal({
  proposal: p,
  review,
  manage = false,
  removed = false,
  facts = [],
  refresh,
  t,
}: {
  proposal: Entity;
  review: boolean;
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
              maxLength={MAX_STATEMENT_LENGTH}
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
        <h3>{String(d.statement)}</h3>
      )}
      {changed && <Alert kind="warning">{t.changedHint}</Alert>}
      <details>
        <summary>{t.evidence}</summary>
        <p>{t.stageHint}</p>
        {d.evidence && <Evidence evidence={d.evidence} commit t={t} />}
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

export function ProposalHistory({
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
