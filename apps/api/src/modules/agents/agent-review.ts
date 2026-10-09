import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, hash } from "../../shared.ts";
import { activePolicy } from "../policy.ts";
import { linkedTelegramConnection } from "../telegram.ts";
import { agentsEnabled, assignmentHash } from "./assignments.ts";

/**
 * Agent review authority (Orbit Agents, spec §6). The review agent's
 * approval of one exact text inside a confirmed assignment, recorded on the
 * content by the review step.
 */
export type AgentReview = {
  taskId: string;
  assignmentId: string;
  // For the audit trail; preflight binds the review by the confirmation hash (R43).
  assignmentVersion: number;
  assignmentHash: string;
  bodyHash: string;
  checkedAt: string;
  deterministicProblems: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Written links in a text: with a scheme, or starting with `www.`.
const WRITTEN_LINK = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/giu;
// Host-shaped words (`label.label.tld`, TLD of 2-24 letters), optionally with a path.
const BARE_HOST =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?:\/[^\s<>"')\]]*)?/giu;

const originOf = (written: string) => {
  try {
    return new URL(
      /^https?:\/\//i.test(written) ? written : `https://${written}`,
    ).origin;
  } catch {
    return null;
  }
};
const trimmed = (written: string) => written.replace(/[.,;:!?]+$/u, "");

/**
 * Links written in a text outside the policy's allowed origins:
 * `LINK_NOT_ALLOWED` for an explicit link (scheme or `www.`), which blocks;
 * `LINK_UNVERIFIED` for a bare host such as `site.example/page`, which may
 * also be a name like "Node.js" and is therefore left to the owner (R49).
 */
export function bodyLinkProblems(body: unknown, allowedOrigins: string[]) {
  const problems: string[] = [];
  let rest = String(body ?? "");
  for (const match of rest.matchAll(WRITTEN_LINK)) {
    const origin = originOf(trimmed(match[0]));
    if (!origin || !allowedOrigins.includes(origin)) {
      problems.push("LINK_NOT_ALLOWED");
      break;
    }
  }
  // Explicit links are judged above; only the remaining text is searched for hosts.
  rest = rest.replace(WRITTEN_LINK, " ");
  for (const match of rest.matchAll(BARE_HOST)) {
    const origin = originOf(trimmed(match[0]));
    if (!origin || !allowedOrigins.includes(origin)) {
      problems.push("LINK_UNVERIFIED");
      break;
    }
  }
  return problems;
}

/**
 * Whether the review agent may approve in place of the owner at all
 * (`ORBIT_AGENT_REVIEW_AUTHORITY`, default off, R70). It is turned on only
 * after the review eval set passed (spec §6, Approval J); while it is off,
 * assignment posts wait for the owner even with a linked bot.
 */
export function agentReviewAuthority() {
  return loadConfig().ORBIT_AGENT_REVIEW_AUTHORITY === "true";
}

/** The assignment's confirmation covers this content type and channel. */
export function withinConfirmation(
  assignment: Record<string, any>,
  content: Record<string, any>,
) {
  return (
    assignment.contentType === content.type &&
    ((assignment.channels ?? []) as string[]).includes(content.channel)
  );
}

/**
 * The confirmation hash of an active assignment whose confirmation still
 * covers its current content, else null. A one-off assignment that ended
 * because its run was over (`completedAt`, M2) keeps its confirmation for
 * the posts of that run; one the owner ended does not.
 */
export function confirmedHash(assignment: Record<string, any>) {
  const confirmed = assignment.confirmation?.assignmentHash;
  const standing =
    assignment.status === "active" ||
    (assignment.status === "ended" &&
      typeof assignment.completedAt === "string");
  return standing &&
    typeof confirmed === "string" &&
    confirmed === assignmentHash(assignment)
    ? confirmed
    : null;
}

/**
 * Whether a recorded agent review stands in for the owner's content review
 * (spec §6, R4, R43). All of these must hold, otherwise the owner review is
 * still required: Orbit Agents is on; agent review authority is on
 * (`ORBIT_AGENT_REVIEW_AUTHORITY`, R70); the review covers exactly the current
 * text and recorded no deterministic problem; it was made by the review task
 * of the content's own run; the assignment is active, its confirmation still
 * covers its content and is the one the review was made under; the
 * confirmation covers the content's type and channel; the text names no link
 * outside the policy; a Telegram chat was linked to the project before the
 * review was made. The veto
 * deadline belongs to the publication and is checked at handoff (R4).
 */
export async function agentReviewAccepted(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
) {
  const review = content.agentReview as Partial<AgentReview> | undefined;
  // Content without an agent review (the owner path) never loads the configuration.
  if (
    !review ||
    typeof review !== "object" ||
    !agentsEnabled() ||
    !agentReviewAuthority()
  )
    return false;
  if (review.bodyHash !== hash(content.body)) return false;
  if (
    !Array.isArray(review.deterministicProblems) ||
    review.deterministicProblems.length
  )
    return false;
  if (
    !content.assignmentId ||
    review.assignmentId !== content.assignmentId ||
    !UUID.test(String(content.assignmentId)) ||
    !UUID.test(String(review.taskId))
  )
    return false;
  const find = (kind: string, id: string) =>
    tx.entity.findFirst({
      where: {
        id,
        kind,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
    });
  const task = await find("agent_tasks", String(review.taskId));
  if (
    !task ||
    data(task).role !== "review" ||
    data(task).assignmentId !== content.assignmentId ||
    data(task).runId !== content.assignmentRunId
  )
    return false;
  const assignment = await find("assignments", content.assignmentId);
  if (!assignment) return false;
  const confirmed = confirmedHash(data(assignment));
  if (!confirmed || review.assignmentHash !== confirmed) return false;
  if (!withinConfirmation(data(assignment), content)) return false;
  const policy = await activePolicy(tx, scope);
  if (
    !policy ||
    bodyLinkProblems(content.body, data(policy).allowedOrigins ?? []).length
  )
    return false;
  // The chat must have been linked before the review was made (R50).
  const connection = await linkedTelegramConnection(tx, scope);
  const linkedAt = Date.parse(
    connection ? (data(connection).linkedAt ?? "") : "",
  );
  const checkedAt = Date.parse(String(review.checkedAt ?? ""));
  return (
    Number.isFinite(linkedAt) &&
    Number.isFinite(checkedAt) &&
    checkedAt >= linkedAt
  );
}
