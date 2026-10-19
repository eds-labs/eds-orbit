import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  buildDisabledMcpApp,
  createMcpGatewayProcess,
} from "../src/platform/mcp/bootstrap.ts";
import { mcpGatewayEnabled } from "../src/platform/mcp/gateway-guard.ts";

// Track M WP-M5, D-M5-1: with a flag off the gateway process stays up as a
// health-only app (no auth, no database, no tool work) so a compose service
// never crash-loops on a disabled flag.

const flags = (gateway: string, oauth: string) => ({
  ORBIT_MCP_GATEWAY: gateway,
  ORBIT_MCP_OAUTH: oauth,
});
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });

describe("MCP_JWKS_URL config (D-M5-5)", () => {
  const saved = process.env.MCP_JWKS_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_JWKS_URL;
    else process.env.MCP_JWKS_URL = saved;
  });
  it("is unset when empty, a URL when set, and invalid values fail", () => {
    delete process.env.MCP_JWKS_URL;
    expect(loadConfig().MCP_JWKS_URL).toBeUndefined();
    process.env.MCP_JWKS_URL = "";
    expect(loadConfig().MCP_JWKS_URL).toBeUndefined();
    process.env.MCP_JWKS_URL = "http://api:4311/api/auth/jwks";
    expect(loadConfig().MCP_JWKS_URL).toBe("http://api:4311/api/auth/jwks");
    process.env.MCP_JWKS_URL = "not a url";
    expect(() => loadConfig()).toThrow();
  });
});

describe("mcpGatewayEnabled", () => {
  it('is true only when both flags are "true"', () => {
    expect(mcpGatewayEnabled(flags("true", "true") as never)).toBe(true);
    expect(mcpGatewayEnabled(flags("true", "false") as never)).toBe(false);
    expect(mcpGatewayEnabled(flags("false", "true") as never)).toBe(false);
    expect(mcpGatewayEnabled(flags("false", "false") as never)).toBe(false);
  });
});

describe("disabled gateway app", () => {
  it("answers /healthz with status disabled and 404 for everything else", async () => {
    const app = await buildDisabledMcpApp();
    apps.push(app);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "disabled" });
    const reference = await app.inject({ method: "GET", url: "/nothing" });
    expect(reference.statusCode).toBe(404);
    const bodies: (string | Buffer)[] = [
      "{}",
      "{", // invalid JSON
      JSON.stringify({ pad: "x".repeat(5 * 1024) }), // over the 1 KB limit
      "x".repeat(300 * 1024),
      "",
    ];
    const contentTypes = [
      "application/json",
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/octet-stream",
      "multipart/form-data; boundary=x",
      "application/not-a-known-type",
    ];
    for (const [method, url] of [
      ["POST", "/mcp"],
      ["POST", "/"],
      ["PUT", "/mcp"],
      ["PATCH", "/"],
      ["GET", "/mcp"],
      ["GET", "/"],
      ["DELETE", "/mcp"],
      ["OPTIONS", "/mcp"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["POST", "/healthz"],
      ["PUT", "/healthz"],
      ["DELETE", "/healthz"],
      ["GET", "/healthz/extra"],
    ] as const)
      for (const contentType of contentTypes)
        for (const payload of bodies) {
          const response = await app.inject({
            method,
            url,
            headers: { "content-type": contentType, authorization: "Bearer x" },
            ...(method === "GET" || method === "DELETE" ? {} : { payload }),
          });
          const label = `${method} ${url} ${contentType} ${payload.length}`;
          expect(`${label} ${response.statusCode}`).toBe(`${label} 404`);
          // Identical to a plain unknown path: no framework error body.
          expect(response.body).toBe(reference.body);
          expect(response.headers["content-type"]).toBe(
            reference.headers["content-type"],
          );
        }
    // The health check ignores query strings and stays GET/HEAD only.
    expect(
      (await app.inject({ method: "GET", url: "/healthz?x=1" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "HEAD", url: "/healthz" })).statusCode,
    ).toBe(200);
  });
});

describe("createMcpGatewayProcess", () => {
  const config = (gateway: string, oauth: string) =>
    ({ ...flags(gateway, oauth) }) as ReturnType<typeof loadConfig>;

  for (const [gateway, oauth] of [
    ["false", "false"],
    ["false", "true"],
    ["true", "false"],
  ] as const)
    it(`never loads auth, the database or the SDK server with gateway=${gateway} oauth=${oauth}`, async () => {
      const loadEnabled = vi.fn();
      const built = await createMcpGatewayProcess(config(gateway, oauth), {
        loadEnabled,
      });
      apps.push(built.app);
      expect(loadEnabled).not.toHaveBeenCalled();
      expect(built.mode).toBe("disabled");
      // No database to close: the disabled path never opened one.
      expect(built.closers).toEqual([]);
      const health = await built.app.inject({ method: "GET", url: "/healthz" });
      expect(health.json()).toEqual({ status: "disabled" });
    });

  it("loads the real gateway only when both flags are true", async () => {
    const close = vi.fn(async () => undefined);
    const { buildDisabledMcpApp: stub } =
      await import("../src/platform/mcp/bootstrap.ts");
    const fakeApp = await stub();
    apps.push(fakeApp);
    const loadEnabled = vi.fn(async () => ({ app: fakeApp, closers: [close] }));
    const built = await createMcpGatewayProcess(config("true", "true"), {
      loadEnabled,
    });
    expect(loadEnabled).toHaveBeenCalledTimes(1);
    expect(built.mode).toBe("enabled");
    expect(built.app).toBe(fakeApp);
    expect(built.closers).toEqual([close]);
  });
});

describe("mcp-main.ts process, gateway disabled", () => {
  it("serves /healthz disabled without touching the database and stops on SIGTERM", async () => {
    const port = await freePort();
    // Nothing listens on these; a process that opened a database pool or
    // started auth would fail or hang instead of answering.
    const dead = "postgresql://nobody:nopass@127.0.0.1:1/none";
    const child = spawn(
      resolve("node_modules/.bin/tsx"),
      ["apps/api/src/mcp-main.ts"],
      {
        env: {
          ...process.env,
          ORBIT_MCP_GATEWAY: "false",
          ORBIT_MCP_OAUTH: "true",
          DATABASE_URL: dead,
          AUTH_DATABASE_URL: dead,
          MCP_PORT: String(port),
          BIND_HOST: "127.0.0.1",
          LOG_LEVEL: "silent",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error("no start")), 60_000);
        child.stdout!.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("listening")) {
            clearTimeout(timer);
            done();
          }
        });
        child.once("exit", (code) =>
          fail(new Error(`exited ${code}: ${stderr}`)),
        );
      });
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "disabled" });
      expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(404);
      const exited = new Promise<number | null>((done) =>
        child.once("exit", (code) => done(code)),
      );
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 90_000);
});
