/**
 * Synthetic Creative Studio browser fixture on this worktree's isolated test
 * database: a project, an owner account, a marketing profile without a brand
 * kit, one social post in a mission and the fictional demo PNGs. Serves the API
 * on 127.0.0.1:4311 with ORBIT_CREATIVE_STUDIO=true. No worker, no provider call
 * (image generation stays unconfigured). Run `pnpm exec tsx` with the repo's
 * local env; stop with SIGTERM to clean up.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (!loadWorktreeTestEnv())
  throw new Error("Create the isolated worktree test database first");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:4310",
  PORT: "4311",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_CREATIVE_STUDIO: "true",
});
const { buildServer } = await import("../apps/api/src/server.ts");
const { authDb, closeDatabase, scoped } =
  await import("../packages/db/src/index.ts");
const { createPackageProject } =
  await import("../apps/api/tests/support/package-project.ts");
const { lumoraProfile } =
  await import("../apps/api/tests/support/creative-profile.ts");
const { makeAuth } = await import("../apps/api/src/auth.ts");
const { create } = await import("../apps/api/src/shared.ts");
const { demoBrand, fixtureScreenshot } =
  await import("../packages/creative/fixtures/demo-brands.ts");

const app = await buildServer();
const fixture = await createPackageProject({
  name: "Synthetic creative studio",
});
const email = `${randomUUID()}@example.invalid`;
const password = randomBytes(24).toString("base64url");
const created = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic creative owner" },
});
await authDb.workspaceMember.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: created.user.id,
    role: "owner",
  },
});
const owner = fixture.owner;
const content = await scoped(owner.workspaceId, owner.projectId, async (tx) => {
  // Replace the package project's profile with the demo brand (no brand kit yet).
  // The package project's official link points at a real fact; keep it.
  const previous = await tx.projectMarketingProfile.findFirstOrThrow({
    where: { projectId: owner.projectId },
  });
  const links = (previous.data as { officialLinks: unknown[] }).officialLinks;
  await tx.projectMarketingProfile.deleteMany({
    where: { projectId: owner.projectId },
  });
  await tx.projectMarketingProfile.create({
    data: {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      version: 1,
      data: lumoraProfile({}, { officialLinks: links }),
    },
  });
  const mission = await create(tx, owner, "missions", {
    title: "Autumn evenings",
    status: "active",
    targetAction: "Shop the collection",
  });
  const evidence = await create(tx, owner, "evidence", {
    status: "ready",
    purpose: "public",
    facts: [],
    items: [],
  });
  return create(tx, owner, "content", {
    title: "Evenings feel softer",
    body: "Evenings feel softer in warm light. Shop the collection.",
    type: "social",
    // A channel no connector knows: no channel rules, so the square format.
    channel: "unruled-browser",
    status: "reviewed",
    missionId: mission.id,
    evidenceId: evidence.id,
    claims: [],
  });
});
mkdirSync("apps/web/tests/fixtures", { recursive: true });
writeFileSync(
  "apps/web/tests/fixtures/lumora-logo.png",
  (await demoBrand("lumora")).logos[0]!.bytes,
);
writeFileSync(
  "apps/web/tests/fixtures/lumora-screenshot.png",
  (await fixtureScreenshot("lumora")).bytes,
);
const file = ".runtime/creative-studio-browser.json";
writeFileSync(
  file,
  JSON.stringify({
    email,
    password,
    projectId: owner.projectId,
    contentId: content.id,
  }),
  { mode: 0o600 },
);
await app.listen({ port: 4311, host: "127.0.0.1" });
console.log("Synthetic Creative Studio API ready on 127.0.0.1:4311");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await fixture.cleanup();
    await authDb.user.delete({ where: { id: created.user.id } });
    await closeDatabase();
    rmSync(file, { force: true });
    process.exit(0);
  });
