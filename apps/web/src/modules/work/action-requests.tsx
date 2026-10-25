"use client";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";

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

export const workActionRequests = Object.fromEntries(
  ["work_propose_initiative", "work_propose_tasks", "work_propose_task_update", "work_propose_comment"].map((name) => [
    `work.mcp.${name}`,
    workDecisionRenderer,
  ]),
);
