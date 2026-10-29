import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["scripts/render-pve-compose.mjs", "--check"], {
  cwd: root,
  stdio: "inherit",
});
// Synthetic inputs only. Never load a developer or production .env.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ORBIT_RELEASE_APPROVAL: "synthetic-compose-validation",
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
function render(file) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "-f",
        file,
        "config",
        "--format",
        "json",
      ],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
}
const base = render("docker-compose.yml");
const pve = render("docker-compose.pve.yml");
assert.equal(
  (
    readFileSync(`${root}/docker-compose.pve.yml`, "utf8").match(
      /create_host_path: false/g,
    ) || []
  ).length,
  2,
);
assert.deepEqual(Object.keys(pve.services), Object.keys(base.services));
const hosts = Object.fromEntries(
  [
    "orbit.eds-labs.io",
    "n8n.eds-labs.io",
    "analytics.eds-labs.io",
    "analytics.uliquid.vip",
    "postiz.eds-labs.io",
  ].map((host) => [host, "10.50.0.12"]),
);
for (const [name, service] of Object.entries(pve.services)) {
  assert.ok(!service.ports?.length, `${name} must not publish host ports`);
  if (["postgres", "redis"].includes(name)) {
    assert.deepEqual(service.volumes, [
      {
        type: "bind",
        source: `/data/orbit-production/${name === "postgres" ? "pg" : "redis"}`,
        target: name === "postgres" ? "/var/lib/postgresql/data" : "/data",
        bind: {},
      },
    ]);
    service.volumes = base.services[name].volumes;
  }
  if (["migrate", "api", "worker", "mcp", "web"].includes(name)) {
    const actual = Array.isArray(service.extra_hosts)
      ? Object.fromEntries(service.extra_hosts.map((entry) => entry.split("=")))
      : service.extra_hosts;
    assert.deepEqual(actual, hosts);
    delete service.extra_hosts;
  }
  assert.deepEqual(
    service,
    base.services[name],
    `${name} must retain canonical builds, commands, environment, health, privileges and dependencies`,
  );
}
const missingApproval = { ...env };
delete missingApproval.ORBIT_RELEASE_APPROVAL;
const denied = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    "/dev/null",
    "-f",
    "docker-compose.pve.yml",
    "config",
    "--quiet",
  ],
  { cwd: root, env: missingApproval, encoding: "utf8" },
);
assert.notEqual(
  denied.status,
  0,
  "A missing release approval must block the Compose definition",
);
assert.match(denied.stderr, /ORBIT_RELEASE_APPROVAL/);
console.log(
  "PVE adapter preserves the canonical stack, existing data paths and release gate; no host ports",
);
