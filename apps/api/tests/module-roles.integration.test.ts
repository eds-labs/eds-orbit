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
import { create, hash } from "../src/shared.ts";
import { actorScope } from "../src/platform/tenancy/member-scope.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Module-level roles (WP4.5): a member's role in one module overrides the
 * project role there, "none" hides the module, owners are never affected,
 * and nothing changes while ORBIT_MODULE_ROLES is off.
 */
describe.skipIf(!enabled)("module-level roles", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let projectId = "";
  const ids: Record<"owner" | "editor" | "viewer", string> = {
    owner: "",
    editor: "",
    viewer: "",
  };
  const cookies: Record<keyof typeof ids, string> = {
    owner: "",
    editor: "",
    viewer: "",
  };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const setRoles = (userId: string, roles: Record<string, string | null>) =>
    call("owner", "PUT", `/members/${userId}/module-roles`, { roles });

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic module roles",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic module roles" },
    });
    projectId = project.id;
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: {
          workspaceId: workspace.id,
          projectId,
          userId: ids[who],
          role,
        },
      });
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
  });
  afterEach(() => {
    delete process.env.ORBIT_MODULE_ROLES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("refuses to manage module roles while the flag is off", async () => {
    const response = await setRoles(ids.editor, { marketing: "none" });
    expect(response.statusCode).toBe(404);
    expect(
      (await call("owner", "GET", `/members/${ids.editor}/module-roles`))
        .statusCode,
    ).toBe(404);
  });

  it("lets only owners set roles, never for owners and never for unknown modules", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    expect(
      (
        await call("editor", "PUT", `/members/${ids.viewer}/module-roles`, {
          roles: { marketing: "none" },
        })
      ).statusCode,
    ).toBe(403);
    const ownerOverride = await setRoles(ids.owner, { marketing: "none" });
    expect(ownerOverride.statusCode).toBe(404);
    const unknown = await setRoles(ids.editor, { support: "none" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("MODULE_NOT_FOUND");
    const invalid = await setRoles(ids.editor, { marketing: "owner" });
    expect(invalid.statusCode).toBe(400);
  });

  it("hides a module whose role is none in routes, collections, actions and the module list", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    const saved = await setRoles(ids.editor, { marketing: "none" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().roles).toEqual({ marketing: "none" });
    for (const [method, url, payload] of [
      ["GET", "/marketing-profile"],
      ["GET", "/missions"],
      ["POST", "/actions/analyze", {}],
    ] as const) {
      const response = await call("editor", method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        "MODULE_NOT_AVAILABLE",
      );
    }
    // Knowledge and the platform stay as before.
    expect((await call("editor", "GET", "/sources")).statusCode).toBe(200);
    const modules = (await call("editor", "GET", "/modules")).json().modules;
    expect(
      Object.fromEntries(
        modules.map((m: { id: string; access: string }) => [m.id, m.access]),
      ),
    ).toEqual({ knowledge: "editor", marketing: "none" });
    // The owner is never affected.
    expect((await call("owner", "GET", "/missions")).statusCode).toBe(200);
    const audits = await scoped(workspaces[0]!, projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { projectId, action: "member.module_role_changed" },
      }),
    );
    expect(audits[0]!.actorId).toBe(ids.owner);
    expect(audits.length).toBeGreaterThan(0);
  });

  it("lets a module role raise a viewer to editor in that module only", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    const preview = () =>
      call("viewer", "POST", "/actions/knowledge-import-preview", {});
    expect((await preview()).statusCode).toBe(403);
    expect(
      (await setRoles(ids.viewer, { knowledge: "editor" })).statusCode,
    ).toBe(200);
    // Past the permission check: the empty body is now a validation error.
    const raised = await preview();
    expect(raised.statusCode).not.toBe(403);
    expect(raised.statusCode).not.toBe(404);
    // Still a viewer in marketing.
    expect((await call("viewer", "POST", "/missions", {})).statusCode).toBe(
      403,
    );
  });

  it("ignores stored roles while the flag is off", async () => {
    // The override from the earlier test is still stored.
    expect(
      await authDb.projectMemberModuleRole.count({
        where: { projectId, userId: ids.editor },
      }),
    ).toBe(1);
    expect((await call("editor", "GET", "/missions")).statusCode).toBe(200);
    expect((await call("editor", "GET", "/modules")).json().modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "marketing", access: "editor" }),
      ]),
    );
  });

  it("removes a role with null", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    const removed = await setRoles(ids.editor, { marketing: null });
    expect(removed.json().roles).toEqual({});
    expect((await call("editor", "GET", "/missions")).statusCode).toBe(200);
  });
  // Security review of WP4.5 (2026-10-17): platform routes that read or
  // decide a module's records must apply the member's role in that module.
  describe("security review", () => {
    const ownerScope = () => ({
      workspaceId: workspaces[0]!,
      projectId,
      userId: ids.owner,
      role: "owner" as const,
    });
    const seed = (kind: string, value: Record<string, unknown>) =>
      scoped(workspaces[0]!, projectId, (tx) =>
        create(tx, ownerScope(), kind, value),
      );
    const pendingPackageRequest = async () => {
      const payload = { ceilingMicros: 1000, review: randomUUID() };
      const packageHash = hash({
        actionType: "content_package.start",
        payload,
      });
      const row = await seed("action_requests", {
        actionType: "content_package.start",
        riskClass: "C1",
        approvalMode: "approval_required",
        policy: { id: randomUUID(), version: 1 },
        requestedBy: { kind: "user", userId: ids.owner },
        payload,
        packageHash,
        costCeilingMicros: 1000,
        status: "pending",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      return { id: row.id, version: row.version, packageHash };
    };
    const decide = (
      who: keyof typeof ids,
      request: { id: string; version: number; packageHash: string },
    ) =>
      call(who, "POST", `/action-requests/${request.id}/decide`, {
        version: request.version,
        packageHash: request.packageHash,
        decision: "reject",
      });
    afterEach(async () => {
      await authDb.projectMemberModuleRole.deleteMany({ where: { projectId } });
    });

    it("keeps a hidden module's records out of the export", async () => {
      process.env.ORBIT_MODULE_ROLES = "true";
      const publication = await seed("publications", {
        text: "Hidden marketing post",
        status: "scheduled",
      });
      const before = (await call("editor", "GET", "/export")).json();
      expect(before.entities.map((e: { id: string }) => e.id)).toContain(
        publication.id,
      );
      await setRoles(ids.editor, { marketing: "none" });
      const exported = await call("editor", "GET", "/export");
      expect(exported.statusCode).toBe(200);
      const kinds = new Set(
        exported.json().entities.map((e: { kind: string }) => e.kind),
      );
      expect(kinds.has("publications")).toBe(false);
      expect(kinds.has("missions")).toBe(false);
      // The owner still exports everything.
      expect(
        (await call("owner", "GET", "/export"))
          .json()
          .entities.map((e: { id: string }) => e.id),
      ).toContain(publication.id);
    });

    it("keeps a hidden module's records off the dashboard", async () => {
      process.env.ORBIT_MODULE_ROLES = "true";
      const publication = await seed("publications", {
        text: "Hidden dashboard post",
        status: "scheduled",
      });
      await setRoles(ids.editor, { marketing: "none" });
      const dashboard = await call("editor", "GET", "/dashboard");
      expect(dashboard.statusCode).toBe(200);
      const body = dashboard.json();
      expect(body.publications.map((p: { id: string }) => p.id)).not.toContain(
        publication.id,
      );
      expect(body.counts.publications).toBeUndefined();
      expect(body.counts.missions).toBeUndefined();
      // Knowledge stays visible.
      expect(body.counts.sources).toBeTypeOf("number");
      expect(
        (await call("owner", "GET", "/dashboard"))
          .json()
          .publications.map((p: { id: string }) => p.id),
      ).toContain(publication.id);
    });

    it("decides an action request with the role in the request's module", async () => {
      process.env.ORBIT_MODULE_ROLES = "true";
      // An editor without marketing access cannot see the request at all.
      await setRoles(ids.editor, { marketing: "none" });
      const hidden = await decide("editor", await pendingPackageRequest());
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe("MODULE_NOT_AVAILABLE");
      // A marketing viewer cannot decide an editor-level request.
      await setRoles(ids.editor, { marketing: "viewer" });
      const viewer = await decide("editor", await pendingPackageRequest());
      expect(viewer.statusCode).toBe(403);
      // A viewer raised to marketing editor can (S-R6).
      await setRoles(ids.viewer, { marketing: "editor" });
      const raised = await decide("viewer", await pendingPackageRequest());
      expect(raised.statusCode).toBe(200);
      expect(raised.json().status).toBe("rejected");
      // Without overrides the project role decides, as before.
      await setRoles(ids.editor, { marketing: null });
      expect(
        (await decide("editor", await pendingPackageRequest())).statusCode,
      ).toBe(200);
    });

    it("removes a member's roles with the membership", async () => {
      const user = await authDb.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic leaver",
          email: `${randomUUID()}@example.invalid`,
        },
      });
      users.push(user.id);
      await authDb.workspaceMember.create({
        data: { workspaceId: workspaces[0]!, userId: user.id, role: "viewer" },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: workspaces[0]!,
          projectId,
          userId: user.id,
          role: "editor",
        },
      });
      process.env.ORBIT_MODULE_ROLES = "true";
      expect((await setRoles(user.id, { marketing: "none" })).statusCode).toBe(
        200,
      );
      await authDb.projectMember.delete({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      expect(
        await authDb.projectMemberModuleRole.count({
          where: { projectId, userId: user.id },
        }),
      ).toBe(0);
    });

    it("never gives a project owner overrides, and ignores rows from before a promotion", async () => {
      process.env.ORBIT_MODULE_ROLES = "true";
      await setRoles(ids.viewer, { marketing: "none" });
      await authDb.projectMember.update({
        where: { projectId_userId: { projectId, userId: ids.viewer } },
        data: { role: "owner" },
      });
      try {
        const refused = await setRoles(ids.viewer, { knowledge: "none" });
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.code).toBe("OWNER_HAS_NO_MODULE_ROLES");
        const scope = await actorScope(workspaces[0]!, projectId, ids.viewer);
        expect(scope?.role).toBe("owner");
        expect(scope?.moduleRoles).toBeUndefined();
        expect((await call("viewer", "GET", "/missions")).statusCode).toBe(200);
      } finally {
        await authDb.projectMember.update({
          where: { projectId_userId: { projectId, userId: ids.viewer } },
          data: { role: "viewer" },
        });
      }
    });
  });
});
