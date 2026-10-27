/**
 * Synthetic Creative Studio browser fixture on this worktree's isolated test
 * database: a project, an owner account, a marketing profile without a brand
 * kit, one social post in a mission and the fictional demo PNGs. Serves the API
 * on 127.0.0.1:4311 with ORBIT_CREATIVE_STUDIO=true. No worker.
 *
 * No paid generation is possible by construction (R62): before the API is
 * loaded, every AI provider key and model or image route variable
 * (OPENAI_*, ANTHROPIC_*) is removed from this process's environment, and the
 * synthetic project on the isolated test database has no saved key.
 *
 * Run recipe (from the worktree root, Node 24; one run per seed):
 *   1. node scripts/test-db-for-worktree.ts            (once, and after new migrations)
 *   2. set -a; . <main checkout>/.runtime/local.env; set +a
 *      node --import tsx scripts/creative-studio-browser.ts
 *      (seeds and serves the API on 4311; wait for "API ready")
 *   3. in apps/web: node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 4310
 *      (start it without provider keys too; the web app never calls a provider)
 *   4. CREATIVE_STUDIO_E2E=true node node_modules/@playwright/test/cli.js test apps/web/tests/creative-studio.spec.ts
 *   5. stop step 2 with SIGTERM (cleans up its project and account); a new run
 *      needs a fresh seed (step 2 again).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
import { clearProviderAccess } from "./provider-free-env.ts";
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
// No provider key or image route reaches the API (R62), whatever the env files set.
clearProviderAccess();
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
