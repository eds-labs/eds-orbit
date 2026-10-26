import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { componentKey, ISSUE_TYPES, SEVERITIES, uuid, type IssueActor } from "../common.ts";
import { ingestReport } from "../intake.ts";

// A member's report (plan §2.4 "Manual / MCP"): a new issue, or a report on
// a chosen issue. It runs through the same intake as every other source.

export const manualReportInput = z
  .object({
    issueId: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    symptoms: z.string().trim().max(4000).default(""),
    type: z.enum(ISSUE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    components: z.array(componentKey).max(20).default([]),
    environment: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
  })
  .strict();

export function reportManually(tx: DbTx, scope: Scope, raw: unknown, actor: IssueActor, sourceKind: "manual" = "manual") {
  const input = manualReportInput.parse(raw);
  return ingestReport(
    tx,
    scope,
    {
      sourceKind,
      title: input.title,
      symptoms: input.symptoms,
      typeHint: input.type,
      severityHint: input.severity,
      componentHints: input.components,
      environment: input.environment,
    },
    actor,
    { issueId: input.issueId },
  );
}
