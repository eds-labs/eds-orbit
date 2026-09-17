import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredEnvironment = {
  DB_PASSWORD: "test",
  AUTH_SECRET: "test",
  CREDENTIAL_KEY: "a".repeat(64),
  ORBIT_SETUP_TOKEN: "test",
  APP_ORIGIN: "https://example.invalid",
  PUBLISHER_INSTANCE_ID: "test",
  MIGRATION_DATABASE_URL: "postgresql://test:test@postgres:5432/orbit",
  DATABASE_URL: "postgresql://test:test@postgres:5432/orbit",
  AUTH_DATABASE_URL: "postgresql://test:test@postgres:5432/orbit",
  ORBIT_RELEASE_APPROVAL: "test",
};

const rendered = execFileSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "config", "--format", "json"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...requiredEnvironment },
  },
);
const services = JSON.parse(rendered).services;
const runtimeBuild = services.api.build;

assert.ok(runtimeBuild, "api must be locally buildable");
for (const name of ["migrate", "api", "worker", "web"]) {
  assert.deepEqual(
    services[name].build,
    runtimeBuild,
    `${name} must inherit the same local runtime build as api`,
  );
}

console.log("Coolify Compose runtime services are all locally buildable.");
