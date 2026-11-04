import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { hiddenModules } from "../tenancy/module-roles.ts";
import { notificationsEnabled } from "../notifications/members.ts";
import { findPersonalSpace } from "../assistant/personal-space.ts";
import { realtimeEnabled } from "../realtime/fanout.ts";
import { readUserProjects } from "./collect.ts";
import { proactiveEnabled } from "./preferences.ts";

// The cross-project inbox (ADR 0023 items 2 and 9, plan §2.4): unread counts
// and the newest notices across every business project the user can still
// reach, plus their personal space's own notices. Read one project per
// transaction with the user's current role there; a project they left
// contributes nothing, and modules hidden from them stay out.

const ITEMS = 20;

type Row = Awaited<ReturnType<DbTx["notification"]["findMany"]>>[number];

async function readNotices(tx: DbTx, where: Record<string, unknown>) {
  const [items, unread] = await Promise.all([
    tx.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: ITEMS }),
    tx.notification.count({ where: { ...where, readAt: null } }),
  ]);
  return { items, unread };
}

const view = (row: Row, project: { id: string; name: string; personal: boolean }) => ({
  id: row.id,
  projectId: project.id,
  projectName: project.name,
  personal: project.personal,
  moduleId: row.moduleId,
  kind: row.kind,
  title: row.title,
  body: row.body,
  link: row.link,
  severity: row.severity,
  occurrences: row.occurrences,
  readAt: row.readAt,
  createdAt: row.createdAt,
  lastOccurredAt: row.lastOccurredAt ?? row.createdAt,
});

export async function notificationSummary(workspaceId: string, userId: string) {
  if (!proactiveEnabled() || !notificationsEnabled()) throw new DomainError("NOT_FOUND", 404);
  const reads = await readUserProjects(
    { workspaceId, userId },
    (tx, member, project) =>
      readNotices(tx, {
        workspaceId,
        projectId: project.id,
        userId,
        moduleId: { notIn: hiddenModules(member) },
      }),
    { userRows: true },
  );
  const projects = reads.map((r) => ({
    projectId: r.projectId,
    projectName: r.projectName,
    personal: false,
    unread: r.value.unread,
  }));
  const items = reads.flatMap((r) =>
    r.value.items.map((row) => view(row, { id: r.projectId, name: r.projectName, personal: false })),
  );
  // The personal space's own notices (budget thresholds of the assistant,
  // briefing failures), read in its own transaction.
  const space = await findPersonalSpace(workspaceId, userId);
  if (space) {
    const own = await scoped(workspaceId, space.id, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true)`;
      return readNotices(tx, { workspaceId, projectId: space.id, userId });
    });
    projects.push({ projectId: space.id, projectName: "", personal: true, unread: own.unread });
    items.push(...own.items.map((row) => view(row, { id: space.id, name: "", personal: true })));
  }
  items.sort((a, b) => b.lastOccurredAt.getTime() - a.lastOccurredAt.getTime());
  return {
    unread: projects.reduce((n, p) => n + p.unread, 0),
    projects: projects.filter((p) => p.unread > 0),
    items: items.slice(0, ITEMS),
    personalSpaceId: space?.id ?? null,
    // Whether the client may wait on the stream instead of polling.
    realtime: Boolean(space) && realtimeEnabled(),
  };
}
