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
import { moduleRolesEnabled } from "../../platform/tenancy/module-roles.ts";

// Helpers shared by the module's services. History rows, audits and domain
// events carry ids, field names and keys only: text changes are recorded
// as {changed: true}, never with the text.

export const MODULE = "work";

/** Who changes work data: a member, the assistant, an MCP client or the system. */
export type WorkActor = Actor & { kind: "user" | "agent" | "system" | "mcp" };
export const userActor = (scope: Scope): WorkActor => ({
  kind: "user",
  id: scope.userId,
});

export const uuid = z.uuid();
/** A calendar date, YYYY-MM-DD. */
export const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "invalid date");
export const toDate = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00Z`);
export const fromDate = (v: Date | null) =>
  v ? v.toISOString().slice(0, 10) : null;
/** Optimistic concurrency: the version the client last read. */
export const expectedVersion = z.int().min(1);

export function assertVersion(row: { version: number }, expected: number) {
  if (row.version !== expected)
    throw new DomainError("WORK_VERSION_CONFLICT", 409);
}

/** One history row of a task, an initiative or a milestone. */
export function workEvent(
  tx: DbTx,
  scope: Scope,
  subject:
    | { taskId: string }
    | { initiativeId: string }
    | { milestoneId: string },
  type: string,
  actor: WorkActor,
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
  createdAt = new Date(),
) {
  return tx.workEvent.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...subject,
      type,
      actorKind: actor.kind,
      actorId: actor.id,
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
      createdAt,
    },
  });
}

/** A content-free domain event of the module (ADR 0016). */
export function workDomainEvent(
  tx: DbTx,
  scope: Scope,
  type: string,
  subject: { type: "work.task" | "work.initiative" | "work.milestone"; id: string },
  actor: WorkActor,
  data: Record<string, unknown> = {},
) {
  return publishEvent(tx, scope, {
    type,
    subject,
    actor,
    origin: MODULE,
    data,
  });
}

/**
 * The project's members with their role in the module: workspace owners
 * count as owners, module roles apply while ORBIT_MODULE_ROLES is on.
 * Members with module role "none" are left out.
 */
export async function workMembers(scope: Scope) {
  const [owners, members] = await Promise.all([
    authDb.workspaceMember.findMany({
      where: { workspaceId: scope.workspaceId, role: "owner" },
    }),
    authDb.projectMember.findMany({
      where: { projectId: scope.projectId },
      ...(moduleRolesEnabled()
        ? { include: { moduleRoles: { where: { moduleId: MODULE } } } }
        : {}),
    }),
  ]);
  const roles = new Map<string, "owner" | "editor" | "viewer">(
    owners.map((o) => [o.userId, "owner"]),
  );
  for (const member of members) {
    if (roles.get(member.userId) === "owner") continue;
    const override = (member as { moduleRoles?: Array<{ role: string }> })
      .moduleRoles?.[0]?.role;
    const role = member.role === "owner" ? "owner" : (override ?? member.role);
    if (role === "owner" || role === "editor" || role === "viewer")
      roles.set(member.userId, role);
  }
  const users = await authDb.user.findMany({
    where: { id: { in: [...roles.keys()] }, banned: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return users.map((u) => ({ userId: u.id, name: u.name, role: roles.get(u.id)! }));
}

/** Members who may own work: owners and editors in the module. */
export async function assignableIds(scope: Scope) {
  return new Set(
    (await workMembers(scope))
      .filter((m) => m.role !== "viewer")
      .map((m) => m.userId),
  );
}

/** The in-app path of a task, for links and notifications. */
export const taskPath = (projectId: string, taskId: string) =>
  `/p/${projectId}/work/tasks?task=${taskId}`;
export const initiativePath = (projectId: string, initiativeId: string) =>
  `/p/${projectId}/work/initiatives?initiative=${initiativeId}`;

/** Maps a constraint error a trigger or check raised to a domain error. */
export function domainFromDb(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of ["WORK_MILESTONE_MISMATCH", "WORK_PARENT_DEPTH"])
    if (message.includes(code)) throw new DomainError(code, 409);
  throw error;
}
