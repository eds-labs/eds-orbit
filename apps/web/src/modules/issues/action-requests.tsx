"use client";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";
import { issuesText } from "./labels";

// Issue center proposals in the decisions inbox (plan §6): what the
// assistant or an MCP client proposes, decided by an editor (Support's
// hand-in by the owner).

const KINDS = ["issue_report", "issue_update", "issue_merge", "issue_task", "support_issue_report"];

export const issuesDecisionRenderer: ActionRequestRenderer = {
  accepts: (item) => KINDS.includes(item.summary?.operation?.kind),
  component: ({ item, de, pending, decide }) => {
    const t = issuesText(de ? "de" : "en");
    const op = item.summary.operation as Record<string, any>;
    const title = {
      issue_report: t.decisions.report,
      issue_update: t.decisions.update,
      issue_merge: t.decisions.merge,
      issue_task: t.decisions.task,
      support_issue_report: t.decisions.supportReport,
    }[op.kind as string];
    return (
      <article className="action-request">
        <h3>{title}</h3>
        {op.title && <p>{op.title}</p>}
        {typeof op.number === "number" && <p>ISS-{op.number}</p>}
        {typeof op.intoNumber === "number" && <p>→ ISS-{op.intoNumber}</p>}
        {typeof op.issueNumber === "number" && <p>ISS-{op.issueNumber}</p>}
        {Array.isArray(op.fields) && op.fields.length > 0 && <p>{op.fields.join(", ")}</p>}
        <p className="panel-note">{t.decisions.once}</p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {t.decisions.approve}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
            {t.decisions.reject}
          </Button>
        </div>
      </article>
    );
  },
};

export const issuesActionRequests = {
  ...Object.fromEntries(
    ["issues_propose_report", "issues_propose_update", "issues_propose_merge", "issues_propose_task"].map((name) => [`issues.mcp.${name}`, issuesDecisionRenderer]),
  ),
};
