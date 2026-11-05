import type { RetentionContribution } from "../governance/types.ts";
import { data } from "../shared.ts";

/** Purge terminal work orders and private histories under the existing retention action. */
export const taskRetention: RetentionContribution = async (
  tx,
  scope,
  { cutoff },
) => {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "orbit_tasks",
      updatedAt: { lt: cutoff },
    },
    take: 500,
  });
  let purged = 0;
  for (const row of rows) {
    const d = data(row);
    await tx.$executeRaw`SELECT set_config('app.user_id',${String(d.userId)},true)`;
    const run = d.runId
      ? await tx.chatRun.findFirst({
          where: { id: d.runId, userId: String(d.userId) },
        })
      : null;
    if (run && ["running", "queued"].includes(run.status)) continue;
    const requests = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind: "action_requests",
        data: { path: ["requestedBy", "taskId"], equals: row.id },
      },
    });
    if (
      requests.some(
        (r) =>
          data(r).status === "pending" &&
          Date.parse(data(r).expiresAt) > Date.now(),
      )
    )
      continue;
    const ids = [row.id, ...requests.map((r) => r.id)];
    await tx.entityVersion.deleteMany({
      where: { projectId: scope.projectId, entityId: { in: ids } },
    });
    await tx.entity.deleteMany({
      where: { projectId: scope.projectId, id: { in: ids } },
    });
    await tx.chatConversation.deleteMany({
      where: {
        id: d.conversationId,
        userId: String(d.userId),
        projectId: scope.projectId,
      },
    });
    purged++;
  }
  // Tasks in the work order table (target "assistant", origin "mcp",
  // WP3.6): the same rules, by their last change (start or cancellation).
  const tableRows = await tx.agentWorkOrder.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      target: "assistant",
      origin: "mcp",
      createdAt: { lt: cutoff },
      AND: [
        { OR: [{ startedAt: null }, { startedAt: { lt: cutoff } }] },
        { OR: [{ finishedAt: null }, { finishedAt: { lt: cutoff } }] },
      ],
    },
    take: 500,
  });
  for (const row of tableRows) {
    const by = row.requestedBy as { userId?: string };
    const userId = String(by.userId ?? "");
    const runId = (row.input as { runId?: string | null }).runId ?? null;
    await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true)`;
    const run = runId
      ? await tx.chatRun.findFirst({ where: { id: runId, userId } })
      : null;
    if (run && ["running", "queued"].includes(run.status)) continue;
    const requests = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind: "action_requests",
        data: { path: ["requestedBy", "taskId"], equals: row.id },
      },
    });
    if (
      requests.some(
        (r) =>
          data(r).status === "pending" &&
          Date.parse(data(r).expiresAt) > Date.now(),
      )
    )
      continue;
    const ids = requests.map((r) => r.id);
    await tx.entityVersion.deleteMany({
      where: { projectId: scope.projectId, entityId: { in: ids } },
    });
    await tx.entity.deleteMany({
      where: { projectId: scope.projectId, id: { in: ids } },
    });
    await tx.agentWorkOrder.delete({ where: { id: row.id } });
    if (row.conversationId)
      await tx.chatConversation.deleteMany({
        where: { id: row.conversationId, userId, projectId: scope.projectId },
      });
    purged++;
  }
  await tx.$executeRaw`SELECT set_config('app.user_id',${scope.userId},true)`;
  return {
    audit: (purged ? { tasks: purged } : {}) as Record<string, number>,
    result: (purged ? { purgedTasks: purged } : {}) as Record<string, number>,
  };
};
