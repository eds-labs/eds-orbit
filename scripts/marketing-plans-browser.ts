/** Isolated synthetic MA-03 browser fixture; no worker or provider. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (!loadWorktreeTestEnv())
  throw new Error("Prepare worktree test database first");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:44430",
  PORT: "44431",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_AGENTS: "true",
});
const { buildServer } = await import("../apps/api/src/server.ts");
const { authDb, closeDatabase } = await import("../packages/db/src/index.ts");
const { createPackageProject } =
  await import("../apps/api/tests/support/package-project.ts");
const { makeAuth } = await import("../apps/api/src/auth.ts");
const { chatScoped, createConversation } =
  await import("../apps/api/src/modules/chat.ts");
const { planSpec } =
  await import("../apps/api/tests/support/marketing-plan.ts");
const { proposePlan } =
  await import("../apps/api/src/modules/marketing/plans/service.ts");
const { planCard } =
  await import("../apps/api/src/modules/marketing/tools/plan-tools.ts");
const app = await buildServer(),
  fixture = await createPackageProject({ name: "Synthetic MA-03 strategy" });
const email = `${randomUUID()}@example.invalid`,
  password = randomBytes(24).toString("base64url");
const created = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic strategy owner" },
});
await authDb.workspaceMember.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: created.user.id,
    role: "owner",
  },
});
const owner = { ...fixture.owner, userId: created.user.id };
const thread = await createConversation(owner);
const plan = await chatScoped(owner, async (tx) => {
  const saved = await proposePlan(
    tx,
    owner,
    await planSpec(tx, owner),
    thread.id,
  );
  await tx.chatMessage.create({
    data: {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      userId: owner.userId,
      conversationId: thread.id,
      sequence: 1,
      role: "assistant",
      text: "Review the saved strategy only; no execution starts.",
      cards: [planCard(saved)] as any,
    },
  });
  return saved;
});
const file = ".runtime/marketing-plan-browser.json";
writeFileSync(
  file,
  JSON.stringify({
    email,
    password,
    projectId: owner.projectId,
    planId: plan.id,
    conversationId: thread.id,
  }),
  { mode: 0o600 },
);
await app.listen({ port: 44431, host: "127.0.0.1" });
console.log("Synthetic MA-03 browser API ready; no worker/provider started.");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await fixture.cleanup();
    await authDb.user.delete({ where: { id: created.user.id } });
    await closeDatabase();
    rmSync(file, { force: true });
    process.exit(0);
  });
