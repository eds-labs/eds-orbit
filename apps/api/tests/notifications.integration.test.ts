import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { data, list } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { notifyMembers } from "../src/platform/notifications/members.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

/**
 * Member notifications (WP4.7): in-app notices by preference, private to
 * their member, e-mail only when chosen, nothing for non-members or for a
 * module the member cannot use.
 */
describe.skipIf(!enabled)("member notifications", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  const ids = { owner: "", editor: "", viewer: "" };
  const emails = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
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
      url: `/api/projects/${scope.projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const notify = (userIds: string[], title = "Task for you") =>
    scoped(scope.workspaceId, scope.projectId, (tx) =>
      notifyMembers(tx, scope, {
        kind: "task_assigned",
        userIds,
        title,
        body: "Please have a look.",
        link: `/projects/${scope.projectId}/tasks`,
      }),
    );

  beforeAll(async () => {
    process.env.ORBIT_NOTIFICATIONS = "true";
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      emails[who] = email;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic notifications",
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
      data: { workspaceId: workspace.id, name: "Synthetic notifications" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "system",
      role: "owner",
    };
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
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
    process.env.ORBIT_NOTIFICATIONS = "true";
    delete process.env.ORBIT_EMAIL;
    delete process.env.ORBIT_MODULE_ROLES;
  });
  afterAll(async () => {
    delete process.env.ORBIT_NOTIFICATIONS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("notifies members only, and each sees only their own", async () => {
    const stranger = randomUUID();
    expect(await notify([ids.editor, ids.viewer, ids.owner, stranger])).toEqual(
      { inApp: 3, email: 0 },
    );
    const editor = await call("editor", "GET", "/notifications");
    expect(editor.statusCode).toBe(200);
    expect(editor.json()).toMatchObject({
      unread: 1,
      items: [
        {
          kind: "task_assigned",
          moduleId: "tasks",
          title: "Task for you",
          link: `/projects/${scope.projectId}/tasks`,
          readAt: null,
        },
      ],
    });
    // The viewer cannot mark the editor's notice as read.
    const editorsId = editor.json().items[0].id;
    expect(
      (await call("viewer", "POST", `/notifications/${editorsId}/read`)).json(),
    ).toEqual({ updated: 0 });
    expect(
      (await call("editor", "POST", `/notifications/${editorsId}/read`)).json(),
    ).toEqual({ updated: 1 });
    expect((await call("editor", "GET", "/notifications")).json().unread).toBe(
      0,
    );
    // Row-level security: without the member's id, nothing is visible.
    const visible = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.notification.count(),
    );
    expect(visible).toBe(0);
  });

  it("respects muting, the module role and the e-mail choice", async () => {
    // The viewer mutes the kind in-app and wants it by e-mail instead.
    const prefs = await call("viewer", "GET", "/notification-preferences");
    expect(prefs.json().kinds).toEqual([
      {
        kind: "task_assigned",
        moduleId: "tasks",
        label: { en: "Task assigned", de: "Aufgabe zugewiesen" },
        inApp: true,
        email: false,
      },
    ]);
    expect(
      (
        await call("viewer", "PUT", "/notification-preferences", {
          kinds: { task_assigned: { inApp: false, email: true } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call("viewer", "PUT", "/notification-preferences", {
          kinds: { unknown_kind: { inApp: false, email: false } },
        })
      ).statusCode,
    ).toBe(400);
    // E-mail off: the viewer gets nothing at all.
    expect(await notify([ids.viewer], "Muted")).toEqual({ inApp: 0, email: 0 });
    // E-mail on: one message to the viewer's address, marked automatic.
    process.env.ORBIT_EMAIL = "true";
    expect(await notify([ids.viewer], "By mail")).toEqual({
      inApp: 0,
      email: 1,
    });
    const queued = (
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        list(tx, scope, "email_messages"),
      )
    ).map((row) => data(row));
    expect(queued.at(-1)).toMatchObject({
      to: [emails.viewer],
      subject: "By mail",
      automatic: true,
      status: "queued",
    });
    // No access to the module: no notice either.
    expect(await notify([ids.editor], "Before")).toEqual({
      inApp: 1,
      email: 0,
    });
    process.env.ORBIT_MODULE_ROLES = "true";
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: ids.editor,
        moduleId: "tasks",
        role: "none",
      },
    });
    expect(await notify([ids.editor], "Hidden")).toEqual({
      inApp: 0,
      email: 0,
    });
    // Notices from before the change are hidden too, and do not count.
    expect((await call("editor", "GET", "/notifications")).json()).toEqual({
      unread: 0,
      items: [],
    });
  });

  it("refuses links that a browser would take off Orbit", async () => {
    // "/\t/x" and "/\n/x" become "//x" in a browser (tabs and line breaks
    // are dropped), "/\x" becomes "//x" (backslash is a slash).
    for (const link of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\\evil.example",
    ])
      await expect(
        scoped(scope.workspaceId, scope.projectId, (tx) =>
          notifyMembers(tx, scope, {
            kind: "task_assigned",
            userIds: [ids.editor],
            title: "Link",
            link,
          }),
        ),
      ).rejects.toThrow();
    // The database refuses them as well, whoever writes the row.
    for (const link of ["/\t/evil.example", "/\\evil.example"])
      await expect(
        scoped(scope.workspaceId, scope.projectId, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.user_id',${ids.editor},true)`;
          await tx.notification.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              userId: ids.editor,
              moduleId: "tasks",
              kind: "task_assigned",
              title: "Direct",
              link,
            },
          });
        }),
      ).rejects.toThrow();
  });

  it("e-mails a title with a line break as one subject line instead of failing", async () => {
    process.env.ORBIT_EMAIL = "true";
    // The viewer chose e-mail in the test above; a title from user input
    // with a line break must not make the module's whole action fail.
    expect(await notify([ids.viewer], "Fix the\r\nlogin page")).toEqual({
      inApp: 0,
      email: 1,
    });
    const queued = (
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        list(tx, scope, "email_messages"),
      )
    ).map((row) => data(row));
    // Newest first.
    expect(queued[0]).toMatchObject({ subject: "Fix the login page" });
  });

  it("does not exist while off", async () => {
    process.env.ORBIT_NOTIFICATIONS = "false";
    expect((await call("editor", "GET", "/notifications")).statusCode).toBe(
      404,
    );
    expect(await notify([ids.editor])).toEqual({ inApp: 0, email: 0 });
  });
});
