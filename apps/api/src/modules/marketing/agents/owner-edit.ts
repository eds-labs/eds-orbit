import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import {
  CONTENT_CLOSED,
  contentClosed,
} from "../pipeline/content-decisions.ts";
import { invalidateContent } from "../pipeline/content-invalidation.ts";
import { agentsEnabled } from "./assignments.ts";
import { draftReplaced } from "./draft-state.ts";
import { bookedDraft, releasedPublication } from "./handoff-lookup.ts";

/**
 * The owner's edit of an assignment draft that waits for them (Mario,
 * 2026-11-11): Orbit objected to it or left it to them, and they fix the
 * text instead of rejecting it. The draft stays `needs_review`, so the
 * approvals page keeps it and the release (owner-release.ts) still works;
 * the general content form would move it back to `draft`. The edit drops
 * any agent review (it covered another text) and records who changed it and
 * the hash of the text before; the release then reviews and checks exactly
 * the edited text, with every deterministic blocker absolute at handoff.
 * Owner only, like the release. Only the body and title change; the image,
 * slot and channel stay. The audit never records the text.
 */
export const draftEditInput = z
  .object({
    version: z.number().int().positive(),
    body: z.string().trim().min(1).max(40000),
    title: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type DraftEditInput = z.infer<typeof draftEditInput>;

export async function editAssignmentDraft(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  raw: DraftEditInput,
) {
  if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = draftEditInput.parse(raw);
  const row = await entity(tx, scope, "content", contentId);
  const c = data(row);
  if (typeof c.assignmentRunId !== "string")
    throw new DomainError("NOT_FOUND", 404);
  if (contentClosed(c.status)) throw new DomainError(CONTENT_CLOSED, 409);
  if (
    c.status !== "needs_review" ||
    draftReplaced(c) ||
    (await releasedPublication(tx, scope, row.id)) ||
    (await bookedDraft(tx, scope, row.id))
  )
    throw new DomainError("DRAFT_NOT_AWAITING_OWNER", 409);
  if (row.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const title = input.title ?? c.title;
  if (input.body === c.body && title === c.title)
    return { result: "unchanged" as const, id: row.id, version: row.version };
  const { agentReview: _agentReview, ...rest } = c;
  const edited = await update(tx, scope, row, {
    ...rest,
    body: input.body,
    title,
    status: "needs_review",
    ownerEdit: {
      by: scope.userId,
      at: new Date().toISOString(),
      previousBodyHash: hash(c.body),
    },
  });
  await invalidateContent(tx, scope, row.id);
  await audit(tx, scope, "content.owner_edited", row.id, {
    previousBodyHash: hash(c.body),
    bodyHash: hash(input.body),
    titleChanged: title !== c.title,
  });
  return { result: "edited" as const, id: row.id, version: edited.version };
}
