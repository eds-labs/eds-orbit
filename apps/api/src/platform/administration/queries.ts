import { z } from "zod";
import { authDb, Prisma } from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import {
  moduleAvailable,
  registeredRegistry,
} from "../modules/contributions.ts";

// Read side of the system administration (ADR 0013). Metadata only: users,
// organizations, projects, memberships and invitations from the control
// plane. No project content is read here, and this file never opens a
// project-scoped business transaction (administration-boundary test).

const PAGE = 50;
const cursorInput = z.uuid().optional();
const text = z.string().trim().max(200).optional();

/** One page: `items` plus the cursor of the next page, if any. */
function page<T extends { id: string }>(rows: T[], limit = PAGE) {
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

const userSummary = {
  id: true,
  name: true,
  email: true,
  role: true,
  banned: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export async function overview() {
  const day = new Date(Date.now() - 24 * 3600 * 1000);
  const now = new Date();
  const [
    users,
    deactivated,
    admins,
    organizations,
    projects,
    pausedProjects,
    openInvitations,
    activeSessions,
    recentSignIns,
  ] = await Promise.all([
    authDb.user.count(),
    authDb.user.count({ where: { banned: true } }),
    authDb.user.count({ where: { role: "admin", banned: false } }),
    authDb.workspace.count(),
    authDb.project.count(),
    authDb.project.count({ where: { paused: true } }),
    authDb.invitation.count({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    }),
    authDb.session.count({ where: { expiresAt: { gt: now } } }),
    authDb.session.count({ where: { createdAt: { gt: day } } }),
  ]);
  return {
    users: { total: users, active: users - deactivated, deactivated, admins },
    organizations,
    projects: { total: projects, paused: pausedProjects },
    openInvitations,
    sessions: { active: activeSessions, createdLast24h: recentSignIns },
  };
}

export const userListInput = z
  .object({
    query: text,
    status: z.enum(["active", "deactivated"]).optional(),
    role: z.enum(["user", "admin"]).optional(),
    workspaceId: z.uuid().optional(),
    cursor: cursorInput,
  })
  .strict();

export async function listUsers(raw: unknown) {
  const input = userListInput.parse(raw ?? {});
  const where: Prisma.UserWhereInput = {
    ...(input.query
      ? {
          OR: [
            { name: { contains: input.query, mode: "insensitive" } },
            { email: { contains: input.query, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(input.status ? { banned: input.status === "deactivated" } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.workspaceId
      ? { memberships: { some: { workspaceId: input.workspaceId } } }
      : {}),
  };
  const rows = await authDb.user.findMany({
    where,
    select: {
      ...userSummary,
      _count: { select: { memberships: true, projectMemberships: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  return page(
    rows.map(({ _count, ...user }) => ({
      ...user,
      organizations: _count.memberships,
      projects: _count.projectMemberships,
    })),
  );
}

/** A user's profile metadata, memberships and module roles. */
export async function userDetail(userId: string) {
  const user = await authDb.user.findUnique({
    where: { id: z.string().max(100).parse(userId) },
    select: {
      ...userSummary,
      emailVerified: true,
      locale: true,
      updatedAt: true,
      memberships: {
        select: {
          role: true,
          workspace: { select: { id: true, name: true } },
        },
      },
      projectMemberships: {
        select: {
          role: true,
          workspaceId: true,
          project: { select: { id: true, name: true, paused: true } },
          moduleRoles: { select: { moduleId: true, role: true } },
        },
      },
    },
  });
  if (!user) throw new DomainError("USER_NOT_FOUND", 404);
  const now = new Date();
  const [sessions, lastSession, invitations] = await Promise.all([
    authDb.session.count({ where: { userId: user.id, expiresAt: { gt: now } } }),
    authDb.session.findFirst({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    authDb.invitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        expiresAt: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
  ]);
  const { memberships, projectMemberships, ...profile } = user;
  return {
    user: profile,
    activeSessions: sessions,
    lastActiveAt: lastSession?.updatedAt ?? null,
    organizations: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role === "owner" ? "owner" : "member",
    })),
    projects: projectMemberships.map((m) => ({
      id: m.project.id,
      name: m.project.name,
      paused: m.project.paused,
      workspaceId: m.workspaceId,
      role: m.role,
      moduleRoles: Object.fromEntries(
        m.moduleRoles.map((r) => [r.moduleId, r.role]),
      ),
    })),
    openInvitations: invitations.map((i) => ({
      id: i.id,
      expiresAt: i.expiresAt,
      organization: i.workspace,
    })),
  };
}

export const organizationListInput = z
  .object({ query: text, cursor: cursorInput })
  .strict();

export async function listOrganizations(raw: unknown) {
  const input = organizationListInput.parse(raw ?? {});
  const rows = await authDb.workspace.findMany({
    where: input.query
      ? { name: { contains: input.query, mode: "insensitive" } }
      : {},
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { members: true, projects: true } },
      members: { where: { role: "owner" }, select: { userId: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  return page(
    rows.map(({ _count, members, ...w }) => ({
      ...w,
      members: _count.members,
      owners: members.length,
      projects: _count.projects,
    })),
  );
}

/** An organization's members, projects and open invitations. */
export async function organizationDetail(workspaceId: string) {
  const workspace = await authDb.workspace.findUnique({
    where: { id: z.uuid().parse(workspaceId) },
    select: {
      id: true,
      name: true,
      createdAt: true,
      members: {
        select: {
          role: true,
          user: { select: { id: true, name: true, email: true, banned: true } },
        },
      },
      projects: {
        select: {
          id: true,
          name: true,
          paused: true,
          createdAt: true,
          members: {
            select: {
              userId: true,
              role: true,
              moduleRoles: { select: { moduleId: true, role: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!workspace) throw new DomainError("NOT_FOUND", 404);
  const invitations = await openInvitations(workspace.id);
  return {
    organization: {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
    },
    members: workspace.members
      .map((m) => ({
        ...m.user,
        role: m.role === "owner" ? "owner" : "member",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: workspace.projects.map((p) => ({
      id: p.id,
      name: p.name,
      paused: p.paused,
      createdAt: p.createdAt,
      members: p.members.map((m) => ({
        userId: m.userId,
        role: m.role,
        moduleRoles: Object.fromEntries(
          m.moduleRoles.map((r) => [r.moduleId, r.role]),
        ),
      })),
    })),
    invitations,
    // What module roles can name in this installation.
    modules: assignableModules(),
  };
}

/** The installation's available modules, for module-role choices. */
export function assignableModules() {
  const registry = registeredRegistry();
  return registry.order.filter(moduleAvailable).map((id) => ({
    id,
    name: registry.modules.find((m) => m.id === id)!.displayName,
  }));
}

/** Open (not accepted, not revoked) invitations, expired ones included. */
export async function openInvitations(workspaceId?: string) {
  const rows = await authDb.invitation.findMany({
    where: {
      acceptedAt: null,
      revokedAt: null,
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: {
      id: true,
      email: true,
      workspaceRole: true,
      invitedBy: true,
      expiresAt: true,
      createdAt: true,
      workspace: { select: { id: true, name: true } },
      projects: {
        select: {
          role: true,
          moduleRoles: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.workspaceRole === "owner" ? "owner" : "member",
    invitedBy: r.invitedBy,
    expiresAt: r.expiresAt,
    expired: r.expiresAt <= now,
    createdAt: r.createdAt,
    organization: r.workspace,
    projects: r.projects.map((p) => ({
      id: p.project.id,
      name: p.project.name,
      role: p.role,
      moduleRoles: p.moduleRoles,
    })),
  }));
}

export const projectListInput = z
  .object({
    query: text,
    workspaceId: z.uuid().optional(),
    paused: z.enum(["true", "false"]).optional(),
    cursor: cursorInput,
  })
  .strict();

export async function listProjects(raw: unknown) {
  const input = projectListInput.parse(raw ?? {});
  const rows = await authDb.project.findMany({
    where: {
      ...(input.query
        ? { name: { contains: input.query, mode: "insensitive" } }
        : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.paused ? { paused: input.paused === "true" } : {}),
    },
    select: {
      id: true,
      name: true,
      paused: true,
      mode: true,
      language: true,
      timezone: true,
      createdAt: true,
      workspace: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  return page(
    rows.map(({ _count, ...p }) => ({ ...p, members: _count.members })),
  );
}

export const auditListInput = z
  .object({
    action: z.string().max(100).optional(),
    actorId: z.string().max(100).optional(),
    targetId: z.string().max(100).optional(),
    workspaceId: z.uuid().optional(),
    cursor: cursorInput,
  })
  .strict();

export async function listSystemAudit(raw: unknown) {
  const input = auditListInput.parse(raw ?? {});
  const rows = await authDb.systemAuditEvent.findMany({
    where: {
      ...(input.action ? { action: input.action } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  // Actor and target names for display; ids remain the record.
  const ids = [
    ...new Set(rows.flatMap((r) => [r.actorId, r.targetId])),
  ].filter((id) => !id.startsWith("system:"));
  const names = new Map(
    (
      await authDb.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );
  return page(
    rows.map((r) => ({
      ...r,
      actorName: names.get(r.actorId) ?? null,
      targetName: names.get(r.targetId) ?? null,
    })),
  );
}
