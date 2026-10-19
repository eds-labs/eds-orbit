import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { registerModules } from "../src/modules/registry.ts";
import { buildDisabledMcpApp } from "../src/platform/mcp/bootstrap.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  CONFORMANCE_REVISIONS,
  conformancePassed,
  formatResults,
  runConformance,
  type CheckResult,
  type ConformanceOptions,
} from "../../../scripts/mcp-conformance.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// WP-M5 Task 5 (D-M5-10): the conformance checks of scripts/mcp-smoke.ts,
// run over real HTTP against an in-process gateway with a real WP-M1 access
// token, for both protocol revisions. The same functions drive a deployed
// gateway in the rollout runbook (docs/deployment/MCP_ROLLOUT.md).

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const CLIENT = "https://client.test/conformance.json";
const cimdFetch = cimdFetchFor({ [CLIENT]: metadata(CLIENT) });
const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;

async function withFlags<T>(run: () => Promise<T>): Promise<T> {
  const keys = Object.keys(FLAGS) as (keyof typeof FLAGS)[];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, FLAGS);
  try {
    return await run();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

const listenOn = async (app: FastifyInstance) => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
};

const byStatus = (results: CheckResult[], status: CheckResult["status"]) =>
  results.filter((r) => r.status === status).map((r) => r.name);

/** The checks every revision runs with a token. */
const PER_REVISION = [
  "discovery",
  "tools/list",
  "tools/call orbit_projects",
  "tools/call search",
  "unknown tool",
];

/** Runs scripts/mcp-smoke.ts as a child process with the given environment. */
function smoke(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(
      process.execPath,
      [resolve("scripts/mcp-smoke.ts"), ...args],
      {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}

describe.skipIf(!enabled)("MCP conformance (D-M5-10)", () => {
  let api: Awaited<ReturnType<typeof buildServer>>;
  let gateway: FastifyInstance;
  let disabled: FastifyInstance;
  let config: ReturnType<typeof loadConfig>;
  let gatewayOrigin = "";
  let disabledOrigin = "";
  let cookie = "";
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let userId = "";

  const driver = createFlowDriver({
    app: () => api,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({ workspaceId, projectIds: [projectId] }),
    defaultClientId: CLIENT,
  });

  /** The gateway as a deployment would be checked: endpoint, PRM origin, health URL. */
  const target = (
    overrides: Partial<ConformanceOptions> = {},
  ): ConformanceOptions => ({
    url: `${gatewayOrigin}/mcp`,
    token,
    // The gateway serves both PRM paths itself; in production the web origin does.
    webUrl: gatewayOrigin,
    resource: config.MCP_RESOURCE,
    healthUrl: `${gatewayOrigin}/healthz`,
    ...overrides,
  });

  beforeAll(async () => {
    await withFlags(async () => {
      config = loadConfig();
      api = await buildServer(undefined, { cimdFetch });
      const jwksUrl = `${await listenOn(api)}/api/auth/jwks`;
      // Every check shares 127.0.0.1; the per-address limit is not under test.
      gateway = await buildMcpServer({
        cimdFetch,
        jwksUrl,
        rateLimits: { unauthenticatedPerIp: 10_000 },
      });
      gatewayOrigin = await listenOn(gateway);
    });
    disabled = await buildDisabledMcpApp();
    disabledOrigin = await listenOn(disabled);

    await authDb.oauthClient.deleteMany({ where: { clientId: CLIENT } });
    const auth = makeAuth({ cimdFetch });
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await auth.api.signUpEmail({
      body: { email, name: "Synthetic conformance editor", password },
    });
    userId = created.user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic conformance workspace",
        members: { create: [{ userId, role: "owner" }] },
        projects: {
          create: [
            {
              name: "Conformance",
              members: { create: [{ userId, role: "editor" }] },
            },
          ],
        },
      },
      include: { projects: true },
    });
    workspaceId = workspace.id;
    projectId = workspace.projects[0]!.id;

    const signIn = await driver.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      session: false,
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set!])
      .map((v) => v.split(";")[0])
      .join("; ");
    const flow = await driver.connect();
    const exchanged = await driver.exchange(flow);
    expect(exchanged.statusCode).toBe(200);
    token = (exchanged.json() as Json).access_token as string;
  });

  afterAll(async () => {
    await gateway?.close();
    await disabled?.close();
    await api?.close();
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.oauthClient.deleteMany({ where: { clientId: CLIENT } });
    if (userId) await authDb.user.deleteMany({ where: { id: userId } });
    await closeDatabase();
  });

  it("passes every check for both revisions with a token", async () => {
    const results = await runConformance(target());
    expect(byStatus(results, "fail")).toEqual([]);
    expect(byStatus(results, "skip")).toEqual([]);
    expect(conformancePassed(results)).toBe(true);
    const names = results.map((r) => r.name);
    expect(CONFORMANCE_REVISIONS).toEqual(["2026-07-28", "2025-11-25"]);
    for (const revision of CONFORMANCE_REVISIONS)
      for (const check of PER_REVISION)
        expect(names).toContain(`${revision} ${check}`);
    for (const check of [
      "healthz",
      "prm /.well-known/oauth-protected-resource",
      "prm /.well-known/oauth-protected-resource/mcp",
      "401 challenge without a token",
      "401 challenge with an invalid token",
      "GET is 405",
      "batch is refused",
    ])
      expect(names).toContain(check);
  });

  it("without a token runs the unauthenticated checks and skips the rest", async () => {
    const results = await runConformance(target({ token: undefined }));
    expect(byStatus(results, "fail")).toEqual([]);
    expect(byStatus(results, "pass")).toEqual([
      "healthz",
      "prm /.well-known/oauth-protected-resource",
      "prm /.well-known/oauth-protected-resource/mcp",
      "401 challenge without a token",
      "401 challenge with an invalid token",
      "GET is 405",
    ]);
    expect(byStatus(results, "skip")).toHaveLength(
      1 + PER_REVISION.length * CONFORMANCE_REVISIONS.length,
    );
    expect(conformancePassed(results)).toBe(true);
  });

  it("skips the health and PRM checks when their URLs are not given", async () => {
    const results = await runConformance(
      target({ webUrl: undefined, healthUrl: undefined }),
    );
    expect(byStatus(results, "fail")).toEqual([]);
    expect(byStatus(results, "skip")).toEqual([
      "healthz",
      "prm /.well-known/oauth-protected-resource",
      "prm /.well-known/oauth-protected-resource/mcp",
    ]);
  });

  it("search can be left out (it may spend a query embedding in production)", async () => {
    const results = await runConformance(target({ search: false }));
    expect(byStatus(results, "fail")).toEqual([]);
    expect(byStatus(results, "skip")).toEqual(
      CONFORMANCE_REVISIONS.map((r) => `${r} tools/call search`),
    );
  });

  it("an invalid token fails every authenticated check", async () => {
    const results = await runConformance(target({ token: "not-a-real-token" }));
    expect(conformancePassed(results)).toBe(false);
    expect(byStatus(results, "fail")).toEqual([
      "batch is refused",
      ...CONFORMANCE_REVISIONS.flatMap((r) =>
        PER_REVISION.map((c) => `${r} ${c}`),
      ),
    ]);
  });

  it("a wrong expected resource fails the PRM and challenge checks", async () => {
    const results = await runConformance(
      target({ resource: "https://other.example/mcp" }),
    );
    expect(byStatus(results, "fail")).toEqual([
      "prm /.well-known/oauth-protected-resource",
      "prm /.well-known/oauth-protected-resource/mcp",
      "401 challenge without a token",
      "401 challenge with an invalid token",
    ]);
  });

  it("the disabled gateway passes the disabled-mode checks and fails the enabled ones", async () => {
    const options = {
      url: `${disabledOrigin}/mcp`,
      webUrl: disabledOrigin,
      healthUrl: `${disabledOrigin}/healthz`,
      resource: config.MCP_RESOURCE,
    };
    const off = await runConformance({ ...options, mode: "disabled" });
    expect(byStatus(off, "fail")).toEqual([]);
    expect(byStatus(off, "pass")).toEqual([
      "healthz",
      "prm /.well-known/oauth-protected-resource",
      "prm /.well-known/oauth-protected-resource/mcp",
      "POST is 404",
      "GET is 404",
    ]);
    const asEnabled = await runConformance({ ...options, token });
    expect(conformancePassed(asEnabled)).toBe(false);
    expect(byStatus(asEnabled, "pass")).toEqual([]);
    // ... and the enabled gateway fails the disabled-mode checks.
    const live = await runConformance({ ...target(), mode: "disabled" });
    expect(byStatus(live, "pass")).toEqual([]);
  });

  it("never reports the token, also when a request fails", async () => {
    const leaking = (async () => {
      throw new TypeError(`connect failed for Bearer ${token}`);
    }) as typeof fetch;
    const results = await runConformance(target({ fetch: leaking }));
    expect(conformancePassed(results)).toBe(false);
    const report = formatResults(results);
    expect(report).toContain("FAIL");
    expect(report).toContain("TypeError");
    expect(report).not.toContain(token);
    expect(formatResults(await runConformance(target()))).not.toContain(token);
  });

  it("the REST API refuses an MCP access token (09 §9: audience binding)", async () => {
    // The token is valid right now: the gateway accepts it (so the 401s
    // below do not depend on the order of the tests in this file).
    const listed = await fetch(`${gatewayOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('"orbit_projects"');
    // The member API authenticates by session cookie only; a valid MCP
    // bearer token without a cookie is no credential there.
    for (const url of ["/api/me", "/api/projects", "/api/mcp-grants"]) {
      const response = await driver.inject({
        url,
        session: false,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, url).toBe(401);
      expect(response.body).not.toContain(projectId);
    }
    // Control: the same routes answer the member's session.
    const me = await driver.inject({ url: "/api/me" });
    expect(me.statusCode).toBe(200);
  });

  it("refuses to send a token over plain HTTP to a non-loopback host", async () => {
    await expect(
      runConformance({ url: "http://orbit.example/mcp", token }),
    ).rejects.toThrow(/https/);
  });

  it("mcp-smoke.ts exits 0 on a passing gateway and 1 on a failing one, never printing the token", async () => {
    const env = {
      MCP_SMOKE_URL: `${gatewayOrigin}/mcp`,
      MCP_SMOKE_TOKEN: token,
      MCP_SMOKE_WEB_URL: gatewayOrigin,
      MCP_SMOKE_RESOURCE: config.MCP_RESOURCE,
      MCP_SMOKE_HEALTH_URL: `${gatewayOrigin}/healthz`,
    };
    const passing = await smoke(env);
    expect(passing.out).not.toContain(token);
    expect(passing.out).toMatch(/^PASS 2026-07-28 tools\/call search/m);
    expect(passing.out).toMatch(/^RESULT PASS/m);
    expect(passing.code).toBe(0);

    const failing = await smoke({
      ...env,
      MCP_SMOKE_URL: `${disabledOrigin}/mcp`,
    });
    expect(failing.out).not.toContain(token);
    expect(failing.out).toMatch(/^FAIL /m);
    expect(failing.out).toMatch(/^RESULT FAIL/m);
    expect(failing.code).toBe(1);

    const off = await smoke(
      {
        MCP_SMOKE_URL: `${disabledOrigin}/mcp`,
        MCP_SMOKE_HEALTH_URL: `${disabledOrigin}/healthz`,
      },
      ["--disabled"],
    );
    expect(off.out).toMatch(/^RESULT PASS/m);
    expect(off.code).toBe(0);

    const missing = await smoke({});
    expect(missing.out).toContain("MCP_SMOKE_URL");
    expect(missing.code).toBe(2);
  });
});
