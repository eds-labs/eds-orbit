import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { LinkTypeDef } from "../../platform/links/types.ts";
import { initiativePath, taskPath } from "./common.ts";
import { WORK_READ } from "./permissions.ts";

// The module's objects as link targets (ADR 0016): tasks, initiatives and
// milestones resolve with their title and status, archived ones included.

const words = (q: string) => q.trim().slice(0, 100);

const task: LinkTypeDef = {
  label: { en: "Task", de: "Aufgabe" },
  linkPermission: WORK_READ,
  async resolve(tx: DbTx, scope: Scope, ids) {
    const rows = await tx.workTask.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, number: true, title: true, status: true, statusCategory: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: `#${r.number} ${r.title}`,
          status: r.status,
          statusCategory: r.statusCategory,
          href: taskPath(scope.projectId, r.id),
        },
      ]),
    );
  },
  async search(tx, scope, query, limit) {
    const number = /^#?(\d{1,9})$/.exec(query)?.[1];
    const rows = await tx.workTask.findMany({
      where: {
        projectId: scope.projectId,
        archivedAt: null,
        ...(number
          ? { number: Number(number) }
          : { title: { contains: words(query), mode: "insensitive" } }),
      },
      select: { id: true, number: true, title: true },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, title: `#${r.number} ${r.title}` }));
  },
};

const initiative: LinkTypeDef = {
  label: { en: "Initiative", de: "Vorhaben" },
  linkPermission: WORK_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.workInitiative.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, key: true, title: true, status: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { title: `${r.key} ${r.title}`, status: r.status, href: initiativePath(scope.projectId, r.id) },
      ]),
    );
  },
  async search(tx, scope, query, limit) {
    const rows = await tx.workInitiative.findMany({
      where: {
        projectId: scope.projectId,
        archivedAt: null,
        OR: [
          { title: { contains: words(query), mode: "insensitive" } },
          { key: { startsWith: words(query).toUpperCase() } },
        ],
      },
      select: { id: true, key: true, title: true },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, title: `${r.key} ${r.title}` }));
  },
};

const milestone: LinkTypeDef = {
  label: { en: "Milestone", de: "Meilenstein" },
  linkPermission: WORK_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.workMilestone.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, initiativeId: true, title: true, status: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { title: r.title, status: r.status, href: initiativePath(scope.projectId, r.initiativeId) },
      ]),
    );
  },
};

export const workLinkTypes = { task, initiative, milestone };
