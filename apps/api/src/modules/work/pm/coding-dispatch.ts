import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { triggerWorkflow } from "../../../platform/automation/workflows.ts";
import type { AutomationResultHandler } from "../../../platform/modules/contributions.ts";
import { audit, DomainError } from "../../../shared.ts";
import { pmActive } from "../gate.ts";
import {
  applyRunReport,
  markDispatched,
  renderBrief,
  runReportInput,
  type CodingBrief,
} from "./coding.ts";
import { readPmSettings } from "./settings.ts";

// The automation provider of coding work orders (ADR 0017 P-4, WP2.9): the
// redacted brief goes to the repository's bound n8n workflow with the
// contract event `coding_agent.requested`; the workflow starts the coding
// agent (for example a Claude Code GitHub Action) and reports back through
// the signed automation callback with a strictly validated result. Nothing
// is ever sent twice: a dispatch whose send may have happened ends as
// outcome_unknown for a person to settle.

export const CODING_EVENT = "coding_agent.requested";
export const CODING_CANCEL_EVENT = "coding_agent.cancel_requested";
const MAX_PAYLOAD = 16 * 1024;
/** The platform's actor for writes caused by an outside system's report. */
const systemScope = (scope: Pick<Scope, "workspaceId" | "projectId">): Scope => ({
  ...scope,
  userId: "system:work",
  role: "owner",
});

async function bindingOf(tx: DbTx, scope: Scope, repositoryKey: string) {
  const { settings } = await readPmSettings(tx, scope);
  const repo = settings.repositories.find((r) => r.key === repositoryKey);
  if (!repo || repo.dispatch.kind !== "automation") throw new DomainError("WORK_CODING_REPOSITORY_UNKNOWN", 409);
  return { repo, bindingId: repo.dispatch.bindingId, timeoutHours: settings.codingTimeoutHours };
}

/** The `coding_dispatch` job: sends an approved automation run once. */
export async function runCodingDispatchJob(workerScope: Scope, runId: string, now = new Date()) {
  const prepared = await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const row = await tx.workCodingRun.findFirst({ where: { projectId: workerScope.projectId, id: runId } });
    if (!row || row.status !== "dispatching") return null;
    // An earlier attempt may have sent it: never again.
    if (row.dispatchedAt) {
      await tx.workCodingRun.update({
        where: { id: row.id },
        data: { status: "outcome_unknown", errorCode: "WORK_CODING_DISPATCH_UNCLEAR", version: { increment: 1 } },
      });
      return null;
    }
    if (!(await pmActive(tx, workerScope))) {
      await tx.workCodingRun.update({
        where: { id: row.id },
        data: { status: "failed", errorCode: "WORK_PM_DISABLED", finishedAt: now, version: { increment: 1 } },
      });
      return null;
    }
    const { bindingId, timeoutHours } = await bindingOf(tx, workerScope, row.repositoryKey);
    const brief = row.brief as CodingBrief;
    const payload = {
      codingRunId: row.id,
      repository: brief.repository,
      baseBranch: brief.baseBranch,
      task: brief.task,
      brief: {
        goal: brief.goal,
        description: brief.description,
        acceptanceCriteria: brief.acceptanceCriteria,
        constraints: brief.constraints,
        doNotTouch: brief.doNotTouch,
        testExpectations: brief.testExpectations,
      },
      briefMarkdown: renderBrief(brief),
      ceilingMicros: Number(row.ceilingMicros),
      timeoutHours,
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD) {
      await tx.workCodingRun.update({
        where: { id: row.id },
        data: { status: "failed", errorCode: "WORK_CODING_BRIEF_TOO_LARGE", finishedAt: now, version: { increment: 1 } },
      });
      return null;
    }
    // Recorded before the send: a retried attempt sees that it may have happened.
    await tx.workCodingRun.update({ where: { id: row.id }, data: { dispatchedAt: now } });
    return { row, bindingId, payload };
  });
  if (!prepared) return;
  let sent: Awaited<ReturnType<typeof triggerWorkflow>> | null = null;
  let code: string | null = null;
  try {
    sent = await triggerWorkflow(systemScope(workerScope), {
      bindingId: prepared.bindingId,
      event: CODING_EVENT,
      payload: prepared.payload,
    });
  } catch (error) {
    // Refused before sending (binding or grant gone, secret invalid).
    code = error instanceof DomainError ? error.code : "WORK_CODING_DISPATCH_FAILED";
  }
  await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const row = await tx.workCodingRun.findFirstOrThrow({ where: { id: prepared.row.id } });
    if (sent && ["accepted", "test_receipt"].includes(String(sent.status))) {
      await tx.workCodingRun.update({
        where: { id: row.id },
        data: {
          automationRunId: sent.id,
          ...(sent.executionId ? { externalRef: String(sent.executionId) } : {}),
        },
      });
      await markDispatched(tx, workerScope, row, row.dispatchedAt ?? now);
    } else
      await tx.workCodingRun.update({
        where: { id: row.id },
        data: {
          status: sent?.status === "failed" || code ? "failed" : "outcome_unknown",
          errorCode: code ?? String(sent?.errorCode ?? "WORK_CODING_DISPATCH_UNCLEAR"),
          ...(sent ? { automationRunId: sent.id } : {}),
          ...(sent?.status === "failed" || code ? { finishedAt: now } : {}),
          version: { increment: 1 },
        },
      });
    await audit(tx, workerScope, "work.coding_run.dispatch_sent", row.id, {
      status: sent?.status ?? "refused",
      errorCode: code ?? sent?.errorCode ?? null,
    });
  });
}

/** The `coding_cancel` job: asks the workflow to stop the run. */
export async function runCodingCancelJob(workerScope: Scope, runId: string) {
  const prepared = await scoped(workerScope.workspaceId, workerScope.projectId, async (tx) => {
    const row = await tx.workCodingRun.findFirst({ where: { projectId: workerScope.projectId, id: runId } });
    if (!row || !["dispatched", "running", "outcome_unknown"].includes(row.status)) return null;
    const { bindingId } = await bindingOf(tx, workerScope, row.repositoryKey);
    return { row, bindingId };
  });
  if (!prepared) return;
  const sent = await triggerWorkflow(systemScope(workerScope), {
    bindingId: prepared.bindingId,
    event: CODING_CANCEL_EVENT,
    payload: { codingRunId: prepared.row.id, automationRunId: prepared.row.automationRunId },
  }).catch((error) => ({ status: "failed", errorCode: error instanceof DomainError ? error.code : "UNEXPECTED" }));
  await scoped(workerScope.workspaceId, workerScope.projectId, (tx) =>
    audit(tx, workerScope, "work.coding_run.cancel_sent", prepared.row.id, {
      status: String(sent.status),
    }),
  );
}

/** What the workflow reports for `coding_agent.requested`. */
export const codingResultSchema = z
  .object({
    status: z.enum(["started", "succeeded", "failed", "canceled"]),
    branch: runReportInput.shape.branch,
    prUrl: runReportInput.shape.prUrl,
    commitSha: runReportInput.shape.commitSha,
    tests: runReportInput.shape.tests,
    summary: runReportInput.shape.summary,
    reportedCostMicros: runReportInput.shape.reportedCostMicros,
    errorCode: runReportInput.shape.errorCode,
  })
  .strict();

/** Applies a callback result to the coding run it belongs to. */
export const codingResultHandler: AutomationResultHandler = {
  schema: codingResultSchema,
  async handle(tx, scope, run, raw) {
    const result = codingResultSchema.parse(raw);
    const row = await tx.workCodingRun.findFirst({
      where: { projectId: scope.projectId, automationRunId: run.id },
    });
    if (!row) return;
    const actor = systemScope(scope);
    const { status, ...rest } = result;
    try {
      await applyRunReport(tx, actor, row, { ...rest, status: status === "started" ? "running" : status });
    } catch (error) {
      // A report older than what is recorded (callbacks out of order).
      if (error instanceof DomainError && ["WORK_CODING_RUN_CLOSED", "WORK_CODING_TRANSITION"].includes(error.code)) {
        await audit(tx, actor, "work.coding_run.report_ignored", row.id, { status, current: row.status });
        return;
      }
      throw error;
    }
  },
};
