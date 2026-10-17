import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedEnvironment = {
  SERVICE_PASSWORD_64_DBMIGRATOR: "m".repeat(64),
  SERVICE_PASSWORD_64_DBAPP: "a".repeat(64),
  SERVICE_PASSWORD_64_DBAUTH: "u".repeat(64),
  SERVICE_REALBASE64_64_AUTHSECRET: "s".repeat(64),
  SERVICE_HEX_64_CREDENTIALKEY: "c".repeat(64),
  SERVICE_PASSWORD_64_ORBITSETUPTOKEN: "o".repeat(64),
  SERVICE_BASE64_32_PUBLISHERINSTANCE: "p".repeat(32),
  SERVICE_URL_WEB: "https://orbit.example.invalid",
};
const composeEnvironment = {
  ...process.env,
  ...generatedEnvironment,
  POSTGRES_DB: "orbit",
  ORBIT_RELEASE_APPROVAL: "test-change-reference",
  GOOGLE_DRIVE_CLIENT_ID: "synthetic-google-client",
  GOOGLE_DRIVE_CLIENT_SECRET: "synthetic-google-secret",
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
  "ORBIT_CONTENT_PACKAGES",
  "ORBIT_TOOL_SEARCH",
  "ORBIT_AGENTS",
  "ORBIT_IMAGE_REFERENCES",
  "ORBIT_AGENT_REVIEW_AUTHORITY",
  "ORBIT_MODULES",
  "ORBIT_MCP_OAUTH",
  "ORBIT_MCP_DCR",
  "MCP_RESOURCE",
  "ORBIT_MCP_CIMD_HOSTS",
  "ORBIT_MODULE_ROLES",
  "ORBIT_PUBLIC_INGRESS",
  "ORBIT_SUPPORT",
  "ORBIT_FILES",
  "ORBIT_EMAIL",
  "ORBIT_NOTIFICATIONS",
  "ORBIT_REALTIME",
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

// The api and worker must start with exactly what Compose renders: an
// unset optional variable arrives as "" (production incident 2026-10-17).
const { configSchema } = await import("../packages/config/src/index.ts");
for (const name of ["api", "worker"]) {
  const parsed = configSchema.safeParse(services[name].environment);
  assert.ok(
    parsed.success,
    `${name} must accept its rendered environment: ${
      parsed.success
        ? ""
        : parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")
    }`,
  );
}
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
  generatedEnvironment.SERVICE_PASSWORD_64_DBMIGRATOR,
);
assert.equal(
  services.migrate.environment.MIGRATION_DATABASE_URL,
  `postgresql://orbit_migrator:${generatedEnvironment.SERVICE_PASSWORD_64_DBMIGRATOR}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.DATABASE_URL,
  `postgresql://orbit_app:${generatedEnvironment.SERVICE_PASSWORD_64_DBAPP}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.AUTH_DATABASE_URL,
  `postgresql://orbit_auth:${generatedEnvironment.SERVICE_PASSWORD_64_DBAUTH}@postgres:5432/orbit`,
);
assert.equal(
  services.api.environment.AUTH_SECRET,
  generatedEnvironment.SERVICE_REALBASE64_64_AUTHSECRET,
);
assert.equal(
  services.api.environment.CREDENTIAL_KEY,
  generatedEnvironment.SERVICE_HEX_64_CREDENTIALKEY,
);
assert.equal(
  services.api.environment.ORBIT_SETUP_TOKEN,
  generatedEnvironment.SERVICE_PASSWORD_64_ORBITSETUPTOKEN,
);
assert.equal(
  services.api.environment.APP_ORIGIN,
  generatedEnvironment.SERVICE_URL_WEB,
);
assert.equal(
  services.api.environment.PUBLISHER_INSTANCE_ID,
  generatedEnvironment.SERVICE_BASE64_32_PUBLISHERINSTANCE,
);
for (const name of ["api", "worker"]) {
  assert.equal(
    services[name].environment.GOOGLE_DRIVE_CLIENT_ID,
    "synthetic-google-client",
  );
  assert.equal(
    services[name].environment.GOOGLE_DRIVE_CLIENT_SECRET,
    "synthetic-google-secret",
  );
}

// Feature flags reach the API and the worker (Orbit Chat runs in the worker),
// default off, and follow the value set in Coolify.
for (const name of ["api", "worker"])
  for (const flag of [
    "ORBIT_CONTENT_PACKAGES",
    "ORBIT_TOOL_SEARCH",
    "ORBIT_AGENTS",
    "ORBIT_IMAGE_REFERENCES",
    "ORBIT_AGENT_REVIEW_AUTHORITY",
    "ORBIT_MODULES",
    "ORBIT_MODULE_ROLES",
    "ORBIT_PUBLIC_INGRESS",
    "ORBIT_SUPPORT",
    "ORBIT_FILES",
    "ORBIT_EMAIL",
    "ORBIT_NOTIFICATIONS",
    "ORBIT_REALTIME",
  ])
    assert.equal(
      services[name].environment[flag],
      "false",
      `${name} must receive ${flag}, off by default`,
    );
const flagged = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "config", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...composeEnvironment,
        ORBIT_CONTENT_PACKAGES: "true",
        ORBIT_TOOL_SEARCH: "true",
        ORBIT_AGENTS: "true",
        ORBIT_IMAGE_REFERENCES: "true",
        ORBIT_AGENT_REVIEW_AUTHORITY: "true",
        ORBIT_MODULES: "true",
        ORBIT_MCP_OAUTH: "true",
        ORBIT_MCP_DCR: "true",
        MCP_RESOURCE: "https://orbit.example.invalid/mcp",
        ORBIT_MCP_CIMD_HOSTS: "chatgpt.com,example.invalid",
        ORBIT_MODULE_ROLES: "true",
        ORBIT_PUBLIC_INGRESS: "true",
        ORBIT_SUPPORT: "true",
        ORBIT_FILES: "true",
        ORBIT_EMAIL: "true",
        ORBIT_NOTIFICATIONS: "true",
        ORBIT_REALTIME: "true",
      },
    },
  ),
).services;
for (const name of ["api", "worker"])
  for (const flag of [
    "ORBIT_CONTENT_PACKAGES",
    "ORBIT_TOOL_SEARCH",
    "ORBIT_AGENTS",
    "ORBIT_IMAGE_REFERENCES",
    "ORBIT_AGENT_REVIEW_AUTHORITY",
    "ORBIT_MODULES",
    "ORBIT_MODULE_ROLES",
    "ORBIT_PUBLIC_INGRESS",
    "ORBIT_SUPPORT",
    "ORBIT_FILES",
    "ORBIT_EMAIL",
    "ORBIT_NOTIFICATIONS",
    "ORBIT_REALTIME",
  ])
    assert.equal(
      flagged[name].environment[flag],
      "true",
      `${name} must follow ${flag} from the deployment environment`,
    );

// The MCP OAuth server (Track M WP-M1) is off by default, its resource falls
// back to the config default (empty), and CIMD discovery is limited to
// chatgpt.com until configured otherwise.
for (const name of ["api", "worker"]) {
  assert.equal(services[name].environment.ORBIT_MCP_OAUTH, "false");
  assert.equal(services[name].environment.ORBIT_MCP_DCR, "false");
  assert.equal(services[name].environment.MCP_RESOURCE, "");
  assert.equal(
    services[name].environment.ORBIT_MCP_CIMD_HOSTS,
    "chatgpt.com",
  );
  assert.equal(flagged[name].environment.ORBIT_MCP_OAUTH, "true");
  assert.equal(flagged[name].environment.ORBIT_MCP_DCR, "true");
  assert.equal(
    flagged[name].environment.MCP_RESOURCE,
    "https://orbit.example.invalid/mcp",
  );
  assert.equal(
    flagged[name].environment.ORBIT_MCP_CIMD_HOSTS,
    "chatgpt.com,example.invalid",
  );
}
// The file bucket and the backup bucket never share credentials (WP4.6).
for (const key of Object.keys(services.backup.environment))
  assert.ok(!key.startsWith("FILES_"), `backup must not receive ${key}`);
for (const name of ["api", "worker"])
  for (const key of Object.keys(services[name].environment))
    assert.ok(!key.startsWith("BACKUP_"), `${name} must not receive ${key}`);

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
for (const match of composeSource.matchAll(
  /\$\{(SERVICE_(?:PASSWORD|REALBASE64|HEX|BASE64)_[^}:]+)[}:]/g,
)) {
  const underscores = (match[1].match(/_/g) ?? []).length;
  assert.ok(
    underscores === 2 || underscores === 3,
    `${match[1]} cannot be generated by Coolify's SERVICE_* parser`,
  );
}

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
