/** Opt-in synthetic browser fixture; run from the repository root. Never starts a worker. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadWorktreeTestEnv } from "../scripts/test-database.ts";
if (!loadWorktreeTestEnv())
  throw new Error("Create the isolated worktree test database first");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:44310",
  PORT: "44311",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_MCP_TASKS: "true",
  ORBIT_MCP_PROPOSALS: "true",
});
const { buildServer } = await import("../apps/api/src/server.ts");
const { authDb, closeDatabase } = await import("../packages/db/src/index.ts");
const { createPackageProject } =
  await import("../apps/api/tests/support/package-project.ts");
const { makeAuth } = await import("../apps/api/src/auth.ts");
const { createTask } = await import("../apps/api/src/platform/tasks/tasks.ts");
const app = await buildServer();
const fixture = await createPackageProject({
  name: "Synthetic MCP work orders",
});
const email = `${randomUUID()}@example.invalid`,
  password = randomBytes(24).toString("base64url");
const created = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic MCP browser owner" },
});
await authDb.workspaceMember.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: created.user.id,
    role: "owner",
  },
});
const grant = await authDb.mcpGrant.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: created.user.id,
    clientId: "https://browser.example.invalid/mcp.json",
    scopes: ["orbit:read", "orbit:propose"],
    modules: ["marketing"],
    projectIds: [fixture.owner.projectId],
    status: "active",
    activatedAt: new Date(),
  },
});
const task = await createTask(
  {
    userId: created.user.id,
    clientId: grant.clientId,
    grantId: grant.id,
    workspaceId: grant.workspaceId,
    scopes: new Set(grant.scopes),
    modules: grant.modules,
    projectIds: grant.projectIds,
  },
  fixture.owner.projectId,
  {
    description:
      "Review the beta launch campaign and prepare copy for owner approval.",
    modules: ["marketing"],
    idempotencyKey: randomUUID(),
  },
);
writeFileSync(
  ".runtime/mcp2-browser.json",
  JSON.stringify({
    email,
    password,
    projectId: fixture.owner.projectId,
    taskId: task.taskId,
  }),
  { mode: 0o600 },
);
await app.listen({ port: 44311, host: "127.0.0.1" });
console.log(
  "Synthetic MCP browser API ready at http://127.0.0.1:44311; stop with Ctrl+C to clean up",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await fixture.cleanup();
    await authDb.user.delete({ where: { id: created.user.id } });
    await closeDatabase();
    process.exit(0);
  });
