/** Synthetic MA-00–02 browser fixture, isolated worktree DB; never starts a worker. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (!loadWorktreeTestEnv())
  throw new Error("Create the isolated worktree test database first");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:44330",
  PORT: "44331",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_AGENTS: "true",
});
const { buildServer } = await import("../apps/api/src/server.ts");
const { authDb, closeDatabase } = await import("../packages/db/src/index.ts");
const { createPackageProject, X } =
  await import("../apps/api/tests/support/package-project.ts");
const { assignmentRun } =
  await import("../apps/api/tests/support/assignment-review.ts");
const { makeAuth } = await import("../apps/api/src/auth.ts");
const { createConversation, chatScoped } =
  await import("../apps/api/src/modules/chat.ts");
const { proposeAssignment } =
  await import("../apps/api/src/modules/marketing/agents/assignments.ts");
const app = await buildServer();
const fixture = await createPackageProject({ name: "Synthetic MA-01 browser" });
const email = `${randomUUID()}@example.invalid`,
  password = randomBytes(24).toString("base64url");
const created = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic marketing owner" },
});
await authDb.workspaceMember.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: created.user.id,
    role: "owner",
  },
});
const owner = { ...fixture.owner, userId: created.user.id };
const conversation = await createConversation(owner);
const { assignment } = await proposeAssignment(owner, conversation.id, {
  name: "Weekly approval-first marketing",
  kind: "standing",
  schedule: {
    rhythm: "weekly",
    weekdays: [1],
    times: ["10:00"],
    leadMinutes: 360,
  },
  contentType: "social",
  channels: [X],
  topicFrame: "English beta access updates",
  image: false,
  styleAssetIds: [],
  vetoMinutes: 180,
  monthlyBudgetMicros: 10_000_000,
});
const legacy = await assignmentRun(fixture).makeAssignment({
  name: "Existing delegated marketing",
  monthlyBudgetMicros: 10_000_000,
});
const { update, data, create } = await import("../apps/api/src/shared.ts");
await assignmentRun(fixture).run((tx) =>
  update(tx, fixture.owner, legacy, { ...data(legacy), status: "paused" }),
);
// Saved synthetic evidence only: no specialist, AI provider or delivery runs.
const { assignmentCardOf } =
  await import("../apps/api/src/modules/marketing/tools/assignment-tools.ts");
const resultRun = await chatScoped(owner, async (tx) => {
  const run = await create(tx, owner, "assignment_runs", {
    assignmentId: assignment.id,
    date: "2026-10-20",
    status: "done",
    costMicros: 1200,
    steps: [],
    unavailable: [],
  });
  const content = await create(tx, owner, "content", {
    assignmentId: assignment.id,
    assignmentRunId: run.id,
    type: "social",
    channel: X,
    status: "needs_review",
    body: "Synthetic browser evidence only.",
    approvalMode: "human_each",
  });
  await tx.chatMessage.create({
    data: {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      userId: owner.userId,
      conversationId: conversation.id,
      sequence: 1,
      role: "assistant",
      text: "Synthetic assignment result",
      cards: [
        {
          kind: "assignment",
          label: "Assignment",
          assignment: assignmentCardOf(assignment),
        },
      ],
    },
  });
  return { id: run.id, contentId: content.id };
});
const file = ".runtime/marketing-v2-browser.json";
writeFileSync(
  file,
  JSON.stringify({
    email,
    password,
    projectId: owner.projectId,
    assignmentId: assignment.id,
    conversationId: conversation.id,
    resultRun,
  }),
  { mode: 0o600 },
);
await app.listen({ port: 44331, host: "127.0.0.1" });
console.log(
  "Synthetic Marketing v2 API ready on 127.0.0.1:44331; no worker/provider is running.",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await fixture.cleanup();
    await authDb.user.delete({ where: { id: created.user.id } });
    await closeDatabase();
    rmSync(file, { force: true });
    process.exit(0);
  });
