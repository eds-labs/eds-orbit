import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { handOff } from "../../platform/handoffs/handoffs.ts";
import { DomainError } from "../../shared.ts";
import { ISSUE_TYPE, issueKey, uuid, type IssueActor } from "./common.ts";
import { loadIssue } from "./issues.ts";
import { TRIAGE_STATUSES, CLOSED_STATUSES } from "./status.ts";

// A development task from an issue (plan §2.6): the work module's
// `work.task_from_issue` target creates it from the issue's redacted,
// curated fields, never from report or customer text, and links it with
// `implements`; the sync rules then move the issue to planned. Needs the
// work module and work.write as well.

const input = z
  .object({
    initiativeId: uuid.optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  })
  .strict();

export async function createTaskFromIssue(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const options = input.parse(raw ?? {});
  const issue = await loadIssue(tx, scope, id);
  if (TRIAGE_STATUSES.includes(issue.status as never)) throw new DomainError("ISSUES_NOT_CONFIRMED", 409);
  if (CLOSED_STATUSES.includes(issue.status as never)) throw new DomainError("ISSUES_ISSUE_CLOSED", 409);
  const criteria = issue.acceptanceCriteria.length
    ? `\n\nAcceptance criteria:\n${issue.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    : "";
  const { target } = await handOff(
    tx,
    scope,
    "work.task_from_issue",
    { type: ISSUE_TYPE, id: issue.id },
    {
      title: `${issueKey(issue.number)}: ${issue.title}`.slice(0, 300),
      description: `${issue.summary ?? ""}${criteria}`.trim().slice(0, 20_000) || undefined,
      ...options,
    },
    actor,
  );
  return { taskId: target.id, issueId: issue.id };
}
