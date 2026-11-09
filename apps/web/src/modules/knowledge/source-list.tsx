"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { cn } from "@/lib/utils";
import { action, useMutation, when, type Entity } from "@/lib/api";
import { Alert, Badge, Button, Empty, Modal } from "@/components/ui/primitives";
import type { SourceIndexStatus } from "./index-status";
import { useIndexStatus } from "./index-status";
import { sourceRows, type SourceRow } from "./source-rows";
import {
  costText,
  SiteRunSummary,
  WorkspaceError,
  type Preview,
  type Summary,
} from "./workspace-parts";
import { Proposal } from "./statements";
import type { KnowledgeCopy } from "./workspace-text";

export type MoreEntry =
  | "edit"
  | "resume"
  | "manage"
  | "update"
  | "read-in-content"
  | "pause"
  | "weekly"
  | "history"
  | "library"
  | "remove";

type MoreContext = {
  isOwner: boolean;
  index: SourceIndexStatus | undefined;
  /** Whether the source still has facts that are not revoked. */
  hasFacts: boolean;
  /** Whether the draft has proposals to show as history. */
  hasHistory: boolean;
};

/**
 * What the "More" menu offers for a row. Each entry keeps the condition it had
 * on the old rows, and an entry that is the row's primary action is left out.
 * Readers get the library link and the read-only history, nothing else.
 */
export function moreEntries(row: SourceRow, c: MoreContext): MoreEntry[] {
  const entries: MoreEntry[] = [];
  const e = row.entity.data;
  const primary = row.primary?.kind;
  const reading = row.status === "reading";
  if (row.origin === "draft") {
    const kind = String((e.input as { kind?: string } | undefined)?.kind ?? "");
    if (c.isOwner && primary !== "draft-edit") entries.push("edit");
    // Text and uploaded documents have nothing to re-read.
    if (
      c.isOwner &&
      !reading &&
      primary !== "draft-update" &&
      (kind === "github" || kind === "website")
    )
      entries.push("update");
    if (c.hasHistory) entries.push("history");
    return entries;
  }
  const type = String(e.type ?? "");
  const isSite = type === "website" || type === "gitbook";
  const hasSite = Boolean(e.site);
  const paused = e.status === "paused";
  const empty = c.index?.documents === 0;
  // A paused source whose site read is still running has no primary action.
  if (c.isOwner && paused && primary !== "resume") entries.push("resume");
  if (c.isOwner && c.index && (!isSite || !empty) && primary !== "expert")
    entries.push("manage");
  if (c.isOwner && hasSite && !paused && !reading && primary !== "site-refresh")
    entries.push("update");
  if (c.isOwner && isSite && !paused && !reading && primary !== "site-import")
    entries.push("read-in-content");
  if (c.isOwner && c.index && !paused && !empty) entries.push("pause");
  if (c.isOwner && hasSite) entries.push("weekly");
  if (c.index && !empty) entries.push("library");
  if (c.isOwner && empty && !c.hasFacts) entries.push("remove");
  return entries;
}

export function SourceList({
  data,
  refresh,
  t,
}: {
  data: Summary;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale, revision } = useWorkspace();
  const index = useIndexStatus(project.id, revision);
  const focused = useSearchParams()?.get("source") ?? null;
  const now = useMemo(() => Date.now(), [data]);
  const rows = sourceRows(data, index.byId, now, t, locale);
  useEffect(() => {
    if (!focused) return;
    const row = document.getElementById(`knowledge-source-${focused}`);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }, [focused]);
  return (
    <section className="stack-gap">
      {!rows.length && <Empty title={t.noSources} description={t.emptyHint} />}
      {rows.map((row) => (
        <SourceRowView
          key={`${row.origin}-${row.id}`}
          row={row}
          data={data}
          index={index.byId.get(row.id)}
          focused={focused === row.id}
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

function SourceRowView({
  row,
  data,
  index,
  focused,
  refresh,
  t,
}: {
  row: SourceRow;
  data: Summary;
  index: SourceIndexStatus | undefined;
  focused: boolean;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [alreadyRunning, setAlreadyRunning] = useState(false);
  const e = row.entity;
  const isDraft = row.origin === "draft";
  const reading = row.status === "reading";
  const type = String(e.data.type ?? "");
  const isSite = !isDraft && (type === "website" || type === "gitbook");
  const siteRun = isSite
    ? data.siteRuns?.find((r) => r.data.sourceId === row.id)
    : undefined;
  const weekly = Number(e.data.syncEveryHours ?? 0) > 0;
  const empty = index?.documents === 0;
  const hasFacts =
    !isDraft &&
    data.facts.some(
      (f) => f.data.sourceId === row.id && f.data.status !== "revoked",
    );
  const proposals = isDraft
    ? data.proposals.filter((p) => p.data.draftId === row.id)
    : [];
  const draftInput = (e.data.input ?? {}) as {
    repository?: string;
    kind?: string;
  };
  // Runs arrive newest first; the latest completed analysis tells the outcome.
  const latest = isDraft
    ? data.runs.find((r) => r.data.draftId === row.id)
    : undefined;
  const outcome =
    !reading && latest?.data.status === "completed" ? latest : undefined;
  const entries = moreEntries(row, {
    isOwner,
    index,
    hasFacts,
    hasHistory: proposals.length > 0,
  });
  const importHref = shell.hrefOf("knowledge-import");
  const siteBusy = mutation.pending || reading;

  const readNow = async () => {
    setAlreadyRunning(false);
    const known = (e.data.site as { lastRunId?: string } | undefined)
      ?.lastRunId;
    const run = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-site-refresh", {
        sourceId: row.id,
      }),
    );
    // An active run comes back as it is; it is not a new start.
    if (run && run.id === known) setAlreadyRunning(true);
  };
  const setPaused = (paused: boolean) =>
    mutation.run(() =>
      action(project.id, "source-pause", { sourceId: row.id, paused }),
    );
  const setWeekly = (autoUpdate: boolean) =>
    mutation.run(() =>
      action(project.id, "knowledge-site-settings", {
        sourceId: row.id,
        autoUpdate,
      }),
    );
  const remove = async () => {
    setRemoving(false);
    await mutation.run(() =>
      action(project.id, "revoke-source", { sourceId: row.id }),
    );
  };
  const refreshDraft = async () => {
    setConfirmRefresh(false);
    const p = await mutation.run(() =>
      action<Preview>(project.id, "knowledge-draft-preview", {
        draftId: row.id,
      }),
    );
    if (p)
      window.location.assign(`${importHref}?draft=${row.id}&preview=${p.id}`);
  };

  const primary = isOwner ? row.primary : null;
  let primaryControl: React.ReactNode = null;
  if (primary?.kind === "resume")
    primaryControl = (
      <Button
        variant="outline"
        disabled={mutation.pending}
        onClick={() => setPaused(false)}
      >
        <Play aria-hidden="true" />
        {t.resume}
      </Button>
    );
  else if (primary?.kind === "site-refresh")
    primaryControl = (
      <Button variant="outline" disabled={siteBusy} onClick={readNow}>
        <RefreshCw aria-hidden="true" />
        {row.status === "failed" ? t.retry : t.rowUpdate}
      </Button>
    );
  else if (primary?.kind === "site-import")
    primaryControl = (
      <Button asChild variant="outline">
        <AppLink href={`${importHref}?site=${row.id}`}>
          {t.readContents}
        </AppLink>
      </Button>
    );
  else if (primary?.kind === "expert")
    primaryControl = (
      <Button asChild variant="outline">
        <AppLink
          href={`${shell.hrefOf("knowledge-sources")}?expert=1&source=${row.id}`}
        >
          {empty ? t.readContents : t.manageSource}
        </AppLink>
      </Button>
    );
  else if (primary?.kind === "review")
    primaryControl = (
      <Button asChild variant="outline">
        <AppLink href={shell.hrefOf("knowledge-review")}>{t.rowReview}</AppLink>
      </Button>
    );
  else if (primary?.kind === "draft-edit")
    primaryControl = (
      <Button asChild variant="outline">
        <AppLink href={`${importHref}?draft=${row.id}`}>
          {row.status === "failed" ? t.retry : t.rowContinueSetup}
        </AppLink>
      </Button>
    );
  else if (primary?.kind === "draft-update")
    primaryControl = (
      <Button
        variant="outline"
        disabled={mutation.pending}
        onClick={() => setConfirmRefresh(true)}
      >
        <RefreshCw aria-hidden="true" />
        {t.rowUpdate}
      </Button>
    );

  return (
    <article
      id={`knowledge-source-${row.id}`}
      tabIndex={-1}
      className={cn("knowledge-source", focused && "knowledge-source-focused")}
    >
      <div className="knowledge-source-body">
        <h2>{row.name}</h2>
        <p>
          {row.kindLabel}
          {draftInput.repository ? ` · ${draftInput.repository}` : ""}
        </p>
        <Badge tone={row.tone}>{row.label}</Badge>
        {row.errorCode ? (
          <WorkspaceError code={row.errorCode} t={t} />
        ) : (
          row.sentence &&
          // A running site read shows its own hint with the progress.
          !(siteRun && reading) && (
            <p role={reading ? "status" : undefined}>{row.sentence}</p>
          )
        )}
        <p>
          {t.lastRead}: {when(row.lastRead, locale)}
        </p>
        {siteRun && row.status !== "failed" && (
          <SiteRunSummary run={siteRun} t={t} />
        )}
        {isSite && <p>{weekly ? t.weeklyIsOn : t.weeklyIsOff}</p>}
        {alreadyRunning && <Alert>{t.siteAlreadyRunning}</Alert>}
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
        {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      </div>
      {(primaryControl || entries.length > 0) && (
        <div className="form-actions knowledge-source-actions">
          {primaryControl}
          {entries.length > 0 && (
            <MoreMenu label={t.moreMenu}>
              {entries.map((entry) => {
                if (entry === "edit")
                  return (
                    <AppLink
                      key={entry}
                      role="menuitem"
                      className="knowledge-more-item"
                      href={`${importHref}?draft=${row.id}`}
                    >
                      {t.edit}
                    </AppLink>
                  );
                if (entry === "resume")
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="menuitem"
                      className="knowledge-more-item"
                      disabled={mutation.pending}
                      onClick={() => setPaused(false)}
                    >
                      <Play aria-hidden="true" />
                      {t.resume}
                    </button>
                  );
                if (entry === "manage")
                  return (
                    <AppLink
                      key={entry}
                      role="menuitem"
                      className="knowledge-more-item"
                      href={`${shell.hrefOf("knowledge-sources")}?expert=1&source=${row.id}`}
                    >
                      {empty ? t.readContents : t.manageSource}
                    </AppLink>
                  );
                if (entry === "update")
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="menuitem"
                      className="knowledge-more-item"
                      disabled={isDraft ? mutation.pending : siteBusy}
                      onClick={() =>
                        isDraft ? setConfirmRefresh(true) : readNow()
                      }
                    >
                      {t.rowUpdate}
                    </button>
                  );
                if (entry === "read-in-content")
                  return (
                    <AppLink
                      key={entry}
                      role="menuitem"
                      className="knowledge-more-item"
                      href={`${importHref}?site=${row.id}`}
                    >
                      {t.readContents}
                    </AppLink>
                  );
                if (entry === "pause")
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="menuitem"
                      className="knowledge-more-item"
                      disabled={mutation.pending}
                      onClick={() => setPaused(true)}
                    >
                      <Pause aria-hidden="true" />
                      {t.pause}
                    </button>
                  );
                if (entry === "weekly")
                  return (
                    <label
                      key={entry}
                      className="knowledge-more-item knowledge-weekly"
                    >
                      <input
                        type="checkbox"
                        checked={weekly}
                        disabled={mutation.pending}
                        onChange={(ev) => setWeekly(ev.target.checked)}
                      />
                      {t.weeklySwitch}
                    </label>
                  );
                if (entry === "history")
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="menuitem"
                      className="knowledge-more-item"
                      aria-expanded={showHistory}
                      onClick={() => setShowHistory((open) => !open)}
                    >
                      {t.history}
                    </button>
                  );
                if (entry === "library")
                  return (
                    <AppLink
                      key={entry}
                      role="menuitem"
                      className="knowledge-more-item"
                      href={`${shell.hrefOf("knowledge-library")}?source=${row.id}`}
                    >
                      {t.library}
                    </AppLink>
                  );
                return (
                  <button
                    key={entry}
                    type="button"
                    role="menuitem"
                    className="knowledge-more-item"
                    disabled={mutation.pending}
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    {t.remove}
                  </button>
                );
              })}
            </MoreMenu>
          )}
        </div>
      )}
      {showHistory && (
        <div className="knowledge-source-history">
          {proposals.map((p) => (
            <Proposal
              key={p.id}
              proposal={p}
              review={false}
              refresh={refresh}
              t={t}
            />
          ))}
        </div>
      )}
      {confirmRefresh && (
        <Modal
          title={t.refreshTitle}
          description={t.refreshHint}
          onClose={() => setConfirmRefresh(false)}
        >
          <div className="form-actions">
            <Button variant="outline" onClick={() => setConfirmRefresh(false)}>
              {t.cancel}
            </Button>
            <Button disabled={mutation.pending} onClick={refreshDraft}>
              {t.refreshConfirm}
            </Button>
          </div>
        </Modal>
      )}
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

/**
 * Choosing a link or button closes the menu. The weekly checkbox keeps it open
 * so its new state stays visible.
 */
export const shouldCloseMenu = (tag: string) => tag === "A" || tag === "BUTTON";

/** A details menu that closes on a click outside or Escape (like the user menu). */
function MoreMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (ev: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (
        ev instanceof KeyboardEvent
          ? ev.key === "Escape"
          : !menu.contains(ev.target as Node)
      )
        menu.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details className="knowledge-more" ref={ref}>
      <summary className="button button-ghost">
        <MoreHorizontal aria-hidden="true" />
        {label}
      </summary>
      <div
        className="knowledge-more-panel"
        role="menu"
        onClick={(ev) => {
          const item = (ev.target as Element).closest("a, button");
          if (item && shouldCloseMenu(item.tagName) && ref.current)
            ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
