import { randomUUID } from "node:crypto";
import {
  Prisma,
  scoped,
  type DbTx,
} from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  attachmentInputTokens,
  estimateCost,
  isRejectedRequest,
  pdfPageCount,
  providerCallName,
  respond,
  type ProviderId,
} from "../../../../../../packages/ai/src/index.ts";
import {
  markTransmitted,
  reserve,
  settle,
} from "../../../platform/ai/budget.ts";
import { planCall } from "../../../platform/ai/call-plan.ts";
import {
  openAiConfigurationVersion,
  runtimeOpenAiConfiguration,
} from "../../../platform/ai/openai-configuration.ts";
import { requireSpendMandate } from "../../../platform/ai/spend-mandate.ts";
import {
  errorCode,
  finishRun,
  hashText,
  recordSpan,
  startRun,
} from "../../../platform/ai/telemetry.ts";
import { readFile } from "../../../platform/files/files.ts";
import { audit, DomainError } from "../../../shared.ts";
import { listCategories } from "../categories.ts";
import { listCostCenters } from "../cost-centers.ts";
import { financeActive } from "../gate.ts";
import { dedupeKeys, duplicateCheck } from "../intake/duplicates.ts";
import { archiveMailWhenDone } from "../intake/mail.ts";
import { readFinanceSettings, type FinanceSettings } from "../settings.ts";
import { buildInstructions, documentInput, type HintOption } from "./prompt.ts";
import {
  extractionJsonSchema,
  extractionSchema,
  type Extraction,
} from "./schema.ts";
import { suggestBooking, type HintKeys, type Suggestion } from "./suggest.ts";
import {
  normalizeExtraction,
  validateExtraction,
  type Normalized,
} from "./validate.ts";

// AI extraction of one finance document (spec §6 "AI safety"). The
// document is untrusted input: the model gets no tools, the document only
// as user input, and its answer is parsed and checked like any outside
// data. The call takes the platform's paid path (spend mandate, finance
// daily ceiling, reservation, settlement); an unknown outcome is settled
// as null and never retried automatically. The result is always a document
// for a person to review, never a booking.

const CATEGORY = "finance_document";
/** Larger originals are not sent; a person enters them (flag `too_long`). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
/** Bounds on the names listed in the instructions. */
const MAX_CATEGORIES = 200;
const MAX_COST_CENTERS = 100;

type DocumentRow = Awaited<
  ReturnType<DbTx["financeDocument"]["findFirstOrThrow"]>
>;

type Outcome =
  | { kind: "parsed"; value: Extraction; agentRunId: string | null }
  | {
      kind: "review";
      flag: string;
      reason: string;
      agentRunId: string | null;
      failed?: boolean;
    }
  | { kind: "failed"; reason: string; agentRunId: string | null };

const unique = (flags: string[]) => [...new Set(flags)];

const confidenceBucket = (confidence: number, settings: FinanceSettings) =>
  confidence >= settings.reviewConfidence
    ? "high"
    : confidence >= 0.5
      ? "medium"
      : "low";

/** The stored extraction JSON: micros as strings, no flags (they are a column). */
function extractionJson(
  n: Normalized,
  suggestion: Suggestion,
  extra: Record<string, unknown>,
): Prisma.InputJsonValue {
  const micros = (value: bigint | null) =>
    value === null ? null : value.toString();
  const { flags: _flags, ...rest } = n;
  return {
    ...rest,
    netMicros: micros(n.netMicros),
    taxMicros: micros(n.taxMicros),
    totalMicros: micros(n.totalMicros),
    lines: n.lines.map((line) => ({
      ...line,
      amountMicros: micros(line.amountMicros),
      taxMicros: micros(line.taxMicros),
    })),
    suggestion,
    ...extra,
  } as Prisma.InputJsonValue;
}

/**
 * Moves a document still in `received` on, and asks for the mail archive
 * when its mail is done. False when another run already moved it.
 */
async function finishDocument(
  tx: DbTx,
  scope: Scope,
  doc: DocumentRow,
  data: Prisma.FinanceDocumentUpdateManyMutationInput & { status: string },
) {
  const updated = await tx.financeDocument.updateMany({
    where: { id: doc.id, projectId: scope.projectId, status: "received" },
    data: { ...data, version: { increment: 1 } },
  });
  if (updated.count !== 1) return false;
  if (
    doc.source === "email" &&
    doc.inboundEmailId &&
    doc.mailboxId &&
    doc.messageId
  )
    try {
      await archiveMailWhenDone(tx, scope, {
        inboundEmailId: doc.inboundEmailId,
        mailboxId: doc.mailboxId,
        messageId: doc.messageId,
      });
    } catch (error) {
      // A refused archive request (for example an unbound mailbox) never
      // undoes the extraction; the mail stays in the inbox.
      if (!(error instanceof DomainError)) throw error;
    }
  return true;
}

/** Leaves the document for a person without (or after) a model call. */
async function toReview(
  scope: Scope,
  doc: DocumentRow,
  outcome: {
    status: "needs_review" | "failed";
    flag: string;
    reason: string;
    agentRunId?: string | null;
    /** A model answer that could not be used, as opposed to a call not made. */
    failed?: boolean;
  },
) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const moved = await finishDocument(tx, scope, doc, {
      status: outcome.status,
      flags: unique([...doc.flags, outcome.flag]),
      ...(outcome.agentRunId ? { agentRunId: outcome.agentRunId } : {}),
    });
    if (moved)
      await audit(
        tx,
        scope,
        outcome.failed
          ? "finance.extraction.failed"
          : "finance.extraction.skipped",
        doc.id,
        { reason: outcome.reason },
      );
  });
}

/** Prompt keys for the project's active categories and cost centers. */
async function hintOptions(tx: DbTx, scope: Scope) {
  const [categories, costCenters] = await Promise.all([
    listCategories(tx, scope),
    listCostCenters(tx, scope),
  ]);
  const keys: HintKeys = { categories: new Map(), costCenters: new Map() };
  const categoryOptions: HintOption[] = categories
    .slice(0, MAX_CATEGORIES)
    .map((c, i) => {
      keys.categories.set(`c${i + 1}`, { id: c.id, kind: c.kind });
      return { key: `c${i + 1}`, name: `${c.name} (${c.kind})` };
    });
  const costCenterOptions: HintOption[] = costCenters
    .slice(0, MAX_COST_CENTERS)
    .map((c, i) => {
      keys.costCenters.set(`k${i + 1}`, c.id);
      return { key: `k${i + 1}`, name: c.name };
    });
  return { keys, categoryOptions, costCenterOptions };
}

/**
 * The finance daily ceiling: today's (UTC) settled and open finance
 * reservations of the project plus this estimate stay within
 * `aiDailyCeilingMicros`.
 */
async function assertDailyFinanceCeiling(
  tx: DbTx,
  scope: Scope,
  settings: FinanceSettings,
  estimate: number,
) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const today = await tx.budgetReservation.findMany({
    where: {
      projectId: scope.projectId,
      category: CATEGORY,
      createdAt: { gte: dayStart },
      state: { not: "released" },
    },
    select: { amountMicros: true, settledMicros: true },
  });
  const spent = today.reduce(
    (sum, r) => sum + Number(r.settledMicros ?? r.amountMicros),
    0,
  );
  if (spent + estimate > settings.aiDailyCeilingMicros)
    throw new DomainError("FINANCE_AI_CEILING", 409);
}

function finalText(output: unknown[]) {
  const messages = output.filter(
    (item: any) => item?.type === "message",
  ) as any[];
  return ((messages.at(-1)?.content ?? []) as any[])
    .filter((part) => part?.type === "output_text")
    .map((part) => String(part.text ?? ""))
    .join("");
}

/** One paid, strict-output, tool-free model call (mirrors Support's modelCall). */
async function modelCall(
  scope: Scope,
  input: {
    doc: DocumentRow;
    settings: FinanceSettings;
    instructions: string;
    content: unknown[];
    estimateTokens: number;
    attemptKey: string;
  },
): Promise<Outcome> {
  const { doc } = input;
  const routeVersion = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    openAiConfigurationVersion(tx, scope),
  );
  const agentRunId = await startRun(scope, {
    kind: "finance",
    agentName: "finance.extraction",
    taskClass: "finance_extraction",
    subjectType: "finance_document",
    subjectId: doc.id,
    routeVersion,
  });
  let reservationId: string | null = null;
  let model: string | undefined;
  let provider: ProviderId = "openai";
  const startedAt = new Date();
  try {
    const prepared = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        const project = await tx.project.findUniqueOrThrow({
          where: { id: scope.projectId },
        });
        if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
        const mandate = await requireSpendMandate(tx, scope);
        const runtime = await runtimeOpenAiConfiguration(tx, scope);
        if ((runtime.routeVersion ?? null) !== routeVersion)
          throw new DomainError("FINANCE_ROUTE_CHANGED", 409);
        const plan = await planCall(
          tx,
          scope,
          "finance_extraction",
          runtime,
          (candidate) =>
            estimateCost(
              candidate.model,
              input.estimateTokens,
              candidate.maxOutputTokens,
              runtime,
            ),
        );
        await assertDailyFinanceCeiling(
          tx,
          scope,
          input.settings,
          plan.estimateMicros,
        );
        // One key per job attempt: a repeated job finds its call already
        // reserved and never pays twice.
        const reservation = await reserve(
          tx,
          scope,
          `finance:${doc.id}:extract:${input.attemptKey}`,
          CATEGORY,
          plan.estimateMicros,
          mandate.limits,
          new Date(),
          `finance:${doc.id}`,
          {
            agentRunId,
            taskClass: "finance_extraction",
            model: plan.route.model,
            missionId: null,
          },
        );
        await markTransmitted(tx, scope, reservation.id);
        return {
          runtime,
          route: plan.route,
          provider: plan.provider,
          fallbackFrom: plan.fallbackFrom,
          reservationId: reservation.id,
        };
      },
    );
    reservationId = prepared.reservationId;
    model = prepared.route.model;
    provider = prepared.provider;
    const result = await respond({
      route: prepared.route,
      instructions: input.instructions,
      input: [{ role: "user", content: input.content }],
      tools: [],
      outputSchema: extractionJsonSchema(),
      reservationId: prepared.reservationId,
      runtime: prepared.runtime,
    });
    const settledId = prepared.reservationId;
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      settle(tx, scope, settledId, result.usage.costMicros).then(
        () => undefined,
      ),
    );
    reservationId = null;
    const { model: _m, costMicros, ...usage } = result.usage;
    await recordSpan(scope, agentRunId, {
      type: "model_call",
      name:
        providerCallName(provider, "create") +
        (prepared.fallbackFrom ? " (fallback)" : ""),
      model,
      status: "succeeded",
      startedAt,
      durationMs: Date.now() - startedAt.valueOf(),
      usage,
      costMicros,
      budgetReservationId: settledId,
      providerResponseId: result.responseId,
      inputHash: hashText(doc.sha256),
    });
    let value: Extraction;
    try {
      value = extractionSchema.parse(JSON.parse(finalText(result.output)));
    } catch {
      await recordSpan(scope, agentRunId, {
        type: "model_call",
        name: "output_validation",
        status: "failed",
        startedAt: new Date(),
        durationMs: 0,
        errorCode: "FINANCE_OUTPUT_NOT_VALID",
      });
      await finishRun(scope, agentRunId, "failed", "FINANCE_OUTPUT_NOT_VALID");
      return {
        kind: "review",
        flag: "extraction_failed",
        reason: "FINANCE_OUTPUT_NOT_VALID",
        agentRunId,
        failed: true,
      };
    }
    await finishRun(scope, agentRunId, "succeeded");
    return { kind: "parsed", value, agentRunId };
  } catch (error) {
    const code = errorCode(error);
    if (reservationId) {
      // Never retried: an ambiguous paid call stays "unknown". A request the
      // provider refused, or input the provider adapter refused before
      // sending, cost nothing.
      const id = reservationId;
      const rejected =
        isRejectedRequest(error) || code === "AI_INPUT_UNSUPPORTED";
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        settle(tx, scope, id, rejected ? 0 : null).then(() => undefined),
      ).catch(() => undefined);
      await recordSpan(scope, agentRunId, {
        type: "model_call",
        name: providerCallName(provider, "create"),
        model,
        status: rejected ? "failed" : "unknown",
        startedAt,
        durationMs: Date.now() - startedAt.valueOf(),
        errorCode: code,
      });
      await finishRun(scope, agentRunId, rejected ? "failed" : "unknown", code);
      return rejected
        ? {
            kind: "review",
            flag: "extraction_failed",
            reason: "FINANCE_CALL_NOT_ACCEPTED",
            agentRunId,
            failed: true,
          }
        : { kind: "failed", reason: "FINANCE_CALL_UNKNOWN", agentRunId };
    }
    await finishRun(scope, agentRunId, "blocked", code);
    // An earlier attempt of this job holds the reservation: its call may
    // have been sent, so this one is not made (outcome unknown).
    if (code === "RESERVATION_ALREADY_USED")
      return { kind: "failed", reason: "FINANCE_CALL_UNKNOWN", agentRunId };
    if (code === "FINANCE_AI_CEILING")
      return {
        kind: "review",
        flag: "ai_ceiling",
        reason: "ai_ceiling",
        agentRunId,
      };
    // Nothing was reserved or sent. A domain refusal (paused project, no
    // mandate, budget) leaves the document for a person; anything else is
    // retried by the worker.
    if (error instanceof DomainError || /REQUIRED|UNSUPPORTED/.test(code))
      return {
        kind: "review",
        flag: "extraction_failed",
        reason: code,
        agentRunId,
      };
    throw error;
  }
}

/**
 * Extracts one document that is still `received` (the `finance_extract`
 * job). A document in any other state is left alone, so a repeated job
 * does nothing. The outcome is `needs_review` (or `duplicate`) with the
 * extraction, flags, confidence and suggestions, `needs_review` with a
 * flag when the model was skipped or its answer unusable, or `failed`
 * when a sent call's outcome is unknown (a person retries).
 */
export async function runFinanceExtraction(
  scope: Scope,
  job: { documentId: string; attemptKey: string },
): Promise<void> {
  const loaded = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const doc = await tx.financeDocument.findFirst({
        where: { id: job.documentId, projectId: scope.projectId },
      });
      if (!doc) throw new DomainError("FINANCE_DOCUMENT_NOT_FOUND", 404);
      if (!(await financeActive(tx, scope)) || doc.status !== "received")
        return null;
      const { settings } = await readFinanceSettings(tx, scope);
      return { doc, settings, ...(await hintOptions(tx, scope)) };
    },
  );
  if (!loaded) return;
  const { doc, settings, keys } = loaded;
  if (settings.aiExtraction !== "on")
    return toReview(scope, doc, {
      status: "needs_review",
      flag: "ai_off",
      reason: "ai_off",
    });

  const { bytes } = await readFile(scope, doc.fileId);
  const pages = doc.mimeType === "application/pdf" ? pdfPageCount(bytes) : 0;
  if (bytes.byteLength > MAX_DOCUMENT_BYTES || pages > MAX_PDF_PAGES)
    return toReview(scope, doc, {
      status: "needs_review",
      flag: "too_long",
      reason: "too_long",
    });

  const instructions = buildInstructions(
    loaded.categoryOptions,
    loaded.costCenterOptions,
  );
  let document: Awaited<ReturnType<typeof documentInput>>;
  try {
    document = await documentInput({
      mime: doc.mimeType,
      bytes,
      nonce: randomUUID(),
      pages,
    });
  } catch {
    // A mail the parser cannot read is left for a person; nothing was sent.
    return toReview(scope, doc, {
      status: "needs_review",
      flag: "extraction_failed",
      reason: "FINANCE_DOCUMENT_UNREADABLE",
    });
  }
  // Text is reserved at one token per byte (as Support does); files and
  // images at the platform's per-page and per-image allowance.
  const textBytes = document.content
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  const estimateTokens =
    Buffer.byteLength(instructions) +
    textBytes +
    (document.kind === "pdf"
      ? attachmentInputTokens([{ kind: "pdf", pages: document.pages }])
      : document.kind === "image"
        ? attachmentInputTokens([{ kind: "image" }])
        : 0);

  const outcome = await modelCall(scope, {
    doc,
    settings,
    instructions,
    content: document.content,
    estimateTokens,
    attemptKey: job.attemptKey,
  });
  if (outcome.kind === "review")
    return toReview(scope, doc, {
      status: "needs_review",
      flag: outcome.flag,
      reason: outcome.reason,
      agentRunId: outcome.agentRunId,
      failed: outcome.failed,
    });
  if (outcome.kind === "failed")
    return toReview(scope, doc, {
      status: "failed",
      flag: "extraction_failed",
      reason: outcome.reason,
      agentRunId: outcome.agentRunId,
      failed: true,
    });

  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const n = normalizeExtraction(outcome.value, settings);
    const flags = [...n.flags, ...validateExtraction(n, settings)];
    const suggestion = await suggestBooking(tx, scope, n, keys);
    const counterpartyId = suggestion.counterpartyId ?? null;
    const duplicate = await duplicateCheck(tx, scope, doc.id, n, {
      counterpartyId,
      windowDays: settings.duplicateWindowDays,
    });
    if (duplicate.possible) flags.push("possible_duplicate");
    const status = duplicate.duplicateOfId ? "duplicate" : "needs_review";
    const finalFlags = unique([...doc.flags, ...flags]);
    const moved = await finishDocument(tx, scope, doc, {
      status,
      docType: n.docType,
      confidence: n.confidence,
      flags: finalFlags,
      duplicateOfId: duplicate.duplicateOfId ?? null,
      agentRunId: outcome.agentRunId,
      extraction: extractionJson(n, suggestion, {
        dedupe: dedupeKeys(n, counterpartyId),
        possibleDuplicateOfId: duplicate.possible ?? null,
      }),
    });
    if (!moved) return;
    // Content-free: counts and fixed codes only.
    await audit(tx, scope, "finance.document.extracted", doc.id, {
      flags: finalFlags.length,
      flagCodes: finalFlags,
      confidence: confidenceBucket(n.confidence, settings),
      duplicate: Boolean(duplicate.duplicateOfId),
      suggestion: suggestion.source,
    });
  });
}
