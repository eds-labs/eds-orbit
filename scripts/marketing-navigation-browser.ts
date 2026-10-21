/** Isolated MA-08 navigation fixture. No worker, paid call or external delivery. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (!loadWorktreeTestEnv())
  throw new Error("Prepare isolated worktree test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:44430",
  PORT: "44431",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_AGENTS: "true",
  ORBIT_MODULES: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_SUPPORT: "true",
});
const { buildServer } = await import("../apps/api/src/server.ts");
const { authDb, scoped, closeDatabase } =
  await import("../packages/db/src/index.ts");
const { makeAuth } = await import("../apps/api/src/auth.ts");
const { createPackageProject } =
  await import("../apps/api/tests/support/package-project.ts");
const { planSpec } =
  await import("../apps/api/tests/support/marketing-plan.ts");
const { proposePlan } =
  await import("../apps/api/src/modules/marketing/plans/service.ts");
const { createActionRequest } =
  await import("../apps/api/src/modules/action-requests.ts");
const app = await buildServer();
const primary = await createPackageProject({
  name: "Synthetic MA-08 Marketing",
});
const support = await createPackageProject({
  name: "Synthetic MA-08 Support only",
});
const users: string[] = [];
async function account(name: string) {
  const email = `${randomUUID()}@example.invalid`,
    password = randomBytes(24).toString("base64url");
  const created = await makeAuth().api.signUpEmail({
    body: { email, password, name },
  });
  users.push(created.user.id);
  return { email, password, userId: created.user.id };
}
const owner = await account("Synthetic navigation owner");
const viewer = await account("Synthetic Marketing viewer");
const hidden = await account("Synthetic Marketing hidden");
for (const fixture of [primary, support]) {
  await authDb.workspaceMember.create({
    data: {
      workspaceId: fixture.owner.workspaceId,
      userId: owner.userId,
      role: "owner",
    },
  });
}
for (const [user, role] of [
  [viewer, "viewer"],
  [hidden, "none"],
] as const) {
  const { workspaceId, projectId } = primary.owner;
  await authDb.workspaceMember.create({
    data: { workspaceId, userId: user.userId, role: "viewer" },
  });
  await authDb.projectMember.create({
    data: { workspaceId, projectId, userId: user.userId, role: "editor" },
  });
  await authDb.projectMemberModuleRole.create({
    data: {
      workspaceId,
      projectId,
      userId: user.userId,
      moduleId: "marketing",
      role,
    },
  });
}
const primaryScope = { ...primary.owner, userId: owner.userId };
const plan = await scoped(
  primaryScope.workspaceId,
  primaryScope.projectId,
  async (tx) => proposePlan(tx, primaryScope, await planSpec(tx, primaryScope)),
);
const supportScope = { ...support.owner, userId: owner.userId };
await scoped(supportScope.workspaceId, supportScope.projectId, async (tx) => {
  for (const [moduleId, enabled] of [
    ["marketing", false],
    ["support", true],
  ] as const)
    await tx.projectModule.create({
      data: {
        workspaceId: supportScope.workspaceId,
        projectId: supportScope.projectId,
        moduleId,
        moduleVersion: "1.0.0",
        enabled,
      },
    });
  // A saved native pending request for UI inspection only. Never approved; the
  // synthetic ticket ID has no customer/destination and cannot be dispatched.
  await createActionRequest(tx, supportScope, {
    actionType: "support.mcp.support_add_note",
    payload: {
      actorId: owner.userId,
      args: {
        ticketId: randomUUID(),
        bodyText: "Synthetic pending Support note",
      },
      idempotencyKey: randomUUID(),
      ceilingMicros: 0,
    },
    requestedBy: { kind: "user", userId: owner.userId },
  });
});
const file = ".runtime/marketing-navigation-browser.json";
writeFileSync(
  file,
  JSON.stringify({
    owner,
    viewer,
    hidden,
    projectId: primaryScope.projectId,
    workspaceId: primaryScope.workspaceId,
    supportProjectId: supportScope.projectId,
    supportWorkspaceId: supportScope.workspaceId,
    planId: plan.id,
  }),
  { mode: 0o600 },
);
await app.listen({ host: "127.0.0.1", port: 44431 });
console.log("Synthetic MA-08 navigation API ready; no worker/provider.");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await primary.cleanup();
    await support.cleanup();
    for (const id of users) await authDb.user.delete({ where: { id } });
    await closeDatabase();
    rmSync(file, { force: true });
    process.exit(0);
  });
