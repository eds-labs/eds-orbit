import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { createLink, moveLinks } from "../../platform/links/links.ts";
import {
  assertVersion,
  expectedVersion,
  ISSUE_TYPE,
  issueDomainEvent,
  issueEvent,
  uuid,
  type IssueActor,
} from "./common.ts";
import { loadIssue, markDuplicate } from "./issues.ts";
import { recount } from "./reports.ts";

// Merging duplicates (ADR 0018 I-3): only a person (or an approved
// proposal) merges two issues; nothing merges them automatically. Nothing
// is lost: reports, attachments, external references and links move to the
// target, delivery records are copied, the Support tickets stay linked (now
// to the target), and the source stays as a `duplicate` that points there.

const mergeInput = z.object({ targetIssueId: uuid, expectedVersion }).strict();

export async function mergeIssue(tx: DbTx, scope: Scope, sourceId: string, raw: unknown, actor: IssueActor) {
  const input = mergeInput.parse(raw);
  const source = await loadIssue(tx, scope, sourceId);
  assertVersion(source, input.expectedVersion);
  const target = await loadIssue(tx, scope, input.targetIssueId);
  if (source.id === target.id) throw new DomainError("ISSUES_MERGE_SELF", 422);
  if (source.status === "duplicate" || target.status === "duplicate")
    throw new DomainError("ISSUES_ISSUE_MERGED", 409);
  const where = { projectId: scope.projectId, issueId: source.id };
  const reports = await tx.issueReport.updateMany({ where, data: { issueId: target.id } });
  // An attachment the target already has stays on the source only.
  const held = new Set(
    (await tx.issueAttachment.findMany({ where: { projectId: scope.projectId, issueId: target.id }, select: { fileId: true } })).map((a) => a.fileId),
  );
  await tx.issueAttachment.updateMany({ where: { ...where, fileId: { notIn: [...held] } }, data: { issueId: target.id } });
  await tx.issueExternalRef.updateMany({ where, data: { issueId: target.id } });
  // Delivery records are append-only: the target gets copies.
  for (const d of await tx.issueDelivery.findMany({ where }))
    await tx.issueDelivery.create({ data: { ...d, id: randomUUID(), issueId: target.id, createdAt: new Date() } });
  // Open candidates of the pair are settled; others of the source go.
  await tx.issueDuplicateCandidate.updateMany({
    where: {
      projectId: scope.projectId,
      status: "pending",
      OR: [
        { issueId: source.id, candidateIssueId: target.id },
        { issueId: target.id, candidateIssueId: source.id },
      ],
    },
    data: { status: "confirmed", decidedBy: actor.id ?? actor.kind, decidedAt: new Date() },
  });
  await tx.issueDuplicateCandidate.deleteMany({
    where: { projectId: scope.projectId, status: "pending", OR: [{ issueId: source.id }, { candidateIssueId: source.id }] },
  });
  const links = await moveLinks(tx, scope, { type: ISSUE_TYPE, id: source.id }, { type: ISSUE_TYPE, id: target.id }, actor);
  const counts = await recount(tx, scope, target.id);
  await tx.issue.update({
    where: { id: target.id },
    data: {
      ...counts,
      firstSeenAt: source.firstSeenAt < target.firstSeenAt ? source.firstSeenAt : target.firstSeenAt,
      lastSeenAt: source.lastSeenAt > target.lastSeenAt ? source.lastSeenAt : target.lastSeenAt,
      version: { increment: 1 },
    },
  });
  await tx.issue.update({ where: { id: source.id }, data: { reportCount: 0, ticketCount: 0 } });
  const merged = await markDuplicate(tx, scope, source, target.id, actor);
  await createLink(
    tx,
    scope,
    { source: { type: ISSUE_TYPE, id: source.id }, target: { type: ISSUE_TYPE, id: target.id }, relation: "duplicates" },
    actor,
  );
  const moved = { reports: reports.count, links };
  await issueEvent(tx, scope, source.id, "merged", actor, {}, { intoIssueId: target.id, ...moved });
  await issueEvent(tx, scope, target.id, "merged", actor, {}, { fromIssueId: source.id, ...moved });
  await audit(tx, scope, "issues.issue.merged", source.id, { targetIssueId: target.id, ...moved });
  await issueDomainEvent(tx, scope, "issues.issue.merged", { type: ISSUE_TYPE, id: source.id }, actor, {
    targetIssueId: target.id,
    ...moved,
  });
  return { source: merged, targetId: target.id, ...moved };
}
