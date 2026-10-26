import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import type { DomainEventView } from "../../platform/events/types.ts";
import { redact } from "../../platform/privacy/redact.ts";
import {
  assertVersion,
  componentKey,
  expectedVersion,
  ISSUE_TYPE,
  ISSUE_TYPES,
  issueDomainEvent,
  issueEvent,
  PRIORITIES,
  SEVERITIES,
  triagerIds,
  uuid,
  type IssueActor,
} from "./common.ts";
import { readIssuesSettings, type IssuesSettings } from "./settings.ts";
import {
  assertTransition,
  autoMoveAllowed,
  ISSUE_STATUSES,
  type IssueStatus,
} from "./status.ts";

// Issues (ADR 0018): created by a person or by intake, triaged by people,
// moved forward by the sync rules. Every stored text passes strict
// redaction (I-5); history and events hold field names only.

export type IssueRow = NonNullable<Awaited<ReturnType<DbTx["issue"]["findFirst"]>>>;

const environment = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/);
const criteria = z.array(z.string().trim().min(1).max(300)).max(10);

export const createIssueInput = z
  .object({
    type: z.enum(ISSUE_TYPES).default("bug"),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(10_000).optional(),
    severity: z.enum(SEVERITIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    category: componentKey.optional(),
    components: z.array(componentKey).max(20).default([]),
    environment: environment.optional(),
    acceptanceCriteria: criteria.default([]),
  })
  .strict();

const updateIssueInput = z
  .object({
    expectedVersion,
    type: z.enum(ISSUE_TYPES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(10_000).nullable().optional(),
    severity: z.enum(SEVERITIES).nullable().optional(),
    priority: z.enum(PRIORITIES).nullable().optional(),
    category: componentKey.nullable().optional(),
    components: z.array(componentKey).max(20).optional(),
    assigneeUserId: z.string().min(1).max(100).nullable().optional(),
    environment: environment.nullable().optional(),
    acceptanceCriteria: criteria.optional(),
  })
  .strict();

const statusInput = z
  .object({
    status: z.enum(ISSUE_STATUSES),
    expectedVersion,
    /** A reason code, never free text. */
    reason: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
  })
  .strict();

/** Strictly redacted text and the number of removed spans. */
export function clean(text: string) {
  const { text: out, counts } = redact(text);
  return { text: out, removed: Object.values(counts).reduce((a, n) => a + n, 0) };
}

/** Throws 422 unless every component and the category are configured. */
export function assertTaxonomy(
  settings: IssuesSettings,
  input: { components?: readonly string[]; category?: string | null },
) {
  const components = new Set(settings.components.map((c) => c.key));
  if (input.components?.some((c) => !components.has(c)))
    throw new DomainError("ISSUES_COMPONENT_UNKNOWN", 422);
  if (input.category && !settings.categories.some((c) => c.key === input.category))
    throw new DomainError("ISSUES_CATEGORY_UNKNOWN", 422);
}

export async function loadIssue(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.issue.findFirst({ where: { projectId: scope.projectId, id: uuid.parse(id) } });
  if (!row) throw new DomainError("ISSUES_NOT_FOUND", 404);
  return row;
}

/** The next issue number of the project; numbers are never reused. */
async function nextNumber(tx: DbTx, scope: Scope) {
  const [row] = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "IssueCounter" ("workspaceId", "projectId", "lastNumber")
    VALUES (${scope.workspaceId}::uuid, ${scope.projectId}::uuid, 1)
    ON CONFLICT ("projectId") DO UPDATE SET "lastNumber" = "IssueCounter"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return row!.lastNumber;
}

/**
 * Creates an issue in `new`. Intake passes the report's fingerprint and
 * first occurrence; a person may set severity and priority right away.
 */
export async function createIssue(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: IssueActor,
  origin: { fingerprint?: string | null; firstSeenAt?: Date; environment?: string | null } = {},
) {
  const input = createIssueInput.parse(raw);
  const { settings } = await readIssuesSettings(tx, scope);
  assertTaxonomy(settings, input);
  const title = clean(input.title);
  const summary = input.summary ? clean(input.summary) : undefined;
  const now = new Date();
  const seen = origin.firstSeenAt && origin.firstSeenAt < now ? origin.firstSeenAt : now;
  const row = await tx.issue.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      number: await nextNumber(tx, scope),
      type: input.type,
      title: title.text,
      summary: summary?.text,
      severity: input.severity,
      priority: input.priority,
      category: input.category,
      components: input.components,
      environment: input.environment ?? origin.environment ?? undefined,
      fingerprint: origin.fingerprint ?? undefined,
      acceptanceCriteria: input.acceptanceCriteria.map((c) => clean(c).text),
      firstSeenAt: seen,
      lastSeenAt: now,
      createdBy: actor.id ?? actor.kind,
    },
  });
  await issueEvent(tx, scope, row.id, "created", actor, {}, {
    type: row.type,
    severity: row.severity,
    redacted: title.removed + (summary?.removed ?? 0),
  });
  await audit(tx, scope, "issues.issue.created", row.id, { number: row.number, actorKind: actor.kind });
  await issueDomainEvent(tx, scope, "issues.issue.created", { type: ISSUE_TYPE, id: row.id }, actor, {
    number: row.number,
    type: row.type,
    severity: row.severity,
  });
  return row;
}

/** Changes an issue's fields; text is redacted, history keeps field names. */
export async function updateIssue(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const input = updateIssueInput.parse(raw);
  const issue = await loadIssue(tx, scope, id);
  assertVersion(issue, input.expectedVersion);
  const { settings } = await readIssuesSettings(tx, scope);
  assertTaxonomy(settings, input);
  if (input.assigneeUserId && !(await triagerIds(scope)).has(input.assigneeUserId))
    throw new DomainError("ISSUES_ASSIGNEE_INVALID", 422);
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const set = (field: string, value: unknown, current: unknown) => {
    if (value === undefined || JSON.stringify(value) === JSON.stringify(current)) return;
    data[field] = value;
    changed.push(field);
  };
  set("title", input.title === undefined ? undefined : clean(input.title).text, issue.title);
  set("summary", input.summary === undefined ? undefined : input.summary === null ? null : clean(input.summary).text, issue.summary);
  set("type", input.type, issue.type);
  set("severity", input.severity, issue.severity);
  set("priority", input.priority, issue.priority);
  set("category", input.category, issue.category);
  set("components", input.components, issue.components);
  set("assigneeUserId", input.assigneeUserId, issue.assigneeUserId);
  set("environment", input.environment, issue.environment);
  set("acceptanceCriteria", input.acceptanceCriteria?.map((c) => clean(c).text), issue.acceptanceCriteria);
  if (!changed.length) return issue;
  // The share review covered the old texts only.
  if (issue.shareReviewedAt && changed.some((f) => ["title", "summary", "acceptanceCriteria"].includes(f)))
    Object.assign(data, { shareReviewedAt: null, shareReviewedBy: null });
  const row = await tx.issue.update({
    where: { id: issue.id },
    data: { ...data, version: { increment: 1 } },
  });
  // Keyed fields keep their values in the history; texts only that they changed.
  for (const field of ["type", "severity", "priority", "components"] as const)
    if (changed.includes(field))
      await issueEvent(tx, scope, issue.id, field, actor, { [field]: issue[field] }, { [field]: row[field] });
  if (changed.includes("assigneeUserId"))
    await issueEvent(tx, scope, issue.id, "assignee", actor, { assigneeUserId: issue.assigneeUserId }, { assigneeUserId: row.assigneeUserId });
  const other = changed.filter((f) => !["type", "severity", "priority", "components", "assigneeUserId"].includes(f));
  if (other.length) await issueEvent(tx, scope, issue.id, "fields", actor, {}, { changed: other });
  await issueDomainEvent(tx, scope, "issues.issue.updated", { type: ISSUE_TYPE, id: issue.id }, actor, {
    number: row.number,
    fields: changed,
  });
  return row;
}

/**
 * Moves an issue to `to` and records it: history, closing time, version and
 * the domain events. Callers have checked that the move is allowed.
 */
async function applyStatus(
  tx: DbTx,
  scope: Scope,
  issue: IssueRow,
  to: IssueStatus,
  actor: IssueActor,
  extra: { reason?: string; cause?: DomainEventView | null; mergedIntoIssueId?: string } = {},
) {
  const closing = to === "closed" || to === "duplicate";
  const row = await tx.issue.update({
    where: { id: issue.id },
    data: {
      status: to,
      closedAt: closing ? (issue.closedAt ?? new Date()) : null,
      ...(extra.mergedIntoIssueId ? { mergedIntoIssueId: extra.mergedIntoIssueId } : {}),
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, scope, issue.id, "status", actor, { status: issue.status }, { status: to, ...(extra.reason ? { reason: extra.reason } : {}) });
  const subject = { type: ISSUE_TYPE, id: issue.id } as const;
  const data = { number: row.number, from: issue.status, to };
  await issueDomainEvent(tx, scope, "issues.issue.status_changed", subject, actor, data, extra.cause);
  if (to === "released") await issueDomainEvent(tx, scope, "issues.issue.released", subject, actor, data, extra.cause);
  if (to === "closed") await issueDomainEvent(tx, scope, "issues.issue.closed", subject, actor, data, extra.cause);
  return row;
}

/** A person's status change, validated by the machine (I-6). */
export async function setIssueStatus(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const input = statusInput.parse(raw);
  const issue = await loadIssue(tx, scope, id);
  assertVersion(issue, input.expectedVersion);
  if (input.status === "duplicate") throw new DomainError("ISSUES_MERGE_REQUIRED", 409);
  assertTransition(issue.status, input.status);
  return applyStatus(tx, scope, issue, input.status, actor, { reason: input.reason });
}

/**
 * An automatic move by a sync rule (I-4): forward along the chain only, or
 * the explicit reopen of a fix-ready issue. Returns whether it moved; a
 * move that is not allowed (or already made) is a no-op.
 */
export async function autoMoveIssue(
  tx: DbTx,
  scope: Scope,
  id: string,
  to: IssueStatus,
  actor: IssueActor,
  options: { cause?: DomainEventView | null; reopen?: boolean; reason?: string } = {},
) {
  const issue = await tx.issue.findFirst({ where: { projectId: scope.projectId, id } });
  if (!issue || !autoMoveAllowed(issue.status, to, options.reopen)) return false;
  await applyStatus(tx, scope, issue, to, actor, options);
  return true;
}

/** Internal: marks a merged issue as a duplicate of its target (merge.ts). */
export function markDuplicate(tx: DbTx, scope: Scope, issue: IssueRow, targetId: string, actor: IssueActor) {
  return applyStatus(tx, scope, issue, "duplicate", actor, { mergedIntoIssueId: targetId });
}

/** Internal: a new report reopens a closed issue into triage (plan §2.3). */
export async function reopenOnReport(tx: DbTx, scope: Scope, issue: IssueRow, actor: IssueActor) {
  if (issue.status !== "closed") return issue;
  return applyStatus(tx, scope, issue, "triage", actor, { reason: "new_report" });
}

const shareInput = z.object({ reviewed: z.boolean(), expectedVersion }).strict();

/**
 * The coding export gate (I-5): an editor or owner confirms that the
 * issue's fields hold no personal data before a coding brief uses them.
 * A later change of a text field clears it again (updateIssue).
 */
export async function setShareReview(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const input = shareInput.parse(raw);
  const issue = await loadIssue(tx, scope, id);
  assertVersion(issue, input.expectedVersion);
  const row = await tx.issue.update({
    where: { id: issue.id },
    data: {
      shareReviewedAt: input.reviewed ? new Date() : null,
      shareReviewedBy: input.reviewed ? (actor.id ?? actor.kind) : null,
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, scope, issue.id, "share_review", actor, { reviewed: Boolean(issue.shareReviewedAt) }, { reviewed: input.reviewed });
  return row;
}

/** The fields a coding brief may use, only after the share review. */
export function shareableFields(issue: IssueRow) {
  if (!issue.shareReviewedAt) throw new DomainError("ISSUES_SHARE_REVIEW_REQUIRED", 409);
  return {
    key: `ISS-${issue.number}`,
    title: issue.title,
    summary: issue.summary ?? "",
    type: issue.type,
    severity: issue.severity,
    components: issue.components,
    acceptanceCriteria: issue.acceptanceCriteria,
  };
}

export function issueView(row: IssueRow) {
  return {
    id: row.id,
    number: row.number,
    key: `ISS-${row.number}`,
    type: row.type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    severity: row.severity,
    priority: row.priority,
    category: row.category,
    components: row.components,
    assigneeUserId: row.assigneeUserId,
    environment: row.environment,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    reportCount: row.reportCount,
    ticketCount: row.ticketCount,
    mergedIntoIssueId: row.mergedIntoIssueId,
    acceptanceCriteria: row.acceptanceCriteria,
    shareReviewed: Boolean(row.shareReviewedAt),
    aiTriage: row.aiTriage,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
