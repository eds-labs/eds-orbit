import type { Entity } from "@/lib/api";

// Posts a project pause stopped; only those still ahead can be scheduled again.
export function pausedPosts(publications: Entity[], now = Date.now()) {
  return publications
    .filter(
      (p) =>
        p.data.status === "blocked_dependency" &&
        p.data.reason === "PROJECT_PAUSED" &&
        Date.parse(String(p.data.scheduledAt)) > now,
    )
    .sort((a, b) =>
      String(a.data.scheduledAt).localeCompare(String(b.data.scheduledAt)),
    );
}

// A resolved exception is history; an open one shows when it was last seen.
export function openExceptions(exceptions: Entity[]) {
  return exceptions
    .filter((e) => e.data.status === "open")
    .sort((a, b) =>
      String(b.data.lastSeenAt).localeCompare(String(a.data.lastSeenAt)),
    );
}

// The approval lanes, as the server derives them (apps/api/src/modules/
// marketing/approval-state.ts; approval-state-parity.test.tsx keeps the two
// in step). Read-time only: nothing here is ever written back.

/** Content statuses that still wait for someone: the approvals list without `reviewed`. */
export const OPEN_REVIEW_STATUSES = [
  "review",
  "needs_review",
  "draft",
  "blocked",
  "pending_approval",
];

export type ApprovalLane =
  | "open"
  | "reviewed"
  | "released"
  | "cleanup"
  | "history";
export type LaneHandoff = {
  kind: "publication" | "postiz_draft";
  status: unknown;
};

const DONE_HANDOFF = ["canceled", "failed"];
const PUBLISHED = ["published", "published_test"];

/** The lane of one content row; first match wins (server: approvalLane). */
export function approvalLane(
  content: Record<string, unknown>,
  context: { handoffs?: readonly LaneHandoff[]; expired?: boolean } = {},
): ApprovalLane {
  if (content.supersededBy || content.retiredWithRunId) return "history";
  if (content.status === "rejected" || content.status === "archived")
    return "history";
  const active = (context.handoffs ?? []).filter(
    (h) => !DONE_HANDOFF.includes(String(h.status)),
  );
  if (active.length)
    return active.some(
      (h) => h.kind === "publication" && PUBLISHED.includes(String(h.status)),
    )
      ? "history"
      : "released";
  if (content.status === "reviewed") return "reviewed";
  if (context.expired) return "cleanup";
  return "open";
}

/** The original a channel copy was made from (R76), else the row itself. */
export function baseContentId(row: { id: string; data: unknown }): string {
  const shared = (row.data as { sharedFrom?: { contentId?: unknown } } | null)
    ?.sharedFrom?.contentId;
  return typeof shared === "string" ? shared : row.id;
}

/** Content the approvals page sorts into lanes: listed rows and closed ones. */
const LANE_STATUSES = [
  ...OPEN_REVIEW_STATUSES,
  "reviewed",
  "rejected",
  "archived",
];

/** One content row with its lane and its hand-offs (newest first). */
export type LaneItem = {
  content: Entity;
  lane: ApprovalLane;
  publications: Entity[];
  postizDrafts: Entity[];
};

/**
 * Sorts content into lanes with its publications and Postiz drafts. An
 * assignment draft counts as expired once its slot passed (the slot the
 * drafts list names, else the row's own `scheduledAt`).
 */
export function approvalLanes(
  content: Entity[],
  publications: Entity[],
  postizDrafts: Entity[],
  options: { now?: number; slots?: ReadonlyMap<string, string> } = {},
): LaneItem[] {
  const now = options.now ?? Date.now();
  const byContent = (rows: Entity[]) => {
    const map = new Map<string, Entity[]>();
    for (const row of rows) {
      const id = String(row.data.contentId ?? "");
      if (id) map.set(id, [...(map.get(id) ?? []), row]);
    }
    for (const list of map.values())
      list.sort((a, b) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
      );
    return map;
  };
  const pubs = byContent(publications);
  const drafts = byContent(postizDrafts);
  return content
    .filter((c) => LANE_STATUSES.includes(String(c.data.status)))
    .map((c) => {
      const own = pubs.get(c.id) ?? [];
      const handed = drafts.get(c.id) ?? [];
      const slot = Date.parse(
        String(options.slots?.get(c.id) ?? c.data.scheduledAt ?? ""),
      );
      const expired =
        typeof c.data.assignmentRunId === "string" &&
        Number.isFinite(slot) &&
        now >= slot;
      return {
        content: c,
        publications: own,
        postizDrafts: handed,
        lane: approvalLane(c.data, {
          handoffs: [
            ...own.map((p) => ({
              kind: "publication" as const,
              status: p.data.status,
            })),
            ...handed.map((h) => ({
              kind: "postiz_draft" as const,
              status: h.data.status,
            })),
          ],
          expired,
        }),
      };
    });
}

/** Items grouped by their original (R76 copies with it), in first-seen order. */
export function groupByBase<T extends { content: Entity }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = baseContentId(item.content);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([baseId, members]) => ({
    baseId,
    // The original first, then its copies.
    items: [...members].sort(
      (a, b) =>
        Number(a.content.id !== baseId) - Number(b.content.id !== baseId),
    ),
  }));
}
