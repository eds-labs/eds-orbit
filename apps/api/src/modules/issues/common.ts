import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  Prisma,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Actor } from "../../../../../packages/module-contracts/src/index.ts";
import { DomainError } from "../../shared.ts";
import { publishEvent } from "../../platform/events/events.ts";
import type { DomainEventView } from "../../platform/events/types.ts";
import { moduleRolesEnabled } from "../../platform/tenancy/module-roles.ts";

// Helpers shared by the issue center's services. History rows, audits and
// domain events carry ids, field names and keys only: text changes are
// recorded as {changed: true}, never with the text (ADR 0018 I-5).

export const MODULE = "issues";
export const ISSUE_TYPE = "issues.issue";

export const ISSUE_TYPES = ["bug", "feature_request", "improvement", "technical_problem"] as const;
export const SEVERITIES = ["s1_critical", "s2_major", "s3_minor", "s4_trivial"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];

/**
 * Who changes issue data: a member, the assistant, an MCP client, an
 * integration or the system. `origin` names the writer in domain events
 * when it is not the module itself, e.g. `issues.sync` for the sync rules
 * (I-4), so they can ignore their own writes.
 */
export type IssueActor = Actor & {
  kind: "user" | "agent" | "system" | "mcp" | "integration";
  origin?: `issues.${string}`;
};
export const userActor = (scope: Scope): IssueActor => ({ kind: "user", id: scope.userId });
/** The sync rules' writes (ADR 0018 I-4). */
export const SYNC_ORIGIN = "issues.sync";
export const syncActor: IssueActor = { kind: "system", id: null, origin: SYNC_ORIGIN };

export const uuid = z.uuid();
/** Optimistic concurrency: the version the client last read. */
export const expectedVersion = z.int().min(1);
export const componentKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);

export function assertVersion(row: { version: number }, expected: number) {
  if (row.version !== expected) throw new DomainError("ISSUES_VERSION_CONFLICT", 409);
}

/** One history row of an issue. */
export function issueEvent(
  tx: DbTx,
  scope: Scope,
  issueId: string,
  type: string,
  actor: IssueActor,
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
  createdAt = new Date(),
) {
  return tx.issueEvent.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      issueId,
      type,
      actorKind: actor.kind,
      actorId: actor.id,
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
      createdAt,
    },
  });
}

/** A content-free domain event of the module (ADR 0018). */
export function issueDomainEvent(
  tx: DbTx,
  scope: Scope,
  type: string,
  subject: { type: "issues.issue" | "issues.report" | "issues.delivery"; id: string },
  actor: IssueActor,
  data: Record<string, unknown> = {},
  cause?: DomainEventView | null,
) {
  return publishEvent(tx, scope, {
    type,
    subject,
    actor: { kind: actor.kind, id: actor.id },
    origin: actor.origin ?? MODULE,
    data,
    cause,
  });
}

/** The in-app path of an issue, for links, notifications and attention. */
export const issuePath = (projectId: string, issueId: string) =>
  `/p/${projectId}/issues/list?issue=${issueId}`;
export const issueKey = (number: number) => `ISS-${number}`;

/**
 * The project's members with their role in the module: workspace owners
 * count as owners, module roles apply while ORBIT_MODULE_ROLES is on.
 * Members with module role "none" are left out.
 */
export async function issuesMembers(scope: Scope) {
  const [owners, members] = await Promise.all([
    authDb.workspaceMember.findMany({ where: { workspaceId: scope.workspaceId, role: "owner" } }),
    authDb.projectMember.findMany({
      where: { projectId: scope.projectId },
      ...(moduleRolesEnabled() ? { include: { moduleRoles: { where: { moduleId: MODULE } } } } : {}),
    }),
  ]);
  const roles = new Map<string, "owner" | "editor" | "viewer">(owners.map((o) => [o.userId, "owner"]));
  for (const member of members) {
    if (roles.get(member.userId) === "owner") continue;
    const override = (member as { moduleRoles?: Array<{ role: string }> }).moduleRoles?.[0]?.role;
    const role = member.role === "owner" ? "owner" : (override ?? member.role);
    if (role === "owner" || role === "editor" || role === "viewer") roles.set(member.userId, role);
  }
  const users = await authDb.user.findMany({
    where: { id: { in: [...roles.keys()] }, banned: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return users.map((u) => ({ userId: u.id, name: u.name, role: roles.get(u.id)! }));
}

/** Members who may own an issue's triage: owners and editors in the module. */
export async function triagerIds(scope: Scope) {
  return new Set((await issuesMembers(scope)).filter((m) => m.role !== "viewer").map((m) => m.userId));
}
