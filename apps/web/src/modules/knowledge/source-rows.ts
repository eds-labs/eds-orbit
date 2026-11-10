import type { Entity } from "@/lib/api";
import { when } from "@/lib/api";
import { sourceExpiry } from "./overview";
import type { SourceIndexStatus } from "./index-status";
import {
  analysisRunning,
  knowledgeErrorText,
  listedSources,
  siteRunActive,
  visibleDrafts,
  type Summary,
} from "./workspace-parts";
import type { KnowledgeCopy } from "./workspace-text";

/** Days after the last successful read when a reminder shows (decision D-3). */
export const SOURCE_REMINDER_DAYS = 30;

const DAY = 86_400_000;

export type SourceRowStatus =
  | "reading"
  | "paused"
  | "failed"
  | "waiting"
  | "not_finished"
  | "never_read"
  | "out_of_date"
  | "reminder"
  | "up_to_date";

export type SourceRowAction =
  | { kind: "site-refresh"; sourceId: string }
  | { kind: "site-import"; sourceId: string }
  | { kind: "expert"; sourceId: string }
  | { kind: "resume"; sourceId: string }
  | { kind: "review" }
  | { kind: "draft-edit"; draftId: string }
  | { kind: "draft-update"; draftId: string };

export type SourceRow = {
  id: string;
  origin: "draft" | "source";
  entity: Entity;
  name: string;
  kindLabel: string;
  status: SourceRowStatus;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  sentence: string;
  lastRead: unknown;
  errorCode?: string;
  primary: SourceRowAction | null;
};

// Needs the owner first (failed to out of date), then what is in progress.
const RANK: Record<SourceRowStatus, number> = {
  failed: 0,
  waiting: 1,
  not_finished: 2,
  never_read: 2,
  out_of_date: 3,
  reminder: 4,
  reading: 5,
  paused: 6,
  up_to_date: 7,
};

// A stopped site read is not a failure of the source.
const NOT_A_FAILURE = ["SOURCE_INACTIVE", "KNOWLEDGE_DISABLED"];

const isSiteType = (type: unknown) => type === "website" || type === "gitbook";

type Core = Pick<
  SourceRow,
  "status" | "label" | "tone" | "sentence" | "errorCode" | "primary"
>;

function draftRow(
  d: Entity,
  data: Summary,
  now: number,
  t: KnowledgeCopy,
  de: boolean,
): SourceRow {
  const input = (d.data.input ?? {}) as { kind?: string; name?: string };
  const kind = String(input.kind ?? "");
  const edit = { kind: "draft-edit", draftId: d.id } as const;
  // Runs arrive newest first; only the latest one's outcome still counts.
  const latest = data.runs.find((r) => r.data.draftId === d.id);
  const active =
    data.runs.some((r) => r.id === d.data.activeRunId) ||
    analysisRunning(String(latest?.data.status));
  const completed = data.runs.some(
    (r) => r.data.draftId === d.id && r.data.status === "completed",
  );
  const waiting = data.proposals.filter(
    (p) =>
      p.data.draftId === d.id &&
      ["pending", "needs_review"].includes(String(p.data.status)),
  ).length;
  const synced = Date.parse(String(d.data.lastSuccessfulSyncAt ?? ""));
  const days = Number.isNaN(synced) ? null : Math.floor((now - synced) / DAY);
  const byHand = kind === "manual" || kind === "file";
  let core: Core;
  if (active)
    core = {
      status: "reading",
      label: t.rowReading,
      tone: "neutral",
      sentence: t.runningHint,
      primary: null,
    };
  else if (["failed", "unknown"].includes(String(latest?.data.status))) {
    const code = String(latest?.data.error ?? "");
    core = {
      status: "failed",
      label: t.rowFailed,
      tone: "danger",
      sentence: knowledgeErrorText(code, t, de),
      errorCode: code || undefined,
      primary: edit,
    };
  } else if (waiting)
    core = {
      status: "waiting",
      label:
        waiting === 1
          ? t.rowWaitingOne
          : t.rowWaiting.replace("{n}", String(waiting)),
      tone: "warning",
      sentence: "",
      primary: { kind: "review" },
    };
  else if (!completed)
    core = {
      status: "not_finished",
      label: t.rowNotFinished,
      tone: "warning",
      sentence: t.rowNotFinishedHint,
      primary: edit,
    };
  else if (
    !byHand &&
    days !== null &&
    days >= SOURCE_REMINDER_DAYS &&
    (kind === "github" || kind === "website")
  )
    core = {
      status: "reminder",
      label: t.rowReminder,
      tone: "warning",
      sentence: t.rowReminderHint.replace("{n}", String(days)),
      primary: { kind: "draft-update", draftId: d.id },
    };
  else
    core = {
      status: "up_to_date",
      label: byHand ? t.manualSource : t.freshSource,
      tone: byHand ? "neutral" : "success",
      sentence: "",
      primary: null,
    };
  return {
    id: d.id,
    origin: "draft",
    entity: d,
    name: String(input.name ?? ""),
    kindLabel: kind in t ? t[kind as keyof KnowledgeCopy] : kind,
    lastRead: d.data.lastSuccessfulSyncAt,
    ...core,
  };
}

function sourceLabel(type: string, t: KnowledgeCopy) {
  if (type === "gitbook") return "GitBook";
  if (type === "website") return t.website;
  if (type === "github") return t.github;
  if (type === "manual") return t.manual;
  if (type === "file") return t.file;
  return t.text;
}

function sourceRow(
  s: Entity,
  data: Summary,
  index: SourceIndexStatus | undefined,
  now: number,
  t: KnowledgeCopy,
  locale: string,
  de: boolean,
): SourceRow {
  const type = String(s.data.type ?? "");
  const site = isSiteType(type);
  const siteRun = data.siteRuns?.find((r) => r.data.sourceId === s.id);
  const expiry = sourceExpiry(s.data, now);
  const date = expiry.expiresAt
    ? when(expiry.expiresAt.toISOString(), locale)
    : "";
  const sourceId = s.id;
  // Without a site reader, a website or GitBook source is read through import.
  const read: SourceRowAction = site
    ? { kind: "site-import", sourceId }
    : { kind: "expert", sourceId };
  const errorCode = String(siteRun?.data.errorCode ?? "");
  let core: Core;
  if (siteRun && siteRunActive(siteRun.data.status))
    core = {
      status: "reading",
      label: t.rowReading,
      tone: "neutral",
      sentence: t.runningHint,
      primary: null,
    };
  else if (s.data.status === "paused")
    core = {
      status: "paused",
      label: t.paused,
      tone: "neutral",
      sentence: t.pausedHint,
      primary: { kind: "resume", sourceId },
    };
  else if (
    siteRun?.data.status === "failed" &&
    !NOT_A_FAILURE.includes(errorCode)
  )
    core = {
      status: "failed",
      label: t.rowFailed,
      tone: "danger",
      sentence: errorCode
        ? knowledgeErrorText(errorCode, t, de)
        : t.siteRunFailed,
      errorCode: errorCode || undefined,
      primary: { kind: "site-refresh", sourceId },
    };
  else if (expiry.state === "stale" && !expiry.expiresAt)
    core = {
      status: "never_read",
      label: t.neverRead,
      tone: "danger",
      sentence: index?.documents === 0 ? t.neverReadEmpty : t.neverReadHint,
      primary: read,
    };
  else if (expiry.state === "stale")
    core = {
      status: "out_of_date",
      label: t.staleSource,
      tone: "danger",
      sentence: t.staleHint.replace("{date}", date),
      primary: s.data.site ? { kind: "site-refresh", sourceId } : read,
    };
  else if (expiry.state === "expiring")
    core = {
      status: "up_to_date",
      label: t.freshSource,
      tone: "warning",
      sentence: t.expiringHint.replace("{date}", date),
      primary: null,
    };
  else if (expiry.state === "manual")
    core = {
      status: "up_to_date",
      label: t.manualSource,
      tone: "neutral",
      sentence: "",
      primary: null,
    };
  else
    core = {
      status: "up_to_date",
      label: t.freshSource,
      tone: "success",
      sentence: "",
      primary: null,
    };
  return {
    id: s.id,
    origin: "source",
    entity: s,
    name: String(s.data.name ?? ""),
    kindLabel: sourceLabel(type, t),
    lastRead: s.data.lastSuccessfulSyncAt,
    ...core,
  };
}

/**
 * One uniform row per visible draft and listed source: the first matching
 * status wins, rows that need the owner sort first, then by name.
 */
export function sourceRows(
  data: Summary,
  index: Map<string, SourceIndexStatus>,
  now: number,
  t: KnowledgeCopy,
  locale: string,
): SourceRow[] {
  const de = locale === "de";
  return [
    ...visibleDrafts(data.drafts).map((d) => draftRow(d, data, now, t, de)),
    ...listedSources(data.sources).map((s) =>
      sourceRow(s, data, index.get(s.id), now, t, locale, de),
    ),
  ].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name),
  );
}
