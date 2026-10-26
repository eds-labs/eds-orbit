import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { DomainEventView, EventSubscription } from "../../platform/events/types.ts";
import { activeLinks } from "../../platform/links/links.ts";
import { registeredLinkType } from "../../platform/modules/contributions.ts";
import { ISSUE_TYPE, SYNC_ORIGIN, syncActor } from "./common.ts";
import { issuesActive } from "./gate.ts";
import { autoMoveIssue } from "./issues.ts";
import { readIssuesSettings } from "./settings.ts";
import type { IssueStatus } from "./status.ts";

// Loop-free synchronization (ADR 0018 I-4, plan §2.6). Tasks move issues
// forward (S1, S2, S7), delivery records move them to fix ready or
// released (S3, S4), a release reaches Support as a note (S5, Support's
// subscriber) and a closed issue with open tasks becomes an attention item
// (S6). Authority runs one way: no rule writes the object type of its own
// trigger, automatic moves only go forward, writes carry the origin
// `issues.sync` and the platform stops chains deeper than five.

const TASK_TYPE = "work.task";

/** The rule table; a test checks that no rule writes its own trigger's type. */
export const SYNC_RULES = [
  { id: "S1", trigger: "work.task.status_changed", writes: "issues.issue", effect: "a task in progress: issue in progress" },
  { id: "S2", trigger: "work.task.status_changed", writes: "issues.issue", effect: "all tasks done (one at least): issue fix ready" },
  { id: "S3", trigger: "issues.delivery.recorded", writes: "issues.issue", effect: "merged, no open task: issue fix ready" },
  { id: "S4", trigger: "issues.delivery.recorded", writes: "issues.issue", effect: "deployed to production while fix ready: released" },
  { id: "S5", trigger: "issues.issue.released", writes: "support.ticket", effect: "internal note and attention (Support)" },
  { id: "S6", trigger: "issues.issue.status_changed", writes: "attention", effect: "closed issue with open tasks: attention item" },
  { id: "S7", trigger: "work.task.status_changed", writes: "issues.issue", effect: "a done task reopened: fix ready back to in progress" },
  { id: "L1", trigger: "platform.link.created", writes: "issues.issue", effect: "a task linked: re-evaluate (planned)" },
  { id: "L2", trigger: "platform.link.removed", writes: "issues.issue", effect: "a task unlinked: re-evaluate" },
] as const;

const OPEN_TASK = new Set(["backlog", "todo", "in_progress", "blocked", "in_review"]);
const ACTIVE_TASK = new Set(["in_progress", "blocked", "in_review"]);

/** The issues a task implements (active `implements` links). */
async function implementedBy(tx: DbTx, scope: Scope, taskId: string) {
  return (await activeLinks(tx, scope, { type: TASK_TYPE, id: taskId }))
    .filter((l) => l.relation === "implements" && l.sourceType === TASK_TYPE && l.sourceId === taskId && l.targetType === ISSUE_TYPE)
    .map((l) => l.targetId);
}

/** The status categories of an issue's implementing tasks, through the work module's link type. */
export async function implementingTasks(tx: DbTx, scope: Scope, issueId: string) {
  const ids = (await activeLinks(tx, scope, { type: ISSUE_TYPE, id: issueId }))
    .filter((l) => l.relation === "implements" && l.sourceType === TASK_TYPE && l.targetId === issueId)
    .map((l) => l.sourceId);
  const def = registeredLinkType(TASK_TYPE);
  if (!ids.length || !def) return [];
  const found = await def.resolve(tx, scope, ids);
  return ids.flatMap((id) => {
    const task = found.get(id);
    return task?.statusCategory ? [{ id, statusCategory: task.statusCategory }] : [];
  });
}

/**
 * Where the implementing tasks put the issue: fix ready when all are
 * finished and one at least is done (S2, while autoFixReady is on), in
 * progress when one is being worked on (S1), planned otherwise. Moves
 * forward only; an issue before `confirmed` waits for a person.
 */
export async function evaluateIssue(tx: DbTx, scope: Scope, issueId: string, cause: DomainEventView | null) {
  const tasks = await implementingTasks(tx, scope, issueId);
  if (!tasks.length) return false;
  const { settings } = await readIssuesSettings(tx, scope);
  const open = tasks.filter((t) => OPEN_TASK.has(t.statusCategory));
  const done = tasks.filter((t) => t.statusCategory === "done");
  let target: IssueStatus = "planned";
  if (!open.length && done.length && settings.sync.autoFixReady) target = "fix_ready";
  else if (tasks.some((t) => ACTIVE_TASK.has(t.statusCategory)) || (!open.length && done.length)) target = "in_progress";
  return autoMoveIssue(tx, scope, issueId, target, syncActor, { cause, reason: "tasks" });
}

/** S3 and S4: what a recorded delivery means for its issue. */
async function onDelivery(tx: DbTx, scope: Scope, event: DomainEventView) {
  const issueId = String(event.data.issueId ?? "");
  const issue = await tx.issue.findFirst({ where: { projectId: scope.projectId, id: issueId } });
  if (!issue) return;
  if (event.data.kind === "pr_merged") {
    // Merged is not released; open tasks still decide (S3).
    const tasks = await implementingTasks(tx, scope, issueId);
    if (tasks.some((t) => OPEN_TASK.has(t.statusCategory))) return;
    await autoMoveIssue(tx, scope, issueId, "fix_ready", syncActor, { cause: event, reason: "merged" });
    return;
  }
  // A production deployment releases a fix that is ready (S4).
  if (event.data.kind === "deployed" && event.data.production === true && issue.status === "fix_ready")
    await autoMoveIssue(tx, scope, issueId, "released", syncActor, { cause: event, reason: "deployed" });
}

export const syncSubscriber: EventSubscription = {
  name: SYNC_ORIGIN,
  types: ["work.task.status_changed", "platform.link.created", "platform.link.removed", "issues.delivery.recorded"],
  async handler(tx, scope, event) {
    if (!(await issuesActive(tx, scope))) return;
    // Its own writes never trigger it again (I-4 rule 2).
    if (event.origin === SYNC_ORIGIN) return;
    if (event.type === "issues.delivery.recorded") return onDelivery(tx, scope, event);
    if (event.type === "work.task.status_changed") {
      const reopened = event.data.fromCategory === "done" && OPEN_TASK.has(String(event.data.toCategory));
      for (const issueId of await implementedBy(tx, scope, event.subject.id)) {
        // S7: a done task reopened takes a fix-ready issue back.
        if (reopened) await autoMoveIssue(tx, scope, issueId, "in_progress", syncActor, { cause: event, reopen: true, reason: "task_reopened" });
        await evaluateIssue(tx, scope, issueId, event);
      }
      return;
    }
    // A task linked to or unlinked from an issue.
    const d = event.data;
    if (d.relation === "implements" && d.sourceType === TASK_TYPE && d.targetType === ISSUE_TYPE)
      await evaluateIssue(tx, scope, String(d.targetId), event);
  },
};
