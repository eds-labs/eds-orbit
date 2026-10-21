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
  SERVICE_HEX_64_FILESKEY: "f".repeat(64),
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
  "ORBIT_MCP_GATEWAY",
  "MCP_PORT",
  "MCP_JWKS_URL",
  "ORBIT_MCP_ORIGIN",
  "ORBIT_MCP_ALLOWED_ORIGINS",
  "ORBIT_MCP_PROPOSALS",
  "ORBIT_MODULE_ROLES",
  "ORBIT_PUBLIC_INGRESS",
  "ORBIT_SUPPORT",
  "ORBIT_CUSTOMER_CONTEXT",
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
// The mcp service shares the API environment and must accept it too.
const apiLike = ["api", "worker", "mcp"];
for (const name of apiLike) {
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
for (const name of ["migrate", "api", "worker", "mcp", "web"]) {
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
for (const name of apiLike) {
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
for (const name of apiLike)
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
    "ORBIT_CUSTOMER_CONTEXT",
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
        ORBIT_MCP_GATEWAY: "true",
        MCP_PORT: "4400",
        MCP_JWKS_URL: "http://api.internal:4311/api/auth/jwks",
        ORBIT_MCP_ORIGIN: "http://mcp.internal:4312",
        ORBIT_MCP_ALLOWED_ORIGINS: "https://client.example.invalid",
        ORBIT_MCP_PROPOSALS: "true",
        ORBIT_MODULE_ROLES: "true",
        ORBIT_PUBLIC_INGRESS: "true",
        ORBIT_SUPPORT: "true",
        ORBIT_CUSTOMER_CONTEXT: "true",
        ORBIT_FILES: "true",
        ORBIT_EMAIL: "true",
        ORBIT_NOTIFICATIONS: "true",
        ORBIT_REALTIME: "true",
      },
    },
  ),
).services;
for (const name of apiLike)
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
    "ORBIT_CUSTOMER_CONTEXT",
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
for (const name of apiLike) {
  assert.equal(services[name].environment.ORBIT_MCP_OAUTH, "false");
  assert.equal(services[name].environment.ORBIT_MCP_DCR, "false");
  assert.equal(services[name].environment.MCP_RESOURCE, "");
  assert.equal(services[name].environment.ORBIT_MCP_CIMD_HOSTS, "chatgpt.com");
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
// The MCP gateway flag (WP-M2) is off by default with port 4312, no allowed
// browser origins and no JWKS override; the deployment environment overrides
// all of them for api and worker. The mcp service pins its port and defaults
// the key set to the internal API (WP-M5).
for (const name of ["api", "worker"]) {
  assert.equal(services[name].environment.ORBIT_MCP_GATEWAY, "false");
  assert.equal(services[name].environment.MCP_PORT, "4312");
  assert.equal(services[name].environment.MCP_JWKS_URL, "");
  assert.equal(services[name].environment.ORBIT_MCP_ALLOWED_ORIGINS, "");
  assert.equal(flagged[name].environment.ORBIT_MCP_GATEWAY, "true");
  assert.equal(flagged[name].environment.MCP_PORT, "4400");
  assert.equal(
    flagged[name].environment.MCP_JWKS_URL,
    "http://api.internal:4311/api/auth/jwks",
  );
  assert.equal(
    flagged[name].environment.ORBIT_MCP_ALLOWED_ORIGINS,
    "https://client.example.invalid",
  );
}

// The mcp service (Track M WP-M5, D-M5-1/2): the API image and environment
// with the gateway flags off, the gateway entrypoint, an internal key set
// URL, one path-routed Coolify URL, and the same networks as the API.
const mcp = services.mcp;
assert.ok(mcp, "the mcp service must exist");
assert.deepEqual(mcp.command, [
  "node_modules/.bin/tsx",
  "apps/api/src/mcp-main.ts",
]);
assert.equal(mcp.image, services.api.image);
assert.equal(mcp.environment.ORBIT_MCP_GATEWAY, "false");
assert.equal(mcp.environment.ORBIT_MCP_OAUTH, "false");
assert.equal(mcp.environment.ORBIT_MCP_PROPOSALS, "false");
assert.equal(mcp.environment.MCP_PORT, "4312");
assert.equal(mcp.environment.MCP_JWKS_URL, "http://api:4311/api/auth/jwks");
assert.equal(mcp.environment.SERVICE_URL_MCP_4312, "/mcp");
assert.equal(flagged.mcp.environment.ORBIT_MCP_GATEWAY, "true");
assert.equal(flagged.mcp.environment.ORBIT_MCP_OAUTH, "true");
assert.equal(flagged.mcp.environment.MCP_PORT, "4312", "the port is pinned");
assert.equal(
  flagged.mcp.environment.MCP_JWKS_URL,
  "http://api.internal:4311/api/auth/jwks",
);
assert.equal(
  mcp.environment.DATABASE_URL,
  services.api.environment.DATABASE_URL,
);
assert.deepEqual(
  Object.keys(mcp.networks).sort(),
  ["database", "egress", "frontend"],
  "mcp needs frontend (Coolify routing), database and egress (CIMD metadata)",
);
assert.deepEqual(Object.keys(mcp.depends_on), ["api"]);
assert.equal(mcp.depends_on.api.condition, "service_healthy");
assert.deepEqual(
  mcp.expose,
  ["4312"],
  "the gateway is reached through the proxy only",
);
assert.equal(mcp.ports, undefined, "the gateway publishes no host port");
assert.equal(
  mcp.stop_grace_period,
  "15s",
  "mcp must outlast the gateway's 10 s forced-exit timeout before SIGKILL",
);
assert.equal(mcp.healthcheck.test[0], "CMD");
assert.match(mcp.healthcheck.test.join(" "), /127\.0\.0\.1:4312\/healthz/);
// The health check probes loopback, so it cannot see a loopback-only bind;
// assert the bind host directly (web and Traefik reach mcp over the network).
for (const rendered of [mcp, flagged.mcp])
  assert.equal(
    rendered.environment.BIND_HOST,
    "0.0.0.0",
    "mcp must bind all interfaces so web and Traefik can reach it",
  );
for (const name of Object.keys(services))
  if (name !== "mcp")
    assert.equal(
      services[name].environment?.SERVICE_URL_MCP_4312,
      undefined,
      `${name} must not carry the mcp routing variable`,
    );
// Only web gets a Coolify URL besides mcp (Traefik routes by domain/path).
for (const name of Object.keys(services))
  for (const key of Object.keys(services[name].environment ?? {}))
    if (key.startsWith("SERVICE_URL_"))
      assert.ok(
        (name === "web" && key === "SERVICE_URL_WEB_4310") ||
          (name === "mcp" && key === "SERVICE_URL_MCP_4312"),
        `${name} must not declare ${key}`,
      );
// The web app reaches the gateway internally for the protected resource
// metadata paths (D-M5-4); the deployment environment can move it.
assert.equal(services.web.environment.ORBIT_MCP_ORIGIN, "http://mcp:4312");
assert.equal(services.web.environment.ORBIT_API_ORIGIN, "http://api:4311");
assert.equal(
  flagged.web.environment.ORBIT_MCP_ORIGIN,
  "http://mcp.internal:4312",
);
// MCP proposals (WP-M4) are off by default; the deployment environment turns
// them on for api, worker and the mcp service.
for (const name of apiLike) {
  assert.equal(services[name].environment.ORBIT_MCP_PROPOSALS, "false");
  assert.equal(flagged[name].environment.ORBIT_MCP_PROPOSALS, "true");
}
// The file key is generated by Coolify and reaches api and worker (WP4.6).
for (const name of apiLike)
  assert.equal(
    services[name].environment.FILES_ENCRYPTION_KEY,
    generatedEnvironment.SERVICE_HEX_64_FILESKEY,
    `${name} must receive the generated file key`,
  );
// The file bucket and the backup bucket never share credentials (WP4.6).
for (const key of Object.keys(services.backup.environment))
  assert.ok(!key.startsWith("FILES_"), `backup must not receive ${key}`);
for (const name of apiLike)
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
