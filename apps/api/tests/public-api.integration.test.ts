import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { buildServer } from "../src/server.ts";
import { list } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import {
  createPublicKey,
  publicApiModules,
  revokePublicKey,
} from "../src/platform/http/public-api.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const SITE = "https://widget.example.com";

/**
 * A module's public API (WP4.2b): browsers on a key's allowed origins open
 * a session and call the module's routes with its bearer token. Every
 * rejection path is covered; no cookie and no credentialed CORS is used.
 */
describe.skipIf(!enabled)("public module API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let publicKey = "";
  const workspaces: string[] = [];
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const call = (
    method: "GET" | "POST" | "OPTIONS",
    path: string,
    options: {
      key?: string;
      module?: string;
      origin?: string | null;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.inject({
      method,
      url: `/api/public/${options.module ?? "tasks"}/${options.key ?? publicKey}${path}`,
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? SITE }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(method === "POST"
        ? { payload: JSON.stringify(options.body ?? {}) }
        : {}),
    });
  const session = async () => {
    const response = await call("POST", "/session");
    expect(response.statusCode).toBe(201);
    return response.json() as { sessionId: string; token: string };
  };

  beforeAll(async () => {
    app = await buildServer();
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic public API" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic public API" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    publicKey = (
      await createPublicKey(owner, {
        moduleId: "tasks",
        allowedOrigins: [SITE],
      })
    ).publicKey;
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterEach(() => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
    delete process.env.ORBIT_MODULES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await app?.close();
    await closeDatabase();
  });

  it("does not exist while the flag is off", async () => {
    expect((await call("POST", "/session")).statusCode).toBe(404);
  });

  it("issues keys only for modules with a public API, only to owners, with clean origins", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    // The owner UI offers exactly these modules.
    expect(publicApiModules()).toEqual(["tasks"]);
    await expect(
      createPublicKey(owner, { moduleId: "marketing", allowedOrigins: [SITE] }),
    ).rejects.toThrow("MODULE_HAS_NO_PUBLIC_API");
    await expect(
      createPublicKey(
        { ...owner, role: "editor" },
        {
          moduleId: "tasks",
          allowedOrigins: [SITE],
        },
      ),
    ).rejects.toThrow("OWNER_REQUIRED");
    for (const bad of [
      "http://widget.example.com",
      "https://widget.example.com/path",
      "*",
    ])
      await expect(
        createPublicKey(owner, { moduleId: "tasks", allowedOrigins: [bad] }),
      ).rejects.toThrow();
  });

  it("answers 404 for an unknown key, a key of another module and a revoked key", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    expect(
      (await call("POST", "/session", { key: `pk_${"x".repeat(32)}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("POST", "/session", { module: "marketing" })).statusCode,
    ).toBe(404);
    const spare = await createPublicKey(owner, {
      moduleId: "tasks",
      allowedOrigins: [SITE],
    });
    await revokePublicKey(owner, spare.id);
    expect(
      (await call("POST", "/session", { key: spare.publicKey })).statusCode,
    ).toBe(404);
  });

  it("allows the key's origins only, never with credentials, and answers their preflight", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const foreign = await call("POST", "/session", {
      origin: "https://evil.example",
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      await run((tx) =>
        tx.auditEvent.count({ where: { action: "public.origin_rejected" } }),
      ),
    ).toBe(1);

    const allowed = await call("POST", "/session");
    expect(allowed.statusCode).toBe(201);
    expect(allowed.headers["access-control-allow-origin"]).toBe(SITE);
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(allowed.headers.vary).toContain("Origin");

    const preflight = await call("OPTIONS", "/requests", {
      headers: { "access-control-request-method": "POST" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(SITE);
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
    const foreignPreflight = await call("OPTIONS", "/requests", {
      origin: "https://evil.example",
    });
    expect(foreignPreflight.statusCode).toBe(403);
    // A server without Origin may call too; it still needs a token.
    expect((await call("POST", "/session", { origin: null })).statusCode).toBe(
      201,
    );
  });

  it("needs a valid, unexpired bearer token of this key", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const missing = await call("POST", "/requests", { body: { title: "Hi" } });
    expect(missing.statusCode).toBe(401);
    const wrong = await call("POST", "/requests", {
      token: "A".repeat(43),
      body: { title: "Hi" },
    });
    expect(wrong.statusCode).toBe(401);
    // An Orbit session cookie is never read here.
    const cookie = await call("POST", "/requests", {
      headers: { cookie: "orbit.session_token=synthetic" },
      body: { title: "Hi" },
    });
    expect(cookie.statusCode).toBe(401);

    const { token, sessionId } = await session();
    const created = await call("POST", "/requests", {
      token,
      body: { title: "Visitor request" },
    });
    expect(created.statusCode).toBe(200);
    // The token is stored only as a hash.
    const [stored] = (
      await run((tx) => list(tx, owner, "public_sessions"))
    ).filter((row) => row.id === sessionId);
    expect(JSON.stringify(stored!.data)).not.toContain(token);
    const mine = await call("GET", "/requests", { token });
    expect(mine.json().items).toEqual([
      { id: created.json().id, title: "Visitor request" },
    ]);
    // Another session does not see it.
    const other = await session();
    expect(
      (await call("GET", "/requests", { token: other.token })).json().items,
    ).toEqual([]);
    // Expired.
    await run((tx) =>
      tx.entity.update({
        where: { id: sessionId },
        data: {
          data: {
            ...(stored!.data as object),
            expiresAt: new Date(0).toISOString(),
          },
        },
      }),
    );
    expect((await call("GET", "/requests", { token })).statusCode).toBe(401);
  });

  it("rate-limits each session on its own", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const { token } = await session();
    const codes: number[] = [];
    for (let i = 0; i < 125; i++)
      codes.push((await call("GET", "/requests", { token })).statusCode);
    expect(codes.slice(0, 120).every((code) => code === 200)).toBe(true);
    expect(codes.slice(120).every((code) => code === 429)).toBe(true);
    const fresh = await session();
    expect(
      (await call("GET", "/requests", { token: fresh.token })).statusCode,
    ).toBe(200);
  });

  it("is switched off with its module", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    process.env.ORBIT_MODULES = "true";
    await run((tx) =>
      setModuleEnabled(tx, owner, moduleRegistry(), "tasks", false),
    );
    const response = await call("POST", "/session");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MODULE_DISABLED");
    await run((tx) =>
      setModuleEnabled(tx, owner, moduleRegistry(), "tasks", true),
    );
  });
});
