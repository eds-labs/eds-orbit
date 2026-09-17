import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
if (!existsSync(".runtime/local.env")) {
  const c = spawnSync(process.execPath, ["scripts/local-config.mjs"], {
    stdio: "inherit",
  });
  if (c.status) process.exit(c.status);
}
process.loadEnvFile(".runtime/local.env");
function run(command: string, args: string[], env = process.env) {
  const r = spawnSync(command, args, { stdio: "inherit", env });
  if (r.status !== 0) throw new Error("Local setup step failed");
}
if (
  new URL(process.env.MIGRATION_DATABASE_URL!).hostname !== "127.0.0.1" ||
  new URL(process.env.MIGRATION_DATABASE_URL!).port !== "55432"
)
  throw new Error("Isolated local configuration required");
run("docker", [
  "compose",
  "--env-file",
  ".runtime/local.env",
  "-f",
  "infra/compose.local.yml",
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
]);
run(process.execPath, ["--import", "tsx", "scripts/init-db.ts"], {
  ...process.env,
  ORBIT_LOCAL_SETUP: "1",
});
run(process.execPath, ["--import", "tsx", "scripts/db-deploy.ts"]);
run(process.execPath, ["--import", "tsx", "scripts/db-deploy.ts"], {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
  MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL,
});
console.log("Isolated Orbit local databases and runtime dependencies ready.");
