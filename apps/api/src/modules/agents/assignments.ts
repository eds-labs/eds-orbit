import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
} from "../../shared.ts";
import { chatScoped, conversation } from "../chat.ts";
import {
  cancelActionRequest,
  createActionRequest,
} from "../action-requests.ts";
import { activePolicy } from "../policy.ts";
import { cancelAssignmentRuns } from "./assignment-runs.ts";
import { withdrawAssignmentPublications } from "./veto.ts";

/**
 * Assignments (Orbit Agents): what Orbit pursues for the owner. An assignment
 * is a draft until an owner confirms its exact content (action request
 * `assignment.confirm`); a change to that content returns it to draft, while
 * pausing, resuming and moving the times do not need a new confirmation.
 * This module holds the model, validation and lifecycle only.
 */
const KIND = "assignments";

export function agentsEnabled() {
  return loadConfig().ORBIT_AGENTS === "true";
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const assignmentSchedule = z
  .object({
    rhythm: z.enum(["daily", "weekly", "once"]),
    // Local weekdays, 0 = Sunday (as in the weekly autopilot); weekly rhythm only.
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .transform((days) => [...new Set(days)].sort()),
    // Local times of day in the project's timezone.
    times: z
      .array(time)
      .min(1)
      .max(6)
      .transform((times) => [...new Set(times)].sort()),
    // Local calendar date of a one-off assignment.
    date: z.iso.date().optional(),
    // How long before the slot a run starts to prepare it.
    leadMinutes: z.number().int().min(0).max(4320).default(360),
  })
  .strict();

const assignmentFields = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["one_off", "standing"]),
    schedule: assignmentSchedule,
    contentType: z.enum(["social", "blog", "newsletter", "report"]),
    // A report goes to the owner, not to a channel: empty for `report`, at least one otherwise.
    channels: z.array(z.string().trim().min(1).max(80)).max(4),
    topicFrame: z.string().trim().min(5).max(2000),
    tone: z.string().trim().min(1).max(300).optional(),
    image: z.boolean(),
    styleAssetIds: z.array(z.uuid()).max(10),
    vetoMinutes: z.number().int().min(30).max(1440).default(180),
    monthlyBudgetMicros: z.number().int().min(0).max(10_000_000_000),
  })
  .strict();
type Content = z.infer<typeof assignmentFields>;
const CONTENT_KEYS = Object.keys(assignmentFields.shape) as (keyof Content)[];

export const assignmentInput = assignmentFields.superRefine((value, ctx) => {
  const { rhythm, weekdays, date } = value.schedule;
  const issue = (path: string[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if ((value.kind === "one_off") !== (rhythm === "once"))
    issue(
      ["schedule", "rhythm"],
      "A one-off assignment runs once; a standing one repeats",
    );
  if (
    value.contentType === "report"
      ? value.channels.length
      : !value.channels.length
  )
    issue(
      ["channels"],
      value.contentType === "report"
        ? "A report has no channels"
        : "Channels are required",
    );
  if (rhythm === "weekly" && !weekdays.length)
    issue(["schedule", "weekdays"], "A weekly rhythm needs weekdays");
  if (rhythm === "once" && !date)
    issue(["schedule", "date"], "A one-off assignment needs a date");
});
export type AssignmentInput = z.output<typeof assignmentInput>;

// Normalized as stored (JSON drops undefined), so a hash is the same before and after saving.
const contentOf = (source: Record<string, any>) =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(CONTENT_KEYS.map((key) => [key, source[key]])),
    ),
  ) as Record<string, any>;
/** Everything the owner confirms: all content fields, never status, confirmation or versions. */
export const assignmentHash = (source: Record<string, any>) =>
  hash(contentOf(source));
const withoutTimes = (source: Record<string, any>) => {
  const content = contentOf(source);
  return { ...content, schedule: { ...content.schedule, times: [] } };
};

/** Monthly budget the confirmed assignments hold, without `selfId`; drafts claim theirs when confirmed. */
async function committedBudget(tx: DbTx, scope: Scope, selfId: string | null) {
  return (await list(tx, scope, KIND))
    .filter(
      (row) =>
        row.id !== selfId &&
        ["active", "paused", "budget_exhausted"].includes(data(row).status),
    )
    .reduce((sum, row) => sum + Number(data(row).monthlyBudgetMicros ?? 0), 0);
}

async function assertWithinMandate(
  tx: DbTx,
  scope: Scope,
  content: Content,
  selfId: string | null,
) {
  const policy = await activePolicy(tx, scope);
  if (!policy) throw new DomainError("ACTIVE_POLICY_REQUIRED", 409);
  const mandate = data(policy);
  // A report publishes nothing, so channel and content type scopes do not apply.
  if (
    content.contentType !== "report" &&
    (content.channels.some((channel) => !mandate.channels?.includes(channel)) ||
      !mandate.contentTypes?.includes(content.contentType))
  )
    throw new DomainError("SCOPE_NOT_ALLOWED", 409);
  const committed = await committedBudget(tx, scope, selfId);
  if (
    committed + content.monthlyBudgetMicros >
    Number(mandate.monthlyBudgetMicros)
  )
    throw new DomainError("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT", 409);
  for (const assetId of content.styleAssetIds)
    await entity(tx, scope, "assets", assetId);
}

function requireEditor(scope: Scope) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
}

/** The owner's confirmation request for exactly this content. */
function confirmationRequest(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  content: Content,
) {
  return createActionRequest(tx, scope, {
    actionType: "assignment.confirm",
    payload: {
      assignmentId,
      assignmentHash: assignmentHash(content),
      ...contentOf(content),
    },
    requestedBy: { kind: "agent", userId: scope.userId, agentRunId: null },
  });
}

/** Saves a draft assignment and the owner's confirmation request; nothing runs before it is confirmed. */
export async function proposeAssignment(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const content = assignmentInput.parse(raw);
  return chatScoped(scope, (tx) =>
    proposeAssignmentInTx(tx, scope, conversationId, content),
  );
}

/**
 * proposeAssignment inside an open chat transaction (`chatScoped`). `origin`
 * records where a proposal came from, for example the autopilot settings; it
 * is not part of the confirmed content and never changes the hash.
 */
export async function proposeAssignmentInTx(
  tx: DbTx,
  scope: Scope,
  conversationId: string,
  raw: unknown,
  origin: Record<string, unknown> | null = null,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const content = assignmentInput.parse(raw);
  await conversation(tx, scope, conversationId);
  await assertWithinMandate(tx, scope, content, null);
  const row = await create(tx, scope, KIND, {
    ...content,
    conversationId,
    ...(origin ? { origin } : {}),
    status: "draft",
    confirmation: null,
    actionRequestId: null,
  });
  const actionRequest = await confirmationRequest(tx, scope, row.id, content);
  const assignment = await update(tx, scope, row, {
    ...data(row),
    actionRequestId: actionRequest.id,
  });
  await audit(tx, scope, "assignment.proposed", row.id, {
    assignmentHash: assignmentHash(content),
    ...(origin ? { origin: origin.kind } : {}),
  });
  return { assignment, actionRequest };
}

/** Free share of the project's monthly budget: the policy budget minus what confirmed assignments hold. */
export async function freeAssignmentBudget(tx: DbTx, scope: Scope) {
  const policy = await activePolicy(tx, scope);
  if (!policy) return 0;
  return Math.max(
    0,
    Number(data(policy).monthlyBudgetMicros ?? 0) -
      (await committedBudget(tx, scope, null)),
  );
}

/** Decision check for `assignment.confirm`: the request still describes this draft. */
export async function revalidateAssignmentConfirm(
  tx: DbTx,
  scope: Scope,
  payload: Record<string, unknown>,
) {
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, String(payload.assignmentId));
  const d = data(row);
  if (d.status !== "draft" || assignmentHash(d) !== payload.assignmentHash)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  await assertWithinMandate(
    tx,
    scope,
    assignmentInput.parse(contentOf(d)),
    row.id,
  );
}

/**
 * Executor of `assignment.confirm`: the deciding owner activates exactly the
 * content that was shown. `version` is the assignment version the caller read.
 */
export async function confirmAssignment(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  version: number,
  imageRightsConsent = false,
) {
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, assignmentId);
  const d = data(row);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (d.status !== "draft") throw new DomainError("ASSIGNMENT_NOT_DRAFT", 409);
  if (d.image === true && imageRightsConsent !== true)
    throw new DomainError("IMAGE_RIGHTS_CONSENT_REQUIRED", 409);
  await assertWithinMandate(
    tx,
    scope,
    assignmentInput.parse(contentOf(d)),
    row.id,
  );
  const saved = await update(tx, scope, row, {
    ...d,
    status: "active",
    confirmation: {
      userId: scope.userId,
      at: new Date().toISOString(),
      assignmentHash: assignmentHash(d),
      imageRightsConsent: d.image === true,
    },
  });
  await audit(tx, scope, "assignment.confirmed", row.id, {
    assignmentHash: assignmentHash(d),
    imageRightsConsent: d.image === true,
  });
  return saved;
}

/** Runs on approval of `assignment.confirm`; the open request of the draft is the only one that counts. */
export async function executeAssignmentConfirm(
  tx: DbTx,
  scope: Scope,
  request: { id: string; data: unknown },
) {
  const payload = data(request).payload;
  const row = await entity(tx, scope, KIND, String(payload.assignmentId));
  if (data(row).actionRequestId !== request.id)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  return confirmAssignment(
    tx,
    scope,
    row.id,
    row.version,
    data(request).decision?.imageRightsConsent === true,
  );
}

/**
 * Changes an assignment. A content change returns it to draft with a new
 * owner request; moving the times of a confirmed assignment does not.
 */
export async function updateAssignment(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  patch: Record<string, unknown>,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  if (d.status === "ended") throw new DomainError("ASSIGNMENT_ENDED", 409);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const unknown = Object.keys(patch).filter(
    (key) => !CONTENT_KEYS.includes(key as keyof Content),
  );
  if (unknown.length) throw new DomainError("ASSIGNMENT_FIELD_UNKNOWN", 400);
  const next = assignmentInput.parse({
    ...contentOf(d),
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
  });
  if (assignmentHash(next) === assignmentHash(d)) return row;
  // Moving the times of any assignment is the owner's decision; an editor proposes a content change instead.
  const timesChanged = hash(withoutTimes(next)) === hash(withoutTimes(d));
  if (timesChanged && scope.role !== "owner")
    throw new DomainError("OWNER_REQUIRED", 403);
  await assertWithinMandate(tx, scope, next, id);
  if (timesChanged && d.status !== "draft") {
    // The confirmation covers the unchanged content; its hash follows the new times.
    const saved = await update(tx, scope, row, {
      ...d,
      ...next,
      confirmation: { ...d.confirmation, assignmentHash: assignmentHash(next) },
    });
    await audit(tx, scope, "assignment.times_changed", id);
    return saved;
  }
  if (d.actionRequestId)
    await cancelActionRequest(tx, scope, d.actionRequestId);
  const actionRequest = await confirmationRequest(tx, scope, id, next);
  const saved = await update(tx, scope, row, {
    ...d,
    ...next,
    status: "draft",
    confirmation: null,
    actionRequestId: actionRequest.id,
  });
  await audit(tx, scope, "assignment.content_changed", id, {
    assignmentHash: assignmentHash(next),
  });
  return saved;
}

/**
 * Pause, resume or end. Resuming needs a confirmation that still covers the
 * content. `budget_exhausted` is set by the specialist runner (never by a
 * person) when the assignment's budget is used up; it stops like a pause and
 * is resumed the same way. `version`, when given, is the assignment version
 * the person saw (the web page); a change made since then is a conflict.
 */
export async function setAssignmentStatus(
  tx: DbTx,
  scope: Scope,
  id: string,
  status: "active" | "paused" | "ended" | "budget_exhausted",
  version?: number,
) {
  requireEditor(scope);
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  if (d.status === status) return row;
  if (version !== undefined && row.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (d.status === "ended") throw new DomainError("ASSIGNMENT_ENDED", 409);
  if (status === "active") {
    if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
    if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
    if (
      d.status === "draft" ||
      d.confirmation?.assignmentHash !== assignmentHash(d)
    )
      throw new DomainError("ASSIGNMENT_NOT_CONFIRMED", 409);
    await assertWithinMandate(
      tx,
      scope,
      assignmentInput.parse(contentOf(d)),
      id,
    );
  }
  if (status === "paused" && !["active", "budget_exhausted"].includes(d.status))
    throw new DomainError("ASSIGNMENT_STATUS_INVALID", 409);
  if (status === "budget_exhausted" && d.status !== "active")
    throw new DomainError("ASSIGNMENT_STATUS_INVALID", 409);
  // An open confirmation request dies with the assignment.
  if (status === "ended" && d.actionRequestId)
    await cancelActionRequest(tx, scope, d.actionRequestId);
  const saved = await update(tx, scope, row, { ...d, status });
  // A stopped assignment must not keep producing: its open runs stop and release their slots,
  // and its scheduled posts that are not handed over yet are withdrawn (R20/R23).
  if (status !== "active") {
    await cancelAssignmentRuns(tx, scope, id);
    await withdrawAssignmentPublications(
      tx,
      scope,
      id,
      status === "ended" ? "ASSIGNMENT_ENDED" : "ASSIGNMENT_PAUSED",
    );
  }
  await audit(tx, scope, "assignment.status_changed", id, {
    from: d.status,
    to: status,
  });
  return saved;
}
