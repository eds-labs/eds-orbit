import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { actorScope } from "../src/platform/tenancy/member-scope.ts";
import {
  setSystemMailSinkForTests,
  type SystemMail,
} from "../src/platform/email/system-mail.ts";
import { setSystemRoleByEmail } from "../src/platform/administration/users.ts";

// System administration, organization management, invitations, user
// lifecycle and account self-service (ADR 0012), end to end over HTTP.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_ACCOUNT: "true",
  // A configured system sender; the test sink receives every message.
  ORBIT_SYSTEM_SMTP_HOST: "smtp.example.invalid",
  ORBIT_SYSTEM_SMTP_FROM: "orbit@example.invalid",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

type Person = { id: string; email: string; cookie?: string };

describe.skipIf(!enabled)("Administration and accounts (ADR 0012)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  const mails: SystemMail[] = [];
  let workspaceId: string, otherWorkspaceId: string, projectId: string;
  const p: Record<
    "admin" | "admin2" | "owner" | "member" | "outsider" | "spare",
    Person
  > = {} as never;

  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const address = () => `${randomUUID()}@example.invalid`;
  async function signUp(name: string) {
    const email = address();
    const r = await makeAuth().api.signUpEmail({
      body: { email, name, password },
    });
    users.push(r.user.id);
    return { id: r.user.id, email };
  }
  const cookieOf = (set: string | string[] | undefined) =>
    (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  async function signIn(email: string, secret = password) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password: secret },
    });
    return { status: r.statusCode, cookie: cookieOf(r.headers["set-cookie"]) };
  }
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    who?: Person | string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin,
        [CLIENT_IP_HEADER]: ip(),
        ...(who
          ? { cookie: typeof who === "string" ? who : who.cookie! }
          : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const tokenOf = (link: string) => link.split("#")[1]!;
  async function nextMail(to: string) {
    for (let i = 0; i < 50; i++) {
      const found = mails.find((m) => m.to === to);
      if (found) return found;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("no mail");
  }
  const linkIn = (mail: SystemMail) =>
    mail.text.match(/https?:\/\/\S+#[A-Za-z0-9_-]+/)![0];

  beforeAll(async () => {
    setSystemMailSinkForTests((mail) => mails.push(mail));
    app = await buildServer();
    for (const key of [
      "admin",
      "admin2",
      "owner",
      "member",
      "outsider",
      "spare",
    ] as const)
      p[key] = await signUp(`Synthetic ${key}`);
    await authDb.user.updateMany({
      where: { id: { in: [p.admin.id, p.admin2.id] } },
      data: { role: "admin" },
    });
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic administration org",
          members: {
            create: [
              { userId: p.owner.id, role: "owner" },
              { userId: p.member.id, role: "viewer" },
              { userId: p.spare.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    otherWorkspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic other org",
          members: { create: { userId: p.outsider.id, role: "owner" } },
        },
      })
    ).id;
    workspaces.push(workspaceId, otherWorkspaceId);
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic administration project",
          members: { create: { userId: p.member.id, role: "editor" } },
        },
      })
    ).id;
    for (const key of ["admin", "owner", "member", "outsider"] as const) {
      const r = await signIn(p[key].email);
      expect(r.status).toBe(200);
      p[key].cookie = r.cookie;
    }
  });
  afterAll(async () => {
    setSystemMailSinkForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  describe("system administration access", () => {
    it("answers 401 without a session and 404 to everyone but administrators", async () => {
      expect((await call("GET", "/api/admin/overview")).statusCode).toBe(401);
      for (const who of [p.owner, p.member, p.outsider])
        expect((await call("GET", "/api/admin/overview", who)).statusCode).toBe(
          404,
        );
      const r = await call("GET", "/api/admin/overview", p.admin);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        users: { total: expect.any(Number) },
        system: { database: "ok", systemMail: "configured" },
      });
    });

    it("hides every administration route while the flag is off", async () => {
      process.env.ORBIT_ADMINISTRATION = "false";
      try {
        expect(
          (await call("GET", "/api/admin/overview", p.admin)).statusCode,
        ).toBe(404);
        expect(
          (await call("GET", `/api/organizations/${workspaceId}`, p.owner))
            .statusCode,
        ).toBe(404);
      } finally {
        process.env.ORBIT_ADMINISTRATION = "true";
      }
    });

    it("reports the administrator flag in /api/me only for administrators", async () => {
      expect((await call("GET", "/api/me", p.admin)).json().systemAdmin).toBe(
        true,
      );
      const owner = (await call("GET", "/api/me", p.owner)).json();
      expect(owner.systemAdmin).toBe(false);
      expect(
        owner.workspaces.find((w: { id: string }) => w.id === workspaceId),
      ).toMatchObject({ canManage: true });
      // No ban state or role field leaks through the user object.
      expect(Object.keys(owner.user).sort()).toEqual(
        ["email", "id", "image", "locale", "name"].sort(),
      );
    });

    it("lists and searches users with their memberships", async () => {
      const list = await call(
        "GET",
        `/api/admin/users?query=${encodeURIComponent(p.member.email)}`,
        p.admin,
      );
      expect(list.json().items).toMatchObject([
        { id: p.member.id, organizations: 1, projects: 1, banned: false },
      ]);
      const detail = await call(
        "GET",
        `/api/admin/users/${p.member.id}`,
        p.admin,
      );
      expect(detail.json()).toMatchObject({
        organizations: [{ id: workspaceId, role: "member" }],
        projects: [{ id: projectId, role: "editor" }],
      });
    });

    it("gives administrators no access to project content", async () => {
      const r = await call("GET", `/api/projects/${projectId}`, p.admin);
      expect(r.statusCode).toBe(404);
    });
  });

  describe("organization management", () => {
    it("lets an owner manage only their own organization", async () => {
      expect(
        (await call("GET", `/api/organizations/${workspaceId}`, p.owner))
          .statusCode,
      ).toBe(200);
      for (const who of [p.member, p.outsider])
        expect(
          (await call("GET", `/api/organizations/${workspaceId}`, who))
            .statusCode,
        ).toBe(404);
      expect(
        (
          await call(
            "PUT",
            `/api/organizations/${otherWorkspaceId}/members/${p.outsider.id}`,
            p.owner,
            { role: "member" },
          )
        ).statusCode,
      ).toBe(404);
    });

    it("protects the last owner", async () => {
      const demote = await call(
        "PUT",
        `/api/organizations/${workspaceId}/members/${p.owner.id}`,
        p.owner,
        { role: "member" },
      );
      expect(demote.statusCode).toBe(409);
      expect(demote.json().error.code).toBe("LAST_OWNER");
      const remove = await call(
        "DELETE",
        `/api/organizations/${workspaceId}/members/${p.owner.id}`,
        p.admin,
      );
      expect(remove.json().error.code).toBe("LAST_OWNER");
    });

    it("changes a project role and removes access effective immediately", async () => {
      const base = `/api/organizations/${workspaceId}/projects/${projectId}/members/${p.spare.id}`;
      expect(
        (await call("PUT", base, p.owner, { role: "viewer" })).statusCode,
      ).toBe(200);
      expect(
        (await actorScope(workspaceId, projectId, p.spare.id))?.role,
      ).toBe("viewer");
      expect((await call("DELETE", base, p.owner)).statusCode).toBe(204);
      expect(await actorScope(workspaceId, projectId, p.spare.id)).toBeNull();
      const audit = await authDb.systemAuditEvent.findMany({
        where: { targetId: p.spare.id, workspaceId },
        orderBy: { createdAt: "asc" },
      });
      expect(audit.map((a) => a.action)).toEqual([
        "project_member.set",
        "project_member.removed",
      ]);
      expect(JSON.stringify(audit)).not.toContain("@");
    });
  });

  describe("invitations", () => {
    it("invites by link, then the person sets their own password and gets the grants", async () => {
      const email = address();
      const created = await call(
        "POST",
        `/api/organizations/${workspaceId}/invitations`,
        p.owner,
        { email, projects: [{ projectId, role: "editor" }] },
      );
      expect(created.statusCode).toBe(201);
      // Outside live mode nothing is delivered, so the inviter also gets
      // the link (the test sink shows what the mail would say).
      const { link, delivery } = created.json();
      expect(delivery).toBe("link");
      const mail = await nextMail(email);
      expect(linkIn(mail)).toBe(link);
      const token = tokenOf(link);
      expect(mail.text).not.toContain(password);
      const view = await call("POST", "/api/invitations/view", undefined, {
        token,
      });
      expect(view.json()).toMatchObject({
        email,
        organization: "Synthetic administration org",
        projects: [{ name: "Synthetic administration project", role: "editor" }],
        existingAccount: false,
      });
      const accepted = await call("POST", "/api/invitations/accept", undefined, {
        token,
        name: "Synthetic invited",
        password,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers["set-cookie"]).toBeTruthy();
      const user = await authDb.user.findUnique({ where: { email } });
      users.push(user!.id);
      expect(user!.emailVerified).toBe(true);
      expect((await actorScope(workspaceId, projectId, user!.id))?.role).toBe(
        "editor",
      );
      // Single use.
      expect(
        (
          await call("POST", "/api/invitations/view", undefined, { token })
        ).statusCode,
      ).toBe(404);
    });

    it("refuses expired and revoked links alike", async () => {
      const email = address();
      await call(
        "POST",
        `/api/organizations/${workspaceId}/invitations`,
        p.owner,
        { email },
      );
      const token = tokenOf(linkIn(await nextMail(email)));
      const invitation = await authDb.invitation.findFirstOrThrow({
        where: { email },
      });
      await authDb.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await call("POST", "/api/invitations/view", undefined, {
        token,
      });
      expect(expired.json().error.code).toBe("INVITATION_NOT_FOUND");
      await authDb.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() + 3600_000) },
      });
      expect(
        (
          await call(
            "DELETE",
            `/api/organizations/${workspaceId}/invitations/${invitation.id}`,
            p.owner,
          )
        ).statusCode,
      ).toBe(204);
      expect(
        (await call("POST", "/api/invitations/view", undefined, { token }))
          .statusCode,
      ).toBe(404);
    });

    it("refuses an invitation whose inviter lost the right to give it", async () => {
      const email = address();
      const created = await call(
        "POST",
        `/api/organizations/${workspaceId}/invitations`,
        p.owner,
        { email, role: "owner" },
      );
      expect(created.statusCode).toBe(201);
      const token = tokenOf(linkIn(await nextMail(email)));
      // Another owner takes over and the inviter becomes a member.
      await authDb.workspaceMember.create({
        data: { workspaceId, userId: p.admin2.id, role: "owner" },
      });
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: p.owner.id } },
        data: { role: "viewer" },
      });
      try {
        const r = await call("POST", "/api/invitations/accept", undefined, {
          token,
          name: "Synthetic late",
          password,
        });
        expect(r.statusCode).toBe(409);
        expect(r.json().error.code).toBe("INVITATION_NO_LONGER_VALID");
        // No account is left without its invitation.
        expect(await authDb.user.findUnique({ where: { email } })).toBeNull();
      } finally {
        await authDb.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: p.owner.id } },
          data: { role: "owner" },
        });
        await authDb.workspaceMember.delete({
          where: { workspaceId_userId: { workspaceId, userId: p.admin2.id } },
        });
      }
    });
  });

  describe("user lifecycle", () => {
    it("deactivation ends sessions and access everywhere; reactivation restores access", async () => {
      expect((await call("GET", "/api/me", p.member)).statusCode).toBe(200);
      const off = await call(
        "POST",
        `/api/admin/users/${p.member.id}/deactivate`,
        p.admin,
        { reason: "left" },
      );
      expect(off.json()).toMatchObject({ deactivated: true, changed: true });
      expect((await call("GET", "/api/me", p.member)).statusCode).toBe(401);
      expect(await actorScope(workspaceId, projectId, p.member.id)).toBeNull();
      expect((await signIn(p.member.email)).status).not.toBe(200);
      await call("POST", `/api/admin/users/${p.member.id}/reactivate`, p.admin);
      expect(
        (await actorScope(workspaceId, projectId, p.member.id))?.role,
      ).toBe("editor");
      const back = await signIn(p.member.email);
      expect(back.status).toBe(200);
      p.member.cookie = back.cookie;
    });

    it("protects administrators from locking themselves or the installation out", async () => {
      const self = await call(
        "POST",
        `/api/admin/users/${p.admin.id}/deactivate`,
        p.admin,
        {},
      );
      expect(self.json().error.code).toBe("CANNOT_DEACTIVATE_SELF");
      const owner = await call(
        "POST",
        `/api/admin/users/${p.owner.id}/deactivate`,
        p.admin,
        {},
      );
      expect(owner.json().error.code).toBe("LAST_OWNER");
      const wrong = await call(
        "PUT",
        `/api/admin/users/${p.admin.id}/system-role`,
        p.admin,
        { role: "user", password: "not-the-password" },
      );
      expect(wrong.statusCode).toBe(403);
      const demoteSelf = await call(
        "PUT",
        `/api/admin/users/${p.admin.id}/system-role`,
        p.admin,
        { role: "user", password },
      );
      expect(demoteSelf.json().error.code).toBe("CANNOT_DEMOTE_SELF");
      const demoteOther = await call(
        "PUT",
        `/api/admin/users/${p.admin2.id}/system-role`,
        p.admin,
        { role: "user", password },
      );
      expect(demoteOther.json()).toMatchObject({ role: "user", changed: true });
    });

    it("grants the administrator role from the command line, audited", async () => {
      const result = await setSystemRoleByEmail(p.admin2.email, "admin");
      expect(result).toMatchObject({ changed: true, role: "admin" });
      const audit = await authDb.systemAuditEvent.findFirst({
        where: { targetId: p.admin2.id, actorId: "system:cli" },
      });
      expect(audit?.action).toBe("system_admin.granted");
    });
  });

  describe("account self-service", () => {
    it("edits the profile and language", async () => {
      const r = await call("PATCH", "/api/account", p.outsider, {
        name: "Synthetic renamed",
        locale: "de",
      });
      expect(r.json()).toMatchObject({ name: "Synthetic renamed", locale: "de" });
      expect(
        (await call("PATCH", "/api/account", p.outsider, { role: "admin" }))
          .statusCode,
      ).toBe(400);
    });

    it("changes the password and can sign out other sessions", async () => {
      const second = await signIn(p.outsider.email);
      const wrong = await call("POST", "/api/account/password", p.outsider, {
        currentPassword: "not-the-password",
        newPassword: password + "x",
      });
      expect(wrong.json().error.code).toBe("INVALID_PASSWORD");
      const changed = await call("POST", "/api/account/password", p.outsider, {
        currentPassword: password,
        newPassword: password + "x",
        revokeOtherSessions: true,
      });
      expect(changed.statusCode).toBe(200);
      p.outsider.cookie = cookieOf(changed.headers["set-cookie"]);
      expect((await call("GET", "/api/me", second.cookie)).statusCode).toBe(401);
      const sessions = await call("GET", "/api/account/sessions", p.outsider);
      expect(sessions.json().items).toMatchObject([{ current: true }]);
      expect(JSON.stringify(sessions.json())).not.toMatch(/token/i);
    });

    it("lists and revokes only the user's own sessions", async () => {
      const other = await authDb.session.findFirstOrThrow({
        where: { userId: p.owner.id },
      });
      const r = await call(
        "DELETE",
        `/api/account/sessions/${other.id}`,
        p.outsider,
      );
      expect(r.statusCode).toBe(404);
      expect(
        await authDb.session.findUnique({ where: { id: other.id } }),
      ).not.toBeNull();
    });

    it("resets a forgotten password by a single-use link and ends all sessions", async () => {
      const unknown = await call(
        "POST",
        "/api/account/password-reset/request",
        undefined,
        { email: address() },
      );
      expect(unknown.statusCode).toBe(202);
      const r = await call(
        "POST",
        "/api/account/password-reset/request",
        undefined,
        { email: p.spare.email },
      );
      expect(r.statusCode).toBe(202);
      const token = tokenOf(linkIn(await nextMail(p.spare.email)));
      // Only the hash is stored.
      expect(
        await authDb.verification.findFirst({
          where: { identifier: { contains: token } },
        }),
      ).toBeNull();
      const spare = await signIn(p.spare.email);
      const done = await call(
        "POST",
        "/api/account/password-reset/confirm",
        undefined,
        { token, newPassword: password + "reset" },
      );
      expect(done.statusCode).toBe(200);
      expect((await call("GET", "/api/me", spare.cookie)).statusCode).toBe(401);
      const again = await call(
        "POST",
        "/api/account/password-reset/confirm",
        undefined,
        { token, newPassword: password + "again" },
      );
      expect(again.json().error.code).toBe("INVALID_TOKEN");
      const signedIn = await makeAuth().api.signInEmail({
        body: { email: p.spare.email, password: password + "reset" },
      });
      expect(signedIn.user.id).toBe(p.spare.id);
    });

    it("changes the e-mail address only after confirmation from the new address", async () => {
      const next = address();
      const asked = await call("POST", "/api/account/email", p.owner, {
        newEmail: next,
        password,
      });
      expect(asked.statusCode).toBe(200);
      expect(
        (await authDb.user.findUnique({ where: { id: p.owner.id } }))!.email,
      ).toBe(p.owner.email);
      const token = tokenOf(linkIn(await nextMail(next)));
      const confirmed = await call(
        "POST",
        "/api/account/email/confirm",
        p.owner,
        { token },
      );
      expect(confirmed.json()).toMatchObject({ email: next, emailVerified: true });
      await nextMail(p.owner.email);
      p.owner.email = next;
    });
  });
});
