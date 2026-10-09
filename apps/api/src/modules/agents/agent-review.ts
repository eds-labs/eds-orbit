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

/** `LINK_NOT_ALLOWED` when the text itself names a link outside the policy's allowed origins. */
export function bodyLinkProblems(body: unknown, allowedOrigins: string[]) {
  for (const match of String(body ?? "").matchAll(WRITTEN_LINK)) {
    const written = match[0].replace(/[.,;:!?]+$/u, "");
    let origin: string | null;
    try {
      origin = new URL(
        /^https?:\/\//i.test(written) ? written : `https://${written}`,
      ).origin;
    } catch {
      origin = null;
    }
    if (!origin || !allowedOrigins.includes(origin))
      return ["LINK_NOT_ALLOWED"];
  }
  return [];
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

/** The confirmation hash of an active assignment whose confirmation still covers its current content, else null. */
export function confirmedHash(assignment: Record<string, any>) {
  const confirmed = assignment.confirmation?.assignmentHash;
  return assignment.status === "active" &&
    typeof confirmed === "string" &&
    confirmed === assignmentHash(assignment)
    ? confirmed
    : null;
}

/**
 * Whether a recorded agent review stands in for the owner's content review
 * (spec §6, R4, R43). All of these must hold, otherwise the owner review is
 * still required: Orbit Agents is on; the review covers exactly the current
 * text and recorded no deterministic problem; it was made by the review task
 * of the content's own run; the assignment is active, its confirmation still
 * covers its content and is the one the review was made under; the
 * confirmation covers the content's type and channel; the text names no link
 * outside the policy; a Telegram chat is linked to the project. The veto
 * deadline belongs to the publication and is checked at handoff (R4).
 */
export async function agentReviewAccepted(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
) {
  const review = content.agentReview as Partial<AgentReview> | undefined;
  if (!agentsEnabled() || !review || typeof review !== "object") return false;
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
  return (await linkedTelegramConnection(tx, scope)) !== null;
}
