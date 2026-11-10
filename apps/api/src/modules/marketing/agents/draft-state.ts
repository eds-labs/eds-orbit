import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";

// States of assignment drafts read in many places.
//
// Replaced: a revision superseded the draft (`supersededBy`, a content id)
// or the owner retried its run (`retiredWithRunId`, the retired run's id;
// the new run is that run's `retriedByRunId`). Either way the draft is gone:
// it is never released, scheduled, counted or offered again.
//
// Expired (D-2): a slot is never moved once it has passed, so a draft of an
// assignment run whose slot is over can never be released or delivered. It
// is derived from the slot, never written, and is left out of the review
// backlog and the content review count.

/** A draft a revision superseded or a retried run retired: treated as gone. */
export function draftReplaced(draft: Record<string, unknown>): boolean {
  return Boolean(draft.supersededBy || draft.retiredWithRunId);
}

/** A slot is expired from its own instant on: it is never moved afterwards. */
export function slotExpired(slot: Date, now: Date): boolean {
  return now.valueOf() >= slot.valueOf();
}

type ContentRow = { id: string; data: unknown };

/**
 * The ids among `rows` (content) that are drafts of an assignment run whose
 * run slot (the mission's `plannedSlotAt`, else the draft's `scheduledAt`)
 * has passed. Other content and drafts without a slot are never expired.
 */
export async function expiredDraftIds(
  tx: DbTx,
  scope: Scope,
  rows: ContentRow[],
  now: Date,
): Promise<Set<string>> {
  const drafts = rows.filter(
    (row) => typeof data(row).assignmentRunId === "string",
  );
  const missionIds = [
    ...new Set(
      drafts
        .map((row) => data(row).missionId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const missions = missionIds.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "missions",
          id: { in: missionIds },
        },
        select: { id: true, data: true },
      })
    : [];
  const planned = new Map(
    missions.map((row) => [row.id, data(row).plannedSlotAt]),
  );
  const expired = new Set<string>();
  for (const row of drafts) {
    const d = data(row);
    const slot = Date.parse(
      String(planned.get(String(d.missionId)) ?? d.scheduledAt ?? ""),
    );
    if (Number.isFinite(slot) && slotExpired(new Date(slot), now))
      expired.add(row.id);
  }
  return expired;
}
