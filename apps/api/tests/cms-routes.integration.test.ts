import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * The content module's HTTP gate (ADR 0029, CH1.4): reachable only with
 * ORBIT_CMS on and the module enabled in the project (opt-in also while
 * ORBIT_MODULES is off); every member reads, only the owner saves settings,
 * members of other projects and members without the module see nothing.
 */
describe.skipIf(!enabled)("content module routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "PUT",
    url: string,
    payload?: object,
    project = projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const setModule = (enabledInProject: boolean) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.upsert({
        where: { workspaceId_projectId_moduleId: { workspaceId, projectId, moduleId: "cms" } },
        create: { workspaceId, projectId, moduleId: "cms", enabled: enabledInProject, moduleVersion: "0.1.0", changedBy: ids.owner },
        update: { enabled: enabledInProject },
      }),
    );

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic cms",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_MODULE_ROLES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  // Runs first: the project has no cms row yet.
  it("stays off without a project row while ORBIT_MODULES is off (opt-in)", async () => {
    const row = await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.findFirst({ where: { projectId, moduleId: "cms" } }),
    );
    expect(row).toBeNull();
    const response = await call("owner", "GET", "/cms/status");
    expect([response.statusCode, code(response)]).toEqual([404, "CMS_DISABLED"]);
  });

  it("answers 404 CMS_DISABLED while ORBIT_CMS is off, even with the module enabled", async () => {
    await setModule(true);
    delete process.env.ORBIT_CMS;
    const response = await call("owner", "GET", "/cms/status");
    expect([response.statusCode, code(response)]).toEqual([404, "CMS_DISABLED"]);
  });

  it("lets every member read the status with the default approval rule (E-4)", async () => {
    await setModule(true);
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await call(who, "GET", "/cms/status");
      expect(response.statusCode, who).toBe(200);
      const body = response.json();
      expect(body.module).toBe("cms");
      expect(body.settings.publishApprovers).toBe("owner_or_editor");
    }
  });

  it("lets only the owner save settings, versioned", async () => {
    await setModule(true);
    const status = (await call("owner", "GET", "/cms/status")).json();
    const next = { ...status.settings, publishApprovers: "owner", fourEyes: true };
    const editor = await call("editor", "PUT", "/cms/settings", { settings: next, version: status.settingsVersion });
    expect([editor.statusCode, code(editor)]).toEqual([403, "FORBIDDEN"]);
    const invalid = await call("owner", "PUT", "/cms/settings", {
      settings: { ...next, lateWindowHours: 0 },
      version: status.settingsVersion,
    });
    expect(invalid.statusCode).toBe(400);
    const saved = await call("owner", "PUT", "/cms/settings", { settings: next, version: status.settingsVersion });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ settings: next, version: status.settingsVersion + 1 });
    const stale = await call("owner", "PUT", "/cms/settings", { settings: next, version: status.settingsVersion });
    expect([stale.statusCode, code(stale)]).toEqual([409, "SETTINGS_VERSION_CONFLICT"]);
    expect((await call("viewer", "GET", "/cms/status")).json().settings.publishApprovers).toBe("owner");
  });

  it("hides the project from members of other projects", async () => {
    await setModule(true);
    const response = await call("editor", "GET", "/cms/status", undefined, otherProjectId);
    expect([response.statusCode, code(response)]).toEqual([404, "NOT_FOUND"]);
  });

  it("hides the module from a member whose module role is none", async () => {
    await setModule(true);
    process.env.ORBIT_MODULES = "true";
    process.env.ORBIT_MODULE_ROLES = "true";
    const roles = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/members/${ids.editor}/module-roles`,
      headers: { origin, cookie: cookies.owner, [CLIENT_IP_HEADER]: ip() },
      payload: { roles: { cms: "none" } },
    });
    expect(roles.statusCode).toBe(200);
    const hidden = await call("editor", "GET", "/cms/status");
    expect([hidden.statusCode, code(hidden)]).toEqual([404, "MODULE_NOT_AVAILABLE"]);
    expect((await call("owner", "GET", "/cms/status")).statusCode).toBe(200);
  });

  it("keeps the module row when the owner disables the module", async () => {
    await setModule(true);
    process.env.ORBIT_MODULES = "true";
    const disabled = await call("owner", "PUT", "/modules/cms", { enabled: false });
    expect(disabled.statusCode).toBe(200);
    const response = await call("owner", "GET", "/cms/status");
    // ORBIT_MODULES is on here, so the platform gate answers before requireCms
    // (same code as the access matrix); CMS_DISABLED covers the opt-in path.
    expect([response.statusCode, code(response)]).toEqual([404, "MODULE_DISABLED"]);
    // Without the platform gate the module's own disabled-row check answers.
    delete process.env.ORBIT_MODULES;
    const own = await call("owner", "GET", "/cms/status");
    expect([own.statusCode, code(own)]).toEqual([404, "CMS_DISABLED"]);
    const row = await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.findUnique({
        where: { workspaceId_projectId_moduleId: { workspaceId, projectId, moduleId: "cms" } },
      }),
    );
    expect(row?.enabled).toBe(false);
  });
});
