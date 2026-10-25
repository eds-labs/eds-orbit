import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { fromDate, workMembers } from "../common.ts";
import { readWorkSettings } from "../settings.ts";

// The deterministic context of a planning run (plan §2.4): the request as
// quoted data, the project's calendar, the members who may own work and,
// when extending an initiative, its current state. The model never reads
// the database itself; comments and descriptions are not included.

const MAX_EXISTING_TASKS = 200;

/** Today in the project's timezone, YYYY-MM-DD. */
export function projectToday(timezone: string, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function planContext(
  tx: DbTx,
  scope: Scope,
  request: { text: string; initiativeId: string | null },
  now = new Date(),
) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { timezone: true, language: true, contentLanguages: true },
  });
  const { settings } = await readWorkSettings(tx, scope);
  const members = (await workMembers(scope)).filter((m) => m.role !== "viewer");
  const keys = await tx.workInitiative.findMany({
    where: { projectId: scope.projectId },
    select: { key: true },
  });
  let initiative = null;
  if (request.initiativeId) {
    const row = await tx.workInitiative.findFirstOrThrow({
      where: { projectId: scope.projectId, id: request.initiativeId },
    });
    const [milestones, tasks] = await Promise.all([
      tx.workMilestone.findMany({
        where: { projectId: scope.projectId, initiativeId: row.id },
        orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }],
      }),
      tx.workTask.findMany({
        where: { projectId: scope.projectId, initiativeId: row.id, archivedAt: null },
        orderBy: { number: "asc" },
        take: MAX_EXISTING_TASKS,
      }),
    ]);
    const numbers = new Map(tasks.map((t) => [t.id, t.number]));
    initiative = {
      key: row.key,
      title: row.title,
      status: row.status,
      startDate: fromDate(row.startDate),
      targetDate: fromDate(row.targetDate),
      milestones: milestones.map((m) => ({
        title: m.title,
        dueDate: fromDate(m.dueDate),
        status: m.status,
      })),
      tasks: tasks.map((t) => ({
        number: t.number,
        title: t.title,
        statusCategory: t.statusCategory,
        priority: t.priority,
        dueDate: fromDate(t.dueDate),
        milestone: milestones.find((m) => m.id === t.milestoneId)?.title ?? null,
        parentNumber: t.parentTaskId ? (numbers.get(t.parentTaskId) ?? null) : null,
        assigneeUserId: t.assigneeUserId,
      })),
    };
  }
  return {
    // The member's words: data to plan from, never instructions to follow.
    request: { text: request.text },
    today: projectToday(project.timezone, now),
    timezone: project.timezone,
    language: project.language,
    members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    statusCategories: [...new Set(settings.workflow.statuses.map((s) => s.category))],
    takenInitiativeKeys: keys.map((k) => k.key),
    existingInitiative: initiative,
  };
}
