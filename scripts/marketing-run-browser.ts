/** Add saved MA-06 evidence to the isolated browser fixture; never run a worker. */
import { readFileSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (process.env.MARKETING_PLAN_E2E !== "true" || !loadWorktreeTestEnv())
  throw new Error("Explicit isolated browser fixture required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
const account = JSON.parse(
  readFileSync(".runtime/marketing-plan-browser.json", "utf8"),
);
const { scoped, closeDatabase } = await import("../packages/db/src/index.ts");
const { create } = await import("../apps/api/src/shared.ts");
try {
  await scoped(account.workspaceId, account.projectId, async (tx) => {
    const assignment = await tx.entity.findFirstOrThrow({
      where: {
        workspaceId: account.workspaceId,
        projectId: account.projectId,
        kind: "assignments",
      },
    });
    const scope = {
      workspaceId: account.workspaceId,
      projectId: account.projectId,
      userId: account.userId,
      role: "owner" as const,
    };
    const saved = await create(tx, scope, "assignment_runs", {
      assignmentId: assignment.id,
      status: "done",
      date: "2026-10-20",
      slots: [],
      steps: [],
    });
    const task = await create(tx, scope, "agent_tasks", {
      runId: saved.id,
      role: "review",
      stepKey: "review",
      status: "outcome_unknown",
      errorCode: "AGENT_OUTCOME_UNKNOWN",
    });
    await tx.budgetReservation.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        key: `${scope.projectId}:agent:${task.id}:synthetic`,
        category: "model",
        state: "unknown",
        amountMicros: 70000n,
      },
    });
  });
} finally {
  await closeDatabase();
}
