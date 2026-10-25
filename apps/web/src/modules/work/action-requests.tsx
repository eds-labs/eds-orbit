"use client";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";
import { pmText, usd } from "./pm-labels";

// Project management proposals in the decisions inbox (ADR 0016 D-7): what
// the assistant or an MCP client proposes, decided by an owner or editor.

const TITLES: Record<string, { en: string; de: string }> = {
  initiative: { en: "Create an initiative", de: "Vorhaben anlegen" },
  tasks: { en: "Create tasks", de: "Aufgaben anlegen" },
  update: { en: "Change a task", de: "Aufgabe ändern" },
  comment: { en: "Comment on a task", de: "Aufgabe kommentieren" },
};

export const workDecisionRenderer: ActionRequestRenderer = {
  accepts: (item) => Boolean(TITLES[item.summary?.operation?.kind]),
  component: ({ item, de, pending, decide }) => {
    const op = item.summary.operation as {
      kind: string;
      title?: string;
      titles?: string[];
      milestones?: string[];
      initiativeKey?: string | null;
      number?: number;
      fields?: string[];
      body?: string;
    };
    const list = op.kind === "tasks" ? op.titles : op.kind === "initiative" ? op.milestones : undefined;
    return (
      <article className="action-request">
        <h3>{TITLES[op.kind]![de ? "de" : "en"]}</h3>
        {op.title && <p>{op.title}</p>}
        {op.initiativeKey && (
          <p>
            {de ? "Vorhaben" : "Initiative"}: {op.initiativeKey}
          </p>
        )}
        {op.number !== undefined && <p>#{op.number}</p>}
        {list && list.length > 0 && (
          <ul>
            {list.map((title, i) => (
              <li key={i}>{title}</li>
            ))}
          </ul>
        )}
        {op.fields && op.fields.length > 0 && (
          <p>
            {de ? "Felder" : "Fields"}: {op.fields.join(", ")}
          </p>
        )}
        {op.body && <blockquote style={{ whiteSpace: "pre-wrap" }}>{op.body}</blockquote>}
        <p className="panel-note">
          {de
            ? "Die Freigabe führt genau diese Änderung einmal aus."
            : "Approval applies exactly this change once."}
        </p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {de ? "Freigeben" : "Approve"}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
            {de ? "Ablehnen" : "Reject"}
          </Button>
        </div>
      </article>
    );
  },
};

/**
 * The AI project manager's requests (ADR 0017): applying a plan, bulk task
 * changes, handoffs, coding dispatches and paid PM requests from MCP.
 */
export const pmDecisionRenderer: ActionRequestRenderer = {
  accepts: (item) =>
    ["new_plan", "extension", "bulk_update", "handoff", "coding_dispatch", "pm_plan", "pm_report"].includes(item.summary?.operation?.kind),
  component: ({ item, de, pending, decide }) => {
    const t = pmText(de ? "de" : "en");
    const op = item.summary.operation as Record<string, any>;
    const title =
      op.kind === "new_plan" || op.kind === "extension"
        ? t.decisions.plan
        : op.kind === "bulk_update"
          ? t.decisions.bulk
          : op.kind === "handoff"
            ? t.decisions.handoff
            : op.kind === "coding_dispatch"
              ? t.decisions.coding
              : op.kind === "pm_plan"
                ? t.decisions.pmPlan
                : t.decisions.pmReport;
    const ceiling = Number(item.costCeilingMicros ?? op.ceilingMicros ?? 0);
    const lines = (label: string, items?: string[]) =>
      items && items.length > 0 ? (
        <>
          <p>{label}</p>
          <ul>
            {items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      ) : null;
    return (
      <article className="action-request">
        <h3>{title}</h3>
        {op.initiative && <p>{op.initiative}</p>}
        {op.goal && <p>{op.goal}</p>}
        {op.initiativeKey && <p>{op.initiativeKey}</p>}
        {typeof op.tasks === "number" && <p>{t.decisions.tasksCount(op.tasks)}</p>}
        {typeof op.milestones === "number" && <p>{t.decisions.milestonesCount(op.milestones)}</p>}
        {op.target && <p>{op.target}</p>}
        {typeof op.task === "number" && <p>#{op.task}</p>}
        {op.repository && (
          <p>
            {t.repository}: {op.repository}
            {op.provider && ` (${op.provider})`}
          </p>
        )}
        {op.rationale && <blockquote style={{ whiteSpace: "pre-wrap" }}>{op.rationale}</blockquote>}
        {op.description && <blockquote style={{ whiteSpace: "pre-wrap" }}>{op.description}</blockquote>}
        {lines(t.criteria, op.acceptanceCriteria)}
        {lines(t.constraints, op.constraints)}
        {lines(t.doNotTouch, op.doNotTouch)}
        {ceiling > 0 && <p>{t.decisions.ceiling(usd(ceiling))}</p>}
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

export const workActionRequests = {
  ...Object.fromEntries(
    ["work_propose_initiative", "work_propose_tasks", "work_propose_task_update", "work_propose_comment"].map((name) => [
      `work.mcp.${name}`,
      workDecisionRenderer,
    ]),
  ),
  ...Object.fromEntries(
    [
      "work.plan.apply",
      "work.tasks.bulk_update",
      "work.handoff",
      "work.handoff_owner",
      "work.coding.dispatch",
      "work.mcp.work_pm_propose_plan",
      "work.mcp.work_pm_propose_report",
      "work.mcp.work_pm_propose_changes",
      "work.mcp.work_pm_propose_coding_run",
    ].map((type) => [type, pmDecisionRenderer]),
  ),
};
