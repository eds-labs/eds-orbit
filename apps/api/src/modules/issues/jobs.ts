import { scoped } from "../../../../../packages/db/src/index.ts";
import type { JobDef } from "../../platform/jobs/types.ts";
import { scrubWebhookBody, WEBHOOK_KIND } from "../../platform/http/webhooks.ts";
import { audit, data, DomainError } from "../../shared.ts";
import { issuesActive } from "./gate.ts";
import { ingestReport } from "./intake.ts";
import { ISSUES_INTAKE, normalizeWebhook } from "./sources/webhook.ts";

// The issue center's background work (plan §4.3). A stored webhook
// delivery becomes a report; afterwards its raw body is dropped whatever
// the outcome (I-5). Nothing here calls a provider, so a retry is safe.

export const issuesJobs: JobDef[] = [
  {
    queueClass: ISSUES_INTAKE,
    async handler({ scope, job }) {
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const row = await tx.entity.findFirst({
          where: { id: job.resourceId, kind: WEBHOOK_KIND, projectId: scope.projectId },
        });
        if (!row) return;
        const message = data(row);
        if (message.status !== "queued") return;
        if (!(await issuesActive(tx, scope))) {
          await scrubWebhookBody(tx, scope, row.id, { status: "skipped", code: "ISSUES_DISABLED" });
          return;
        }
        const connection = await tx.entity.findFirst({
          where: { id: String(message.connectionId), kind: "connectors", projectId: scope.projectId },
        });
        const sourceKind = connection ? data(connection).sourceKind : undefined;
        try {
          const result = await ingestReport(
            tx,
            scope,
            normalizeWebhook(message.body, { id: String(message.connectionId), sourceKind }),
            { kind: "integration", id: String(message.connectionId) },
          );
          await scrubWebhookBody(tx, scope, row.id, { status: "processed" });
          await audit(tx, scope, "issues.intake.received", result.reportId, {
            connectionId: message.connectionId,
            outcome: result.outcome,
            method: result.method,
          });
        } catch (error) {
          // A payload that does not fit the contract, or the daily cap.
          const code =
            error instanceof DomainError ? error.code : error instanceof Error && error.name === "ZodError" ? "ISSUES_PAYLOAD_INVALID" : null;
          if (!code) throw error;
          await scrubWebhookBody(tx, scope, row.id, { status: "rejected", code });
          await audit(tx, scope, "issues.intake.rejected", row.id, { connectionId: message.connectionId, code });
        }
      });
    },
  },
];
