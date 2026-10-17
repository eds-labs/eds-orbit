import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { userScoped } from "../tenancy/scope.ts";
import { projectMembership } from "../tenancy/member-scope.ts";
import { effectiveRole, hiddenModules } from "../tenancy/module-roles.ts";
import {
  registeredUserNotification,
  registeredUserNotifications,
} from "../modules/contributions.ts";
import { emailEnabled } from "../email/connection.ts";
import { queueEmail } from "../email/send.ts";

/**
 * Member notifications (WP4.7, plan 06 S-R8). A module registers its kinds
 * (`userNotifications`); `notifyMembers` writes an in-app notice for each
 * member who keeps that kind on, and queues an e-mail for those who chose
 * it. Notices are private to their member (row-level security with
 * app.user_id), and a member without access to the module gets none.
 *
 * Off unless ORBIT_NOTIFICATIONS is "true"; e-mail also needs ORBIT_EMAIL.
 */

/** A kind a module sends, with its label and e-mail default. */
export type UserNotificationKind = {
  label: { en: string; de: string };
  /** In-app is always on by default; e-mail only when this says so. */
  emailDefault: boolean;
};

/** A same-origin path; the database and the bell check the same rule. */
export const ORBIT_PATH = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

export function notificationsEnabled() {
  return loadConfig().ORBIT_NOTIFICATIONS === "true";
}

const notice = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
    userIds: z.array(z.string().min(1).max(200)).min(1).max(200),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(2000).default(""),
    /**
     * An Orbit path, such as /projects/<id>/tasks. No backslash, space or
     * control character: browsers read "/\\x" and "/<tab>/x" as "//x".
     */
    link: z.string().max(500).regex(ORBIT_PATH).optional(),
  })
  .strict();

/** Runs `work` with app.user_id set to `userId`, then restores it. */
async function asMember<T>(
  tx: DbTx,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  const [previous] = await tx.$queryRaw<{ v: string | null }[]>`
    SELECT current_setting('app.user_id', true) AS v`;
  await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true)`;
  try {
    return await work();
  } finally {
    await tx.$executeRaw`SELECT set_config('app.user_id',${previous?.v ?? ""},true)`;
  }
}

/**
 * Notifies members of the project in the caller's transaction. Members
 * without access to the module, non-members and muted kinds are skipped.
 * Returns how many notices and e-mails were created.
 */
export async function notifyMembers(tx: DbTx, scope: Scope, raw: unknown) {
  if (!notificationsEnabled()) return { inApp: 0, email: 0 };
  const input = notice.parse(raw);
  const kind = registeredUserNotification(input.kind);
  if (!kind) throw new Error(`NOTIFICATION_KIND_UNKNOWN: ${input.kind}`);
  let inApp = 0;
  let email = 0;
  for (const userId of [...new Set(input.userIds)]) {
    const membership = await projectMembership(scope.projectId, userId);
    if (!membership?.role) continue;
    const member: Scope = {
      workspaceId: membership.workspaceId,
      projectId: scope.projectId,
      userId,
      role: membership.role,
      ...(membership.moduleRoles
        ? { moduleRoles: membership.moduleRoles }
        : {}),
    };
    if (effectiveRole(member, kind.owner) === "none") continue;
    const choice = await asMember(tx, userId, async () => {
      const preference = await tx.notificationPreference.findUnique({
        where: {
          projectId_userId_kind: {
            projectId: scope.projectId,
            userId,
            kind: input.kind,
          },
        },
      });
      const wants = {
        inApp: preference?.inApp ?? true,
        email: preference?.email ?? kind.emailDefault,
      };
      if (wants.inApp)
        await tx.notification.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            userId,
            moduleId: kind.owner,
            kind: input.kind,
            title: input.title,
            body: input.body,
            link: input.link ?? null,
          },
        });
      return wants;
    });
    if (choice.inApp) inApp++;
    if (choice.email && emailEnabled()) {
      const user = await authDb.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!user) continue;
      const origin = loadConfig().APP_ORIGIN.replace(/\/+$/, "");
      await queueEmail(tx, scope, {
        to: [user.email],
        // A title may come from user input with line breaks; a subject is
        // one line (queueEmail refuses anything else).
        subject: input.title.replace(/\s+/g, " "),
        text: [
          input.body || input.title,
          input.link ? `${origin}${input.link}` : "",
          "--",
          `Orbit notification (${kind.label.en}). Change what you receive in Orbit under Notifications.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        moduleId: kind.owner === "platform" ? "platform" : kind.owner,
        automatic: true,
      });
      email++;
    }
  }
  return { inApp, email };
}

const LIST_LIMIT = 50;

/**
 * The member's latest notices and the unread count, without those of
 * modules the member no longer has access to (WP4.5).
 */
export async function myNotifications(scope: Scope) {
  if (!notificationsEnabled()) throw new DomainError("NOT_FOUND", 404);
  return userScoped(scope, async (tx) => {
    const where = {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      userId: scope.userId,
      moduleId: { notIn: hiddenModules(scope) },
    };
    const [items, unread] = await Promise.all([
      tx.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: LIST_LIMIT,
      }),
      tx.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return {
      unread,
      items: items.map((n) => ({
        id: n.id,
        moduleId: n.moduleId,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    };
  });
}

/** Marks one notice (or all, with null) as read; only the member's own. */
export async function markRead(scope: Scope, id: string | null) {
  if (!notificationsEnabled()) throw new DomainError("NOT_FOUND", 404);
  return userScoped(scope, async (tx) => {
    const result = await tx.notification.updateMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: scope.userId,
        readAt: null,
        ...(id ? { id } : {}),
      },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  });
}

/** Every registered kind with the member's choice (or its default). */
export async function myPreferences(scope: Scope) {
  if (!notificationsEnabled()) throw new DomainError("NOT_FOUND", 404);
  return userScoped(scope, async (tx) => {
    const stored = await tx.notificationPreference.findMany({
      where: { projectId: scope.projectId, userId: scope.userId },
    });
    return {
      email: emailEnabled(),
      kinds: registeredUserNotifications()
        .filter((k) => effectiveRole(scope, k.owner) !== "none")
        .map((k) => {
          const mine = stored.find((p) => p.kind === k.kind);
          return {
            kind: k.kind,
            moduleId: k.owner,
            label: k.label,
            inApp: mine?.inApp ?? true,
            email: mine?.email ?? k.emailDefault,
          };
        }),
    };
  });
}

const preferenceInput = z
  .object({
    kinds: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
        z.object({ inApp: z.boolean(), email: z.boolean() }).strict(),
      )
      .refine((v) => Object.keys(v).length <= 200),
  })
  .strict();

/** Saves the member's choices for registered kinds only. */
export async function setMyPreferences(scope: Scope, raw: unknown) {
  if (!notificationsEnabled()) throw new DomainError("NOT_FOUND", 404);
  const input = preferenceInput.parse(raw);
  for (const kind of Object.keys(input.kinds))
    if (!registeredUserNotification(kind))
      throw new DomainError("NOTIFICATION_KIND_UNKNOWN", 400);
  await userScoped(scope, async (tx) => {
    for (const [kind, choice] of Object.entries(input.kinds))
      await tx.notificationPreference.upsert({
        where: {
          projectId_userId_kind: {
            projectId: scope.projectId,
            userId: scope.userId,
            kind,
          },
        },
        create: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          userId: scope.userId,
          kind,
          ...choice,
        },
        update: choice,
      });
  });
  return myPreferences(scope);
}
