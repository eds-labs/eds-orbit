/** Isolated MA-07 browser fixture: saved aggregates, no worker/provider. */
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { loadWorktreeTestEnv } from "./test-database.ts";
if (!loadWorktreeTestEnv()) throw new Error("Prepare isolated test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:44430",
  PORT: "44431",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
  ORBIT_AGENTS: "true",
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
const { persistReport, attributionCampaign } =
  await import("../apps/api/src/modules/marketing/analytics/reports.ts");
const { reportWeek } =
  await import("../apps/api/src/modules/marketing/analytics/report-schedule.ts");
const { create, data, entity, update, hash } =
  await import("../apps/api/src/shared.ts");
const app = await buildServer();
const fixture = await createPackageProject({ name: "Synthetic MA-07 reports" });
const email = `${randomUUID()}@example.invalid`,
  password = randomBytes(24).toString("base64url");
const account = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic report owner" },
});
await authDb.workspaceMember.create({
  data: {
    workspaceId: fixture.owner.workspaceId,
    userId: account.user.id,
    role: "owner",
  },
});
const owner = { ...fixture.owner, userId: account.user.id };
const r = await scoped(owner.workspaceId, owner.projectId, async (tx) => {
  const proposed = await proposePlan(tx, owner, await planSpec(tx, owner));
  const plan = await entity(tx, owner, "marketing_plans", proposed.id),
    d = data(plan);
  const spec = {
    ...d.spec,
    horizon: {
      startAt: new Date(Date.now() - 20 * 86400000).toISOString(),
      endAt: new Date(Date.now() + 8 * 86400000).toISOString(),
    },
  };
  await update(tx, owner, plan, {
    ...d,
    spec,
    specHash: hash({ spec, sources: d.sources }),
    status: "active",
  });
  const week = reportWeek(new Date(), "Europe/Berlin");
  await create(tx, owner, "metrics", {
    source: "synthetic",
    accountId: "aggregate-only",
    campaign: attributionCampaign(plan.id),
    reportFamily: "sessions",
    currency: "USD",
    timezone: "UTC",
    periodStart: week.from + "T00:00:00.000Z",
    periodEnd: week.from + "T23:59:59.999Z",
    sessions: 12,
    clicks: null,
    impressions: null,
    conversions: null,
    sampleSize: 12,
  });
  return persistReport(tx, owner, {
    planId: plan.id,
    from: week.from,
    to: week.to,
  });
});
const file = ".runtime/marketing-report-browser.json";
writeFileSync(
  file,
  JSON.stringify({
    email,
    password,
    projectId: owner.projectId,
    reportId: r.id,
  }),
  { mode: 0o600 },
);
await app.listen({ host: "127.0.0.1", port: 44431 });
console.log("Synthetic report API ready; no worker/provider.");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await fixture.cleanup();
    await authDb.user.delete({ where: { id: account.user.id } });
    await closeDatabase();
    unlinkSync(file);
    process.exit(0);
  });
