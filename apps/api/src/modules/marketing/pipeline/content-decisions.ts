import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, update } from "../../../shared.ts";
import { draftReplaced } from "../agents/draft-state.ts";
import type { RunSlot } from "../agents/veto.ts";
import { invalidateContent } from "./content-invalidation.ts";
import { DRAFT_STATUSES } from "./draft-statuses.ts";

/**
 * The owner's decisions on a draft on the approvals page, next to the
 * release (owner-release.ts). They extend the content lifecycle the page
 * already shows; they are not a second approval system, and the module's
 * ActionRequests keep their own approve and reject.
 *
 * - `reject`: the draft is not to go out. Status `rejected` with
 *   `ownerDecision` (who, when, an optional reason). It can never be
 *   released, reviewed, approved or published again (`CONTENT_CLOSED`).
 * - `discard`: the draft is no longer needed. Status `archived` with the
 *   archive fields the draft cleanup uses (`archiveReason:
 *   "OWNER_DISCARDED"`), so its history stays.
 * - `archive`: removes an item from the active overview. A closed item
 *   (rejected, discarded) keeps its status and is only hidden
 *   (`ownerDecision.hiddenAt`). A draft that was never decided is archived
 *   like a discard, with `archiveReason: "SLOT_PASSED"` when its slot has
 *   passed, else `"OWNER_ARCHIVED"`.
 *
 * Nothing is deleted: audit and approval history must stay. A draft with an
 * active publication or Postiz draft is refused (`DRAFT_HAS_PUBLICATION`);
 * stopping that is the veto's job. An assignment draft frees its run slot,
 * so it no longer holds the slot or counts toward the review backlog.
 * Owner only. Repeating a decision that is already recorded changes nothing.
 */
export const draftDecisionInput = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type DraftDecisionInput = z.infer<typeof draftDecisionInput>;
export type DraftDecision = "reject" | "discard" | "archive";

/** Content an owner closed: it never goes out again. */
export const CLOSED_CONTENT = ["rejected", "archived"] as const;
export const CONTENT_CLOSED = "CONTENT_CLOSED";
export const DRAFT_NOT_DECIDABLE = "DRAFT_NOT_DECIDABLE";
export const DRAFT_HAS_PUBLICATION = "DRAFT_HAS_PUBLICATION";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Publications and Postiz drafts that are over: they hold nothing any more.
const DONE_PUBLICATION = ["canceled", "failed"];
const DONE_POSTIZ_DRAFT = ["canceled", "failed"];
const ACTION = {
  reject: "rejected",
  discard: "discarded",
  archive: "archived",
} as const;

/** Whether content is closed by an owner decision or the review (rejected, archived). */
export function contentClosed(status: unknown) {
  return (CLOSED_CONTENT as readonly string[]).includes(String(status));
}

/** Refuses closed content (`CONTENT_CLOSED`, 409). */
export function refuseClosedContent(content: Record<string, unknown>) {
  if (contentClosed(content.status)) throw new DomainError(CONTENT_CLOSED, 409);
}

/** The content's publications and Postiz draft handoffs that are not over. */
async function activeHandoffs(tx: DbTx, scope: Scope, contentId: string) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: { in: ["publications", "postiz_drafts"] },
      data: { path: ["contentId"], equals: contentId },
    },
  });
  return rows.filter((row) =>
    row.kind === "publications"
      ? !DONE_PUBLICATION.includes(String(data(row).status))
      : !DONE_POSTIZ_DRAFT.includes(String(data(row).status)),
  );
}

/** The draft's run slot, from its draft-only mission (assignment drafts only). */
async function plannedSlot(tx: DbTx, scope: Scope, c: Record<string, any>) {
  if (typeof c.missionId !== "string") return null;
  const mission = await entity(tx, scope, "missions", c.missionId).catch(
    () => null,
  );
  const at = String(data(mission).plannedSlotAt ?? c.scheduledAt ?? "");
  return Number.isFinite(Date.parse(at)) ? new Date(at) : null;
}

/** Frees an assignment draft's run slot that no publication or Postiz draft holds. */
async function freeRunSlot(
  tx: DbTx,
  scope: Scope,
  c: Record<string, any>,
  slot: Date | null,
  reason: string,
  now: Date,
) {
  if (typeof c.assignmentRunId !== "string" || !slot) return;
  const run = await entity(tx, scope, "assignment_runs", c.assignmentRunId);
  const r = data(run);
  const slots = ((r.slots ?? []) as RunSlot[]).map((entry) => ({ ...entry }));
  let changed = false;
  for (const [index, entry] of slots.entries())
    if (
      entry.channel === c.channel &&
      Date.parse(entry.at) === slot.valueOf() &&
      !entry.publicationId &&
      !entry.postizDraftId &&
      !entry.releasedAt
    ) {
      slots[index] = {
        ...entry,
        releasedAt: now.toISOString(),
        releaseReason: reason,
      };
      changed = true;
    }
  if (changed) await update(tx, scope, run, { ...r, slots });
}

export type DraftDecisionResult = {
  result: "decided" | "unchanged";
  contentId: string;
  status: string;
  action: (typeof ACTION)[DraftDecision];
  version: number;
};

export async function decideDraft(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  decision: DraftDecision,
  input: DraftDecisionInput,
): Promise<DraftDecisionResult> {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  if (!UUID.test(contentId)) throw new DomainError("NOT_FOUND", 404);
  // Serialized with the owner's release and the runs' scheduling, which take
  // the same project lock, so a decision and a release never race.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId},0))`;
  const row = await entity(tx, scope, "content", contentId);
  const c = data(row);
  const action = ACTION[decision];
  const now = new Date();
  const result = (
    outcome: DraftDecisionResult["result"],
    saved: { version: number; data: unknown },
  ): DraftDecisionResult => ({
    result: outcome,
    contentId,
    status: String(data(saved).status),
    action,
    version: saved.version,
  });

  // Repeating a recorded decision changes nothing.
  if (
    (decision === "archive" && c.ownerDecision?.hiddenAt) ||
    (decision !== "archive" &&
      c.ownerDecision?.action === action &&
      contentClosed(c.status))
  )
    return result("unchanged", row);
  if (row.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);

  // A decided item (rejected, discarded, or closed by the review) is only
  // hidden from the active overview. Released posts are not changed here:
  // their content is bound to its approved package until it goes out.
  const decided = contentClosed(c.status);
  if (decision === "archive" && decided) {
    const saved = await update(tx, scope, row, {
      ...c,
      ownerDecision: {
        ...(c.ownerDecision ?? {
          action: c.status === "rejected" ? "rejected" : "archived",
          by: null,
          at: now.toISOString(),
        }),
        hiddenAt: now.toISOString(),
        hiddenBy: scope.userId,
      },
    });
    await audit(tx, scope, "content.owner_archived", contentId, {
      status: c.status,
      hidden: true,
    });
    return result("decided", saved);
  }

  if (
    !(DRAFT_STATUSES as readonly string[]).includes(String(c.status)) ||
    draftReplaced(c)
  )
    throw new DomainError(DRAFT_NOT_DECIDABLE, 409);
  if ((await activeHandoffs(tx, scope, contentId)).length)
    throw new DomainError(DRAFT_HAS_PUBLICATION, 409);

  const slot = await plannedSlot(tx, scope, c);
  const reason = decision === "reject" ? input.reason || undefined : undefined;
  const ownerDecision = {
    action,
    by: scope.userId,
    at: now.toISOString(),
    ...(reason ? { reason } : {}),
  };
  const next =
    decision === "reject"
      ? { ...c, status: "rejected", ownerDecision }
      : {
          ...c,
          status: "archived",
          statusBeforeArchive: c.status,
          archivedAt: now.toISOString(),
          archivedBy: scope.userId,
          archiveReason:
            decision === "discard"
              ? "OWNER_DISCARDED"
              : slot && slot.valueOf() < now.valueOf()
                ? "SLOT_PASSED"
                : "OWNER_ARCHIVED",
          ownerDecision:
            decision === "archive"
              ? {
                  ...ownerDecision,
                  hiddenAt: now.toISOString(),
                  hiddenBy: scope.userId,
                }
              : ownerDecision,
        };
  const saved = await update(tx, scope, row, next);
  // Open approvals of the old text no longer hold.
  await invalidateContent(tx, scope, contentId);
  await freeRunSlot(
    tx,
    scope,
    c,
    slot,
    decision === "reject" ? "OWNER_REJECTED" : "OWNER_DISCARDED",
    now,
  );
  // Content-free audit: whether a reason was given, never its text.
  await audit(
    tx,
    scope,
    decision === "reject"
      ? "content.owner_rejected"
      : decision === "discard"
        ? "content.owner_discarded"
        : "content.owner_archived",
    contentId,
    {
      statusBefore: c.status,
      assignmentRunId: c.assignmentRunId ?? null,
      hasReason: Boolean(reason),
    },
  );
  return result("decided", saved);
}
