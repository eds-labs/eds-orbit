import { ApiError, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

/**
 * Content statuses the approvals page lists; archived drafts are not among
 * them. Same list as the API's DRAFT_STATUSES (a test asserts it).
 */
export const APPROVAL_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
];

export function approvalItems(content: Entity[]) {
  return content.filter((c) =>
    APPROVAL_STATUSES.includes(String(c.data.status)),
  );
}

export const KEEP_REASONS = [
  "HAS_OPEN_PUBLICATION",
  "HAS_OPEN_POSTIZ_DRAFT",
  "PENDING_DECISION",
  "ACTIVE_ASSIGNMENT_RUN",
] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];
/** Why a ready mission stays, in the API's order. */
export const MISSION_KEEP_REASONS = [
  "ACTIVE_RUN",
  "BATCH_RUNNING",
  "ACTIVE_JOB",
  "NO_CONTENT",
  "KEPT_CONTENT",
  "UNSETTLED_CONTENT",
] as const;
export type MissionKeepReason = (typeof MISSION_KEEP_REASONS)[number];

/** The counts `archive-old-drafts` answers with, for a preview and a run. */
export type DraftCleanupSummary = {
  preview: boolean;
  cleanupId: string | null;
  content: { total: number; alreadyInPostiz?: number };
  missions: {
    total: number;
    kept?: {
      total: number;
      byReason?: Partial<Record<MissionKeepReason, number>>;
    };
  };
  kept: { total: number; byReason?: Partial<Record<KeepReason, number>> };
};
/** A cleanup of this browser session that can still be undone. */
export type StoredCleanup = {
  cleanupId: string;
  content: number;
  missions: number;
  at: string;
};
export type CleanupState = {
  preview: DraftCleanupSummary | null;
  // The preview was reloaded because the counts changed before confirming.
  changed: boolean;
  done: StoredCleanup[];
  restored: { content: number; missions: number } | null;
};
export const initialCleanupState: CleanupState = {
  preview: null,
  changed: false,
  done: [],
  restored: null,
};
export type CleanupCall = (name: string, input: unknown) => Promise<any>;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const drafts = (n: number, de: boolean) =>
  de ? plural(n, "Entwurf", "Entwürfe") : plural(n, "draft", "drafts");
const missions = (n: number, de: boolean) =>
  de ? plural(n, "Mission", "Missionen") : plural(n, "mission", "missions");
/** "2 Entwürfe und 1 Mission"; a zero part is left out. */
function counted(content: number, mission: number, de: boolean) {
  const parts = [
    content ? drafts(content, de) : null,
    mission ? missions(mission, de) : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(de ? " und " : " and ") : drafts(0, de);
}
// German verb agreement: singular only for exactly one row in one part.
const one = (content: number, mission: number) => content + mission === 1;
const reasonText: Record<KeepReason, { de: string; en: string }> = {
  HAS_OPEN_PUBLICATION: {
    de: "mit offener Veröffentlichung",
    en: "with an open publication",
  },
  HAS_OPEN_POSTIZ_DRAFT: {
    de: "mit ungeklärter Postiz-Übergabe",
    en: "with an unresolved Postiz handoff",
  },
  PENDING_DECISION: {
    de: "mit offener Entscheidung",
    en: "with an open decision",
  },
  ACTIVE_ASSIGNMENT_RUN: {
    de: "aus einem laufenden Auftrag",
    en: "from an active assignment run",
  },
};

const missionReasonText: Record<MissionKeepReason, { de: string; en: string }> =
  {
    ACTIVE_RUN: { de: "mit laufendem Auftrag", en: "with an active run" },
    BATCH_RUNNING: {
      de: "mit laufender Entwurfsserie",
      en: "with a running draft batch",
    },
    ACTIVE_JOB: { de: "mit offenem Job", en: "with an open job" },
    NO_CONTENT: {
      de: "ohne eigene Inhalte",
      en: "without content of their own",
    },
    KEPT_CONTENT: {
      de: "mit behaltenen Inhalten",
      en: "with content that is kept",
    },
    UNSETTLED_CONTENT: {
      de: "mit nicht abgeschlossenen Inhalten",
      en: "with unfinished content",
    },
  };

/** The dialog sentences: what is archived, what is already in Postiz, what stays. */
export function cleanupConfirmText(s: DraftCleanupSummary, locale: Locale) {
  const de = locale === "de";
  const lines = [
    de
      ? `${counted(s.content.total, s.missions.total, de)} ${one(s.content.total, s.missions.total) ? "wird" : "werden"} archiviert (wiederherstellbar).`
      : `${counted(s.content.total, s.missions.total, de)} will be archived (restorable).`,
  ];
  const inPostiz = s.content.alreadyInPostiz ?? 0;
  if (inPostiz)
    lines.push(
      de
        ? `Davon ${inPostiz} bereits als Entwurf in Postiz (dort ${inPostiz === 1 ? "bleibt er" : "bleiben sie"} unverändert).`
        : `${inPostiz} of them ${inPostiz === 1 ? "is" : "are"} already a draft in Postiz (unchanged there).`,
    );
  const kept = KEEP_REASONS.filter((r) => (s.kept.byReason?.[r] ?? 0) > 0).map(
    (r) => `${s.kept.byReason![r]} ${reasonText[r][de ? "de" : "en"]}`,
  );
  if (kept.length)
    lines.push(
      de
        ? `Behalten ${s.kept.total === 1 ? "wird" : "werden"}: ${kept.join(", ")}.`
        : `Kept: ${kept.join(", ")}.`,
    );
  const staying = s.missions.kept;
  const why = MISSION_KEEP_REASONS.filter(
    (r) => (staying?.byReason?.[r] ?? 0) > 0,
  ).map(
    (r) => `${staying!.byReason![r]} ${missionReasonText[r][de ? "de" : "en"]}`,
  );
  if (staying?.total)
    lines.push(
      de
        ? `${missions(staying.total, de)} ${staying.total === 1 ? "bleibt" : "bleiben"}${why.length ? ` (${why.join(", ")})` : ""}.`
        : `${missions(staying.total, de)} ${staying.total === 1 ? "stays" : "stay"}${why.length ? ` (${why.join(", ")})` : ""}.`,
    );
  return lines;
}

export function cleanupDoneText(c: StoredCleanup, locale: Locale) {
  const de = locale === "de";
  return `${counted(c.content, c.missions, de)} ${de ? "archiviert" : "archived"}.`;
}

export function cleanupRestoredText(
  r: { content: number; missions: number },
  locale: Locale,
) {
  const de = locale === "de";
  if (!r.content && !r.missions)
    return de ? "Nichts wiederherzustellen." : "Nothing to restore.";
  return `${counted(r.content, r.missions, de)} ${de ? "wiederhergestellt" : "restored"}.`;
}

/** Loads the preview the confirmation dialog shows. */
export async function openCleanupPreview(
  state: CleanupState,
  call: CleanupCall,
): Promise<CleanupState> {
  const preview = (await call("archive-old-drafts", {
    preview: true,
  })) as DraftCleanupSummary;
  return { ...state, preview, changed: false, restored: null };
}

const KEEP_CLEANUPS = 5;
/**
 * Runs the cleanup with the counts the owner saw. When they changed in the
 * meantime the server refuses (CLEANUP_CHANGED) and the new preview is shown.
 */
export async function confirmCleanup(
  state: CleanupState,
  call: CleanupCall,
): Promise<CleanupState> {
  const shown = state.preview;
  if (!shown) return state;
  let result: DraftCleanupSummary;
  try {
    result = await call("archive-old-drafts", {
      confirm: true,
      expected: {
        content: shown.content.total,
        missions: shown.missions.total,
        kept: shown.kept.total,
      },
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "CLEANUP_CHANGED")
      throw error;
    return { ...(await openCleanupPreview(state, call)), changed: true };
  }
  const done = result.cleanupId
    ? [
        {
          cleanupId: result.cleanupId,
          content: result.content.total,
          missions: result.missions.total,
          at: new Date().toISOString(),
        },
        ...state.done,
      ].slice(0, KEEP_CLEANUPS)
    : state.done;
  return { ...state, preview: null, changed: false, done };
}

/** Restores one cleanup of this session and reports what came back. */
export async function undoCleanup(
  state: CleanupState,
  call: CleanupCall,
  cleanupId: string,
): Promise<CleanupState> {
  const result = (await call("restore-draft-cleanup", { cleanupId })) as {
    restored: { content: number; missions: number };
  };
  return {
    ...state,
    done: state.done.filter((c) => c.cleanupId !== cleanupId),
    restored: result.restored,
  };
}

/** The undoable cleanups survive a reload of the tab (sessionStorage). */
export const cleanupStorageKey = (projectId: string) =>
  `orbit.draftCleanups.${projectId}`;

export function loadCleanups(
  storage: Pick<Storage, "getItem"> | undefined,
  projectId: string,
): StoredCleanup[] {
  try {
    const raw = storage?.getItem(cleanupStorageKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (c) =>
              typeof c?.cleanupId === "string" &&
              typeof c.content === "number" &&
              typeof c.missions === "number",
          )
          .slice(0, KEEP_CLEANUPS)
      : [];
  } catch {
    return [];
  }
}

export function saveCleanups(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  projectId: string,
  done: StoredCleanup[],
) {
  try {
    if (done.length)
      storage?.setItem(cleanupStorageKey(projectId), JSON.stringify(done));
    else storage?.removeItem(cleanupStorageKey(projectId));
  } catch {
    // Private mode or blocked storage: undo then lasts until the reload.
  }
}
