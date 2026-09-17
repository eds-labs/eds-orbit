import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedEnvironment = {
  SERVICE_PASSWORD_64_DB_MIGRATOR: "m".repeat(64),
  SERVICE_PASSWORD_64_DB_APP: "a".repeat(64),
  SERVICE_PASSWORD_64_DB_AUTH: "u".repeat(64),
  SERVICE_REALBASE64_64_AUTH_SECRET: "s".repeat(64),
  SERVICE_HEX_64_CREDENTIAL_KEY: "c".repeat(64),
  SERVICE_PASSWORD_64_ORBIT_SETUP_TOKEN: "o".repeat(64),
  SERVICE_BASE64_32_PUBLISHER_INSTANCE: "p".repeat(32),
  SERVICE_URL_WEB_4310: "https://orbit.example.invalid",
};
const composeEnvironment = {
  ...process.env,
  ...generatedEnvironment,
  POSTGRES_DB: "orbit",
  ORBIT_RELEASE_APPROVAL: "test-change-reference",
};
for (const key of [
  "DB_PASSWORD",
  "AUTH_SECRET",
  "CREDENTIAL_KEY",
  "ORBIT_SETUP_TOKEN",
  "APP_ORIGIN",
  "PUBLISHER_INSTANCE_ID",
  "MIGRATION_DATABASE_URL",
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
])
  delete composeEnvironment[key];

const rendered = execFileSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "config", "--format", "json"],
  {
    cwd: root,
    encoding: "utf8",
    env: composeEnvironment,
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

assert.equal(
  services.postgres.environment.POSTGRES_PASSWORD,
  generatedEnvironment.SERVICE_PASSWORD_64_DB_MIGRATOR,
);
assert.equal(
  services.migrate.environment.MIGRATION_DATABASE_URL,
  `postgresql://orbit_migrator:${generatedEnvironment.SERVICE_PASSWORD_64_DB_MIGRATOR}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.DATABASE_URL,
  `postgresql://orbit_app:${generatedEnvironment.SERVICE_PASSWORD_64_DB_APP}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.AUTH_DATABASE_URL,
  `postgresql://orbit_auth:${generatedEnvironment.SERVICE_PASSWORD_64_DB_AUTH}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.AUTH_SECRET,
  generatedEnvironment.SERVICE_REALBASE64_64_AUTH_SECRET,
);
assert.equal(
  services.api.environment.CREDENTIAL_KEY,
  generatedEnvironment.SERVICE_HEX_64_CREDENTIAL_KEY,
);
assert.equal(
  services.api.environment.ORBIT_SETUP_TOKEN,
  generatedEnvironment.SERVICE_PASSWORD_64_ORBIT_SETUP_TOKEN,
);
assert.equal(
  services.api.environment.APP_ORIGIN,
  generatedEnvironment.SERVICE_URL_WEB_4310,
);
assert.equal(
  services.api.environment.PUBLISHER_INSTANCE_ID,
  generatedEnvironment.SERVICE_BASE64_32_PUBLISHER_INSTANCE,
);

const composeSource = readFileSync(`${root}/docker-compose.yml`, "utf8");
assert.doesNotMatch(
  composeSource,
  /:\?required/,
  "Coolify treats the text after :? as an initial variable value",
);
assert.match(
  composeSource,
  /ORBIT_RELEASE_APPROVAL: \$\{ORBIT_RELEASE_APPROVAL:\?\}/,
);

const missingApprovalEnvironment = { ...composeEnvironment };
delete missingApprovalEnvironment.ORBIT_RELEASE_APPROVAL;
const missingApproval = spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "config", "--quiet"],
  { cwd: root, env: missingApprovalEnvironment, encoding: "utf8" },
);
assert.notEqual(
  missingApproval.status,
  0,
  "deployment must remain blocked without a release approval reference",
);

console.log(
  "Coolify Compose services build locally, bootstrap generated secrets, and retain the release gate.",
);
