import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
process.loadEnvFile(".runtime/local.env");
if (
  process.env.EXECUTION_MODE !== "test" ||
  new URL(process.env.DATABASE_URL!).port !== "55432"
)
  throw new Error("Isolated local test configuration required");
const existing = existsSync(".runtime/e2e-user.json")
  ? JSON.parse(readFileSync(".runtime/e2e-user.json", "utf8"))
  : null;
/**
 * With E2E_SOCIAL=1 (S6): the social module on in the acceptance project and
 * one synthetic Telegram account that may post. Test mode sends nothing, so
 * the account has no secret; it counts as checked now, so the six-hourly
 * health read (which would find no secret) leaves it alone during the run.
 */
async function seedSocial(projectId: string) {
  if (process.env.E2E_SOCIAL !== "1") return;
  const { authDb, scoped } = await import("../packages/db/src/index.ts");
  const row = await authDb.project.findUniqueOrThrow({ where: { id: projectId } });
  const owner = await authDb.projectMember.findFirstOrThrow({ where: { projectId, role: "owner" } });
  await scoped(row.workspaceId, projectId, async (tx) => {
    await tx.projectModule.upsert({
      where: { workspaceId_projectId_moduleId: { workspaceId: row.workspaceId, projectId, moduleId: "social" } },
      create: { workspaceId: row.workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: owner.userId },
      update: { enabled: true },
    });
    const checked = { lastCheckedAt: new Date().toISOString(), lastCheckCode: null };
    const seeded = await tx.socialAccount.findFirst({ where: { projectId, handle: "Orbit e2e channel" } });
    if (seeded)
      await tx.socialAccount.update({
        where: { id: seeded.id },
        data: { status: "active", settings: { ...(seeded.settings as object), ...checked }, version: { increment: 1 } },
      });
    else
      await tx.socialAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: row.workspaceId,
          projectId,
          connectionId: randomUUID(),
          platform: "telegram",
          externalId: "-1000000000001",
          handle: "Orbit e2e channel",
          displayName: "Orbit e2e channel",
          capability: "write_verified",
          settings: checked,
          createdBy: owner.userId,
        },
      });
  });
  console.log("Social module and synthetic Telegram account ready.");
}
if (existing?.projectId) {
  await seedSocial(existing.projectId);
  if (process.env.E2E_SOCIAL === "1") {
    const { closeDatabase } = await import("../packages/db/src/index.ts");
    await closeDatabase();
  }
  console.log("Preserved existing synthetic browser account.");
  process.exit(0);
}
const { buildServer } = await import("../apps/api/src/server.ts");
const { closeDatabase } = await import("../packages/db/src/index.ts");
const app = await buildServer((error) => {
  const e = error as Error;
  let message = e.message;
  for (const value of Object.values(process.env))
    if (value && value.length > 20)
      message = message.replaceAll(value, "[redacted]");
  console.error(e.name, message);
});
const headers = { origin: process.env.APP_ORIGIN! };
const email = existing?.email ?? "orbit-owner@example.invalid",
  password = existing?.password ?? randomBytes(24).toString("base64url");
if (!existing) {
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers,
    payload: {
      name: "Synthetic Orbit Owner",
      email,
      password,
      workspaceName: "Orbit isolated acceptance",
      setupToken: process.env.ORBIT_SETUP_TOKEN,
    },
  });
  if (setup.statusCode === 201)
    writeFileSync(
      ".runtime/e2e-user.json",
      JSON.stringify({ email, password }),
      { mode: 0o600 },
    );
  if (setup.statusCode !== 201)
    throw new Error(
      "Synthetic setup failed: " +
        setup.statusCode +
        " " +
        setup.json().error?.code,
    );
}
const login = await app.inject({
  method: "POST",
  url: "/api/auth/sign-in/email",
  headers,
  payload: { email, password },
});
if (login.statusCode !== 200)
  throw new Error("Synthetic login failed " + login.statusCode);
const cookies = login.headers["set-cookie"];
const cookie = (Array.isArray(cookies) ? cookies : [cookies])
  .filter(Boolean)
  .map((x) => x!.split(";")[0])
  .join("; ");
const project = await app.inject({
  method: "POST",
  url: "/api/projects",
  headers: { ...headers, cookie },
  payload: {
    name: "Orbit acceptance project",
    timezone: "Europe/Berlin",
    language: "en",
  },
});
if (project.statusCode !== 201)
  throw new Error(
    "Synthetic project failed " +
      project.statusCode +
      " " +
      project.json().error?.code,
  );
writeFileSync(
  ".runtime/e2e-user.json",
  JSON.stringify({ email, password, projectId: project.json().id }),
  { mode: 0o600 },
);
await seedSocial(project.json().id);
await app.close();
await closeDatabase();
console.log(
  "Created isolated synthetic browser account; credentials remain in ignored mode-0600 runtime file.",
);
