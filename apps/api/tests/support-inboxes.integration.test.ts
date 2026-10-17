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

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Support settings and inboxes (WP5.1): reachable only with ORBIT_SUPPORT on
 * and the module enabled in the project; owners manage, members read; the
 * widget secret is shown once and never stored or audited in the clear.
 */
describe.skipIf(!enabled)("support settings and inboxes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const inbox = {
    name: "uLiquid Desk",
    channels: ["email", "widget"],
    emailAddress: "support@example.invalid",
    allowedOrigins: ["https://desk.example.invalid"],
  };
  const switchOn = async () => {
    process.env.ORBIT_SUPPORT = "true";
    process.env.ORBIT_MODULES = "true";
    const response = await call("owner", "PUT", "/modules/support", {
      enabled: true,
    });
    expect(response.statusCode).toBe(200);
  };

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic support ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic support",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    workspaces.push(workspace.id);
    projectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic support" },
      })
    ).id;
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId: ids[who], role },
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
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_MODULE_ROLES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  const disabled = (response: { statusCode: number; json(): any }) => ({
    status: response.statusCode,
    code: ["SUPPORT_DISABLED", "MODULE_DISABLED"].includes(
      response.json().error?.code,
    ),
  });

  it("answers 404 while the flag is off, without a row and while disabled", async () => {
    // Flag off.
    expect(disabled(await call("owner", "GET", "/support/inboxes"))).toEqual({
      status: 404,
      code: true,
    });
    // Flag on, no ProjectModule row, module switching off: still off.
    process.env.ORBIT_SUPPORT = "true";
    expect(disabled(await call("owner", "GET", "/support/settings"))).toEqual({
      status: 404,
      code: true,
    });
    // Explicitly disabled.
    await switchOn();
    expect(
      (await call("owner", "PUT", "/modules/support", { enabled: false }))
        .statusCode,
    ).toBe(200);
    expect(
      disabled(await call("owner", "POST", "/support/inboxes", inbox)),
    ).toEqual({ status: 404, code: true });
    // Enabled earlier, then the installation switched support off again.
    await switchOn();
    delete process.env.ORBIT_SUPPORT;
    expect(disabled(await call("owner", "GET", "/support/inboxes"))).toEqual({
      status: 404,
      code: true,
    });
  });

  it("creates an e-mail and widget inbox and shows the widget secret once", async () => {
    await switchOn();
    const created = await call("owner", "POST", "/support/inboxes", inbox);
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.widgetSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.inbox).toMatchObject({
      name: "uLiquid Desk",
      channels: ["email", "widget"],
      aiMode: "off",
      language: "en",
      assignmentPolicy: "unassigned",
      version: 1,
      hasWidgetSecret: true,
    });
    expect(body.inbox.widgetSecretEnc).toBeUndefined();

    const listed = await call("viewer", "GET", "/support/inboxes");
    expect(listed.statusCode).toBe(200);
    const text = listed.body;
    expect(text).not.toContain(body.widgetSecret);
    expect(text).not.toContain("widgetSecretEnc");
    expect(listed.json().items.map((i: any) => i.id)).toContain(body.inbox.id);

    const rotated = await call(
      "owner",
      "POST",
      `/support/inboxes/${body.inbox.id}/rotate-widget-secret`,
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().widgetSecret).not.toBe(body.widgetSecret);

    const stored = await scoped(workspaceId, projectId, (tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: body.inbox.id } }),
    );
    expect(stored.widgetSecretEnc).not.toContain(rotated.json().widgetSecret);
    const audits = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { workspaceId, projectId, action: { startsWith: "support." } },
      }),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      "support.inbox.created",
      "support.inbox.secret_rotated",
    ]);
    const auditText = JSON.stringify(audits.map((a) => a.metadata));
    for (const secret of [body.widgetSecret, rotated.json().widgetSecret])
      expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain("support@example.invalid");
    expect(auditText).not.toContain(stored.widgetSecretEnc);
  });

  it("validates channels, origins, addresses and the AI mode", async () => {
    await switchOn();
    for (const payload of [
      { ...inbox, allowedOrigins: [] },
      { ...inbox, emailAddress: undefined },
      { ...inbox, channels: [] },
      { ...inbox, channels: ["sms"] },
      { ...inbox, allowedOrigins: ["https://desk.example.invalid/path"] },
      { ...inbox, aiMode: "widget_answer" },
    ]) {
      const response = await call("owner", "POST", "/support/inboxes", payload);
      expect({ payload, status: response.statusCode }).toEqual({
        payload,
        status: 400,
      });
    }
    const mailOnly = await call("owner", "POST", "/support/inboxes", {
      name: "Mail only",
      channels: ["email"],
      emailAddress: "help@example.invalid",
    });
    expect(mailOnly.statusCode).toBe(200);
    expect(mailOnly.json().widgetSecret).toBeUndefined();
    expect(mailOnly.json().inbox.hasWidgetSecret).toBe(false);
  });

  it("updates with the current version and refuses a stale one", async () => {
    await switchOn();
    const { inbox: created } = (
      await call("owner", "POST", "/support/inboxes", inbox)
    ).json();
    const url = `/support/inboxes/${created.id}`;
    const updated = await call("owner", "PATCH", url, {
      version: 1,
      aiMode: "draft",
      language: "de",
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      aiMode: "draft",
      language: "de",
      version: 2,
      name: "uLiquid Desk",
    });
    const stale = await call("owner", "PATCH", url, {
      version: 1,
      name: "Late",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("INBOX_VERSION_CONFLICT");
    // Removing the widget channel's origins is refused like on create.
    const broken = await call("owner", "PATCH", url, {
      version: 2,
      allowedOrigins: [],
    });
    expect(broken.statusCode).toBe(400);

    const archived = await call("owner", "POST", `${url}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toEqual(expect.any(String));
  });

  it("reads default settings and saves a change with its version", async () => {
    await switchOn();
    const read = await call("viewer", "GET", "/support/settings");
    expect(read.statusCode).toBe(200);
    const { settings, version } = read.json();
    expect(settings.retention.closedTicketMonths).toBe(24);
    const next = {
      ...settings,
      categories: [{ key: "billing", label: "Billing" }],
    };
    const saved = await call("owner", "PUT", "/support/settings", {
      settings: next,
      version,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      version: version + 1,
      settings: { categories: [{ key: "billing", label: "Billing" }] },
    });
    const stale = await call("owner", "PUT", "/support/settings", {
      settings: next,
      version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("SETTINGS_VERSION_CONFLICT");
    const tooLong = await call("owner", "PUT", "/support/settings", {
      settings: {
        ...next,
        retention: { ...next.retention, closedTicketMonths: 73 },
      },
      version: version + 1,
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("lets members read, only the owner manage, and hides support for role none", async () => {
    await switchOn();
    expect((await call("editor", "GET", "/support/inboxes")).statusCode).toBe(
      200,
    );
    for (const who of ["editor", "viewer"] as const) {
      const response = await call(who, "POST", "/support/inboxes", inbox);
      expect({ who, status: response.statusCode }).toEqual({
        who,
        status: 403,
      });
      expect(
        (
          await call(who, "PUT", "/support/settings", {
            settings: {},
            version: 1,
          })
        ).statusCode,
      ).toBe(403);
    }
    process.env.ORBIT_MODULE_ROLES = "true";
    const roles = (userId: string, role: string) =>
      call("owner", "PUT", `/members/${userId}/module-roles`, {
        roles: { support: role },
      });
    expect((await roles(ids.viewer, "editor")).statusCode).toBe(200);
    expect((await roles(ids.editor, "none")).statusCode).toBe(200);
    // A module editor is still no owner: settings stay owner-only.
    expect(
      (await call("viewer", "POST", "/support/inboxes", inbox)).statusCode,
    ).toBe(403);
    expect((await call("viewer", "GET", "/support/inboxes")).statusCode).toBe(
      200,
    );
    expect((await call("editor", "GET", "/support/inboxes")).statusCode).toBe(
      404,
    );
  });
});
