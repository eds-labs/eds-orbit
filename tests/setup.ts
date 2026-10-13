import { beforeAll } from "vitest";
import { existsSync } from "node:fs";
if (existsSync(".runtime/local.env")) process.loadEnvFile(".runtime/local.env");
// Integration tests skip themselves without a database or Redis. In CI that
// would turn a broken setup into a green run, so CI refuses to start instead.
if (process.env.CI === "true") {
  const missing = [
    "TEST_DATABASE_URL",
    "TEST_AUTH_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
    "REDIS_URL",
  ].filter((key) => !process.env[key]);
  if (missing.length)
    throw new Error(
      `CI_TEST_ENVIRONMENT_INCOMPLETE: ${missing.join(", ")} missing; integration tests would be skipped`,
    );
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
}
// Keep test output quiet; logging tests opt back in via LOG_LEVEL.
process.env.LOG_LEVEL ??= "silent";
// The test process is a composition root like the API and the worker: every
// module's contributions (tools, action types, jobs, sweeps, projections)
// are registered before the tests run. In a hook, so the registry is loaded
// after the test file registered its vi.mock replacements.
beforeAll(async () => {
  const { registerModules } = await import("../apps/api/src/modules/registry.ts");
  registerModules();
});
