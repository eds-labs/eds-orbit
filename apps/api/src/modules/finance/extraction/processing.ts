import type { DbTx, Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError } from "../../../shared.ts";
import { activePolicyRecord } from "../../../platform/ai/spend-mandate.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { assertUpdated } from "../common.ts";
import { FINANCE_EXTRACT } from "../queues.ts";

// Where a document stands in AI extraction, why it stopped, and whether it
// may run (again). A document that arrived while AI extraction was off, hit
// the daily ceiling or whose model answer failed waits in review with a flag;
// a person (or the owner turning AI on) starts the extraction for it. The
// last failure is kept on the document as `extraction.processing` with a
// fixed code, never content.

type Doc = Prisma.FinanceDocumentGetPayload<object>;

/** Flags that mean "no usable AI result yet": the extraction may run. */
export const PENDING_AI_FLAGS = ["ai_off", "ai_ceiling", "extraction_failed"];

/** Documents the owner's switch to AI-on queues at most, newest first. */
export const BACKLOG_LIMIT = 50;
/** How far back that switch looks. */
export const BACKLOG_DAYS = 30;

export type Processing = {
  lastErrorCode: string;
  lastErrorAt: string;
  agentRunId?: string | null;
};

const json = (value: unknown) => value as Prisma.InputJsonValue;

const stored = (doc: Pick<Doc, "extraction">) =>
  (doc.extraction ?? {}) as Record<string, unknown>;

export const attemptOf = (doc: Pick<Doc, "extraction">) =>
  Number(stored(doc).extractionAttempt ?? 0);

export const processingOf = (doc: Pick<Doc, "extraction">) =>
  (stored(doc).processing as Processing | undefined) ?? null;

/** The extraction JSON with the last failure recorded. */
export function withProcessing(
  doc: Pick<Doc, "extraction">,
  processing: Processing,
) {
  return json({ ...stored(doc), processing });
}

export const extractKey = (documentId: string, attempt: number) =>
  attempt
    ? `finance-extract:${documentId}:${attempt}`
    : `finance-extract:${documentId}`;

/** The job of the document's current extraction attempt, if any. */
export async function extractionJob(tx: DbTx, scope: Scope, doc: Doc) {
  const job = await tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: "jobs",
      data: {
        path: ["idempotencyKey"],
        equals: extractKey(doc.id, attemptOf(doc)),
      },
    },
  });
  if (!job) return null;
  const d = data(job);
  return {
    id: job.id,
    status: String(d.status ?? "queued"),
    attempts: Number(d.attempts ?? 0),
    error: d.error ? String(d.error).slice(0, 160) : null,
  };
}

/**
 * The paid call needs the owner's consent (`aiOn`) and an active policy
 * with a spending mandate; without one every call stops at POLICY_REQUIRED.
 */
async function paidCallBlock(tx: DbTx, scope: Scope, aiOn: boolean) {
  if (!aiOn) return "FINANCE_AI_OFF";
  return (await activePolicyRecord(tx, scope)) ? null : "POLICY_REQUIRED";
}

/**
 * Why the extraction may not start now, or null. `aiOn` is the project's
 * consent; a person's edits are never overwritten by a new model answer.
 */
export async function extractionBlock(
  tx: DbTx,
  scope: Scope,
  doc: Doc,
  aiOn: boolean,
): Promise<string | null> {
  if (doc.status === "received") {
    const job = await extractionJob(tx, scope, doc);
    return !job || ["blocked_dependency", "failed"].includes(job.status)
      ? paidCallBlock(tx, scope, aiOn)
      : "FINANCE_EXTRACTION_RUNNING";
  }
  if (doc.status === "needs_review") {
    if (doc.flags.includes("too_long")) return "FINANCE_DOCUMENT_TOO_LONG";
    if (!doc.flags.some((flag) => PENDING_AI_FLAGS.includes(flag)))
      return "FINANCE_EXTRACTION_DONE";
    const edits = await tx.financeDocumentRevision.count({
      where: { projectId: scope.projectId, documentId: doc.id },
    });
    if (edits) return "FINANCE_DRAFT_EDITED";
  } else if (doc.status !== "failed") return "FINANCE_EXTRACTION_NOT_POSSIBLE";
  return paidCallBlock(tx, scope, aiOn);
}

/**
 * Starts a new extraction attempt (`finance-extract:<id>:<n>`): the
 * document goes back to `received` without its pending-AI flags. Guarded
 * by version and status, so it starts once. Audited with the trigger.
 */
export async function startExtraction(
  tx: DbTx,
  scope: Scope,
  doc: Doc,
  trigger: "person" | "consent" | "mcp",
) {
  const next = attemptOf(doc) + 1;
  const moved = await tx.financeDocument.updateMany({
    where: {
      projectId: scope.projectId,
      id: doc.id,
      version: doc.version,
      status: doc.status,
    },
    data: {
      status: "received",
      flags: doc.flags.filter((flag) => !PENDING_AI_FLAGS.includes(flag)),
      extraction: json({ ...stored(doc), extractionAttempt: next }),
      version: { increment: 1 },
    },
  });
  assertUpdated(moved.count);
  await enqueue(tx, scope, FINANCE_EXTRACT, doc.id, extractKey(doc.id, next));
  await audit(tx, scope, "finance.extraction.retried", doc.id, {
    attempt: next,
    trigger,
  });
  return next;
}

/** A person's (or an approved MCP proposal's) explicit start. */
export async function startExtractionFor(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  aiOn: boolean,
  trigger: "person" | "mcp",
) {
  const doc = await tx.financeDocument.findFirst({
    where: { projectId: scope.projectId, id: documentId },
  });
  if (!doc) throw new DomainError("FINANCE_DOCUMENT_NOT_FOUND", 404);
  const block = await extractionBlock(tx, scope, doc, aiOn);
  if (block) throw new DomainError(block, 409);
  await startExtraction(tx, scope, doc, trigger);
}

/**
 * When the owner turns AI extraction on: documents that arrived while it
 * was off, unedited and from the last BACKLOG_DAYS, are queued (at most
 * BACKLOG_LIMIT). The daily ceiling still bounds the spend; documents it
 * stops wait with `ai_ceiling` for a person.
 */
export async function queuePendingExtractions(tx: DbTx, scope: Scope) {
  // Without a spending mandate every queued job would stop at once.
  if (!(await activePolicyRecord(tx, scope))) return 0;
  const since = new Date(Date.now() - BACKLOG_DAYS * 86_400_000);
  const candidates = await tx.financeDocument.findMany({
    where: {
      projectId: scope.projectId,
      status: "needs_review",
      flags: { has: "ai_off" },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: BACKLOG_LIMIT,
  });
  let queued = 0;
  for (const doc of candidates)
    if (!(await extractionBlock(tx, scope, doc, true))) {
      await startExtraction(tx, scope, doc, "consent");
      queued++;
    }
  if (queued)
    await audit(tx, scope, "finance.extraction.backlog_queued", scope.projectId, {
      count: queued,
    });
  return queued;
}

/** One document's processing state, for the review page and MCP. */
export async function processingStatus(
  tx: DbTx,
  scope: Scope,
  documentId: string,
  aiOn: boolean,
) {
  const doc = await tx.financeDocument.findFirst({
    where: { projectId: scope.projectId, id: documentId },
  });
  if (!doc) throw new DomainError("FINANCE_DOCUMENT_NOT_FOUND", 404);
  const [job, block] = await Promise.all([
    extractionJob(tx, scope, doc),
    extractionBlock(tx, scope, doc, aiOn),
  ]);
  return {
    documentId: doc.id,
    status: doc.status,
    flags: doc.flags,
    attempt: attemptOf(doc),
    extracted: Boolean(doc.agentRunId) && !doc.flags.includes("extraction_failed"),
    agentRunId: doc.agentRunId,
    lastError: processingOf(doc),
    job,
    canStartExtraction: block === null,
    blockedBy: block,
    receivedAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Documents whose extraction did not produce a usable result: failed, or
 * waiting in review with a pending-AI or too-long flag. Newest first.
 */
export async function listProcessingErrors(
  tx: DbTx,
  scope: Scope,
  limit = 50,
) {
  const rows = await tx.financeDocument.findMany({
    where: {
      projectId: scope.projectId,
      OR: [
        { status: "failed" },
        {
          status: "needs_review",
          flags: { hasSome: [...PENDING_AI_FLAGS, "too_long"] },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map((doc) => ({
    documentId: doc.id,
    status: doc.status,
    flags: doc.flags,
    source: doc.source,
    attempt: attemptOf(doc),
    lastError: processingOf(doc),
    receivedAt: doc.createdAt.toISOString(),
  }));
}
