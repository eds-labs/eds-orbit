import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** Module activation per project (WP1.4): recorded and switchable, not yet enforced. */
describe.skipIf(!enabled)("Module activation API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const users: string[] = [];
  const workspaces: string[] = [];
  const cookies: Record<string, string> = {};
  let workspaceId: string, projectId: string;
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    role: string,
    method: "GET" | "PUT" | "POST",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin,
        cookie: cookies[role] ?? "",
        [CLIENT_IP_HEADER]: ip(),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const modules = (response: { json(): any }) =>
    Object.fromEntries(
      (
        response.json().modules as Array<{
          id: string;
          enabled: boolean;
          explicit: boolean;
        }>
      ).map((m) => [m.id, { enabled: m.enabled, explicit: m.explicit }]),
    );
  const put = (role: string, moduleId: string, value: boolean) =>
    call(role, "PUT", `/api/projects/${projectId}/modules/${moduleId}`, {
      enabled: value,
    });

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const accounts: Record<string, { id: string; email: string }> = {};
    for (const role of ["owner", "editor", "viewer", "outsider"]) {
      const email = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: { email, name: `Synthetic module ${role}`, password },
      });
      users.push(created.user.id);
      accounts[role] = { id: created.user.id, email };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic module activation",
        members: {
          create: [
            { userId: accounts.owner!.id, role: "owner" },
            { userId: accounts.editor!.id, role: "viewer" },
            { userId: accounts.viewer!.id, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    workspaceId = workspace.id;
    const elsewhere = await authDb.workspace.create({
      data: {
        name: "Synthetic module outsider",
        members: { create: { userId: accounts.outsider!.id, role: "owner" } },
      },
    });
    workspaces.push(elsewhere.id);
    for (const role of Object.keys(accounts)) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email: accounts[role]!.email, password },
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[role] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
    // Created through the API, so its default modules are recorded like a real project's.
    const created = await call("owner", "POST", "/api/projects", {
      name: "Synthetic modules",
      workspaceId,
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id;
    for (const [role, userId] of [
      ["editor", accounts.editor!.id],
      ["viewer", accounts.viewer!.id],
    ] as const)
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId, role },
      });
  });
  afterEach(() => {
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_SUPPORT;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("records the registry defaults for a new project", async () => {
    const response = await call(
      "viewer",
      "GET",
      `/api/projects/${projectId}/modules`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().switchable).toBe(false);
    expect(response.json().modules.map((m: { id: string }) => m.id)).toEqual([
      "knowledge",
      "marketing",
    ]);
    expect(modules(response)).toEqual({
      knowledge: { enabled: true, explicit: true },
      marketing: { enabled: true, explicit: true },
    });
  });

  it("advertises the current agents feature without granting module access", async () => {
    const previous = process.env.ORBIT_AGENTS;
    try {
      for (const enabled of [false, true]) {
        process.env.ORBIT_AGENTS = String(enabled);
        const response = await call(
          "viewer",
          "GET",
          `/api/projects/${projectId}/modules`,
        );
        expect(response.statusCode).toBe(200);
        expect(response.json().features.agents).toBe(enabled);
        expect(modules(response).marketing?.enabled).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env.ORBIT_AGENTS;
      else process.env.ORBIT_AGENTS = previous;
    }
  });

  it("hides the project's modules from non-members and callers without a session", async () => {
    expect(
      (await call("outsider", "GET", `/api/projects/${projectId}/modules`))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("anonymous", "GET", `/api/projects/${projectId}/modules`))
        .statusCode,
    ).toBe(401);
  });

  it("lets only owners switch, and only while ORBIT_MODULES is on", async () => {
    expect((await put("owner", "marketing", false)).statusCode).toBe(404);
    process.env.ORBIT_MODULES = "true";
    expect((await put("editor", "marketing", false)).statusCode).toBe(403);
    expect((await put("viewer", "marketing", false)).statusCode).toBe(403);
    expect((await put("outsider", "marketing", false)).statusCode).toBe(404);
    expect((await put("owner", "unknown", false)).json().error.code).toBe(
      "MODULE_NOT_FOUND",
    );
    expect(
      (
        await call(
          "owner",
          "PUT",
          `/api/projects/${projectId}/modules/marketing`,
          { enabled: "no" },
        )
      ).statusCode,
    ).toBe(400);
  });

  it("keeps dependencies consistent and audits every change", async () => {
    process.env.ORBIT_MODULES = "true";
    const refused = await put("owner", "knowledge", false);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("MODULE_REQUIRED");

    const off = await put("owner", "marketing", false);
    expect(off.statusCode).toBe(200);
    expect(modules(off).marketing).toEqual({ enabled: false, explicit: true });
    // Repeating the same choice changes and audits nothing.
    expect((await put("owner", "marketing", false)).statusCode).toBe(200);

    expect((await put("owner", "knowledge", false)).statusCode).toBe(200);
    const blocked = await put("owner", "marketing", true);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("MODULE_DEPENDENCY_DISABLED");
    expect((await put("owner", "knowledge", true)).statusCode).toBe(200);
    const on = await put("owner", "marketing", true);
    expect(modules(on)).toEqual({
      knowledge: { enabled: true, explicit: true },
      marketing: { enabled: true, explicit: true },
    });

    const events = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { workspaceId, projectId, action: { startsWith: "module." } },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(events.map((e) => `${e.action} ${e.resourceId}`)).toEqual([
      "module.disabled marketing",
      "module.disabled knowledge",
      "module.enabled knowledge",
      "module.enabled marketing",
    ]);
  });

  it("never deletes a module's row", async () => {
    process.env.ORBIT_MODULES = "true";
    await put("owner", "marketing", false);
    const rows = await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.findMany({
        where: { workspaceId, projectId },
        orderBy: { moduleId: "asc" },
      }),
    );
    expect(rows.map((r) => [r.moduleId, r.enabled])).toEqual([
      ["knowledge", true],
      ["marketing", false],
    ]);
    await put("owner", "marketing", true);
  });

  it("offers support only while ORBIT_SUPPORT is on, and off by default", async () => {
    process.env.ORBIT_MODULES = "true";
    const hidden = await call(
      "owner",
      "GET",
      `/api/projects/${projectId}/modules`,
    );
    expect(Object.keys(modules(hidden))).not.toContain("support");
    const refused = await put("owner", "support", true);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe("MODULE_NOT_FOUND");

    process.env.ORBIT_SUPPORT = "true";
    const offered = await call(
      "owner",
      "GET",
      `/api/projects/${projectId}/modules`,
    );
    expect(modules(offered).support).toEqual({
      enabled: false,
      explicit: false,
    });
    const on = await put("owner", "support", true);
    expect(on.statusCode).toBe(200);
    expect(modules(on).support).toEqual({ enabled: true, explicit: true });
    expect((await put("owner", "support", false)).statusCode).toBe(200);
  });
});
