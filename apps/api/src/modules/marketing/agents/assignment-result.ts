import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";
import { runOperation } from "./run-operation.ts";
import { runDeliverables } from "./veto.ts";

/** Bounded saved evidence for the assistant card, independent of chat lifetime. */
export async function latestAssignmentResult(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
) {
  const run = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assignment_runs",
      data: { path: ["assignmentId"], equals: assignmentId },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!run) return null;
  const d = data(run);
  const result = await runDeliverables(tx, scope, run);
  const contents = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      id: { in: result.deliverables.map((item) => String(item.contentId)) },
    },
  });
  const images = new Map(contents.map((row) => [row.id, data(row).assetId]));
  const tasks = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "agent_tasks",
      data: { path: ["runId"], equals: run.id },
    },
    take: 100,
  });
  return {
    operation: await runOperation(tx, scope, run, result.deliverables),
    id: run.id,
    date: String(d.date),
    status: String(d.status),
    costMicros: Number(d.costMicros ?? 0),
    blockers: [
      ...new Set<string>([
        ...tasks
          .map((row) => data(row).errorCode)
          .filter((code): code is string => typeof code === "string"),
        ...(Array.isArray(d.unavailable)
          ? d.unavailable.map((item: any) =>
              String(item.code ?? item.reason ?? item),
            )
          : []),
        ...(Array.isArray(d.steps)
          ? d.steps
              .filter((step: any) =>
                ["failed", "blocked_dependency", "outcome_unknown"].includes(
                  step.status,
                ),
              )
              .map((step: any) => String(step.error ?? step.status))
          : []),
        ...result.deliverables
          .filter((item) => item.reason)
          .map((item) => String(item.reason)),
      ]),
    ].slice(0, 20),
    deliverables: result.deliverables.map((item) => ({
      contentId: String(item.contentId),
      assetId:
        typeof images.get(String(item.contentId)) === "string"
          ? String(images.get(String(item.contentId)))
          : null,
      channel: String(item.channel),
      outcome: String(item.outcome),
      publicationStatus: item.publicationStatus
        ? String(item.publicationStatus)
        : null,
      reason: item.reason ? String(item.reason) : null,
      publicationId: item.publicationId ? String(item.publicationId) : null,
      postizDraftId: item.postizDraftId ? String(item.postizDraftId) : null,
    })),
  };
}
