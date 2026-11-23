import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";

const canRun = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const initial = { revision: 0, widgets: null };
const widgets = [
  { id: "social.upcoming", size: "wide" },
  { id: "platform.system-status", size: "compact" },
];

describe.skipIf(!canRun)("private project home layout", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  const users: Record<string, { id: string; cookie: string }> = {};
  const previousFlag = process.env.ORBIT_HOME_WIDGETS;
  const request = (
    who: string,
    project: string,
    payload?: object,
    server = app,
  ) =>
    server.inject({
      method: payload ? "PUT" : "GET",
      url: `/api/projects/${project}/home-layout`,
      headers: {
        origin: process.env.APP_ORIGIN!,
        cookie: users[who]?.cookie ?? "",
      },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    process.env.ORBIT_HOME_WIDGETS = "true";
    app = await buildServer();
    const auth = makeAuth();
    for (const who of ["owner", "viewer"]) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const user = await auth.api.signUpEmail({
        body: { email, password, name: who },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: process.env.APP_ORIGIN! },
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      const cookie = (Array.isArray(set) ? set : [set])
        .map((value) => value!.split(";")[0])
        .join("; ");
      users[who] = { id: user.user.id, cookie };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic widget preferences",
        members: {
          create: [
            { userId: users.owner!.id, role: "owner" },
            { userId: users.viewer!.id, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    ([projectId, otherProjectId] = await Promise.all(
      ["One", "Two"].map(
        async (name) =>
          (await authDb.project.create({ data: { workspaceId, name } })).id,
      ),
    )) as [string, string];
    await authDb.projectMember.create({
      data: {
        workspaceId,
        projectId,
        userId: users.viewer!.id,
        role: "viewer",
      },
    });
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.ORBIT_HOME_WIDGETS;
    else process.env.ORBIT_HOME_WIDGETS = previousFlag;
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(users).map(({ id }) => id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("isolates members and projects and only accepts one write per revision", async () => {
    const first = await request("viewer", projectId);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json()).toEqual(initial);
    expect((await request("anonymous", projectId)).statusCode).toBe(401);
    expect((await request("viewer", otherProjectId, initial)).statusCode).toBe(
      404,
    );

    const concurrent = await Promise.all([
      request("viewer", projectId, { revision: 0, widgets }),
      request("viewer", projectId, { revision: 0, widgets: [] }),
    ]);
    expect(
      concurrent.map((r) => r.statusCode).sort(),
      concurrent.map((r) => r.body).join("\n"),
    ).toEqual([200, 409]);
    const committed = concurrent.find((r) => r.statusCode === 200)!.json();
    expect(committed.revision).toBe(1);
    expect((await request("viewer", projectId)).json()).toEqual(committed);
    expect((await request("owner", projectId)).json()).toEqual(initial);
    expect((await request("owner", otherProjectId)).json()).toEqual(initial);

    // The database role also filters by user, and by project for that user.
    const count = (who: string, activeProject: string) =>
      userScoped(
        {
          workspaceId,
          projectId: activeProject,
          userId: users[who]!.id,
          role: "viewer",
        },
        (tx) => tx.projectHomeLayout.count(),
      );
    expect(await count("viewer", projectId)).toBe(1);
    expect(await count("viewer", otherProjectId)).toBe(0);
    expect(await count("owner", projectId)).toBe(0);
    expect(
      await scoped(workspaceId, projectId, (tx) =>
        tx.projectHomeLayout.count(),
      ),
    ).toBe(0);

    const empty = await request("viewer", projectId, {
      revision: 1,
      widgets: [],
    });
    expect(empty.json()).toEqual({ revision: 2, widgets: [] });
    const reset = await request("viewer", projectId, {
      revision: 2,
      widgets: null,
    });
    expect(reset.json()).toEqual({ revision: 3, widgets: null });
    expect((await request("viewer", projectId)).json()).toEqual(reset.json());

    // An organization owner without an explicit ProjectMember row can save.
    const owner = await request("owner", otherProjectId, {
      revision: 0,
      widgets,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ revision: 1, widgets });
  });

  it("rejects invalid settings and leaves the saved revision intact", async () => {
    const before = (await request("owner", projectId)).json();
    for (const payload of [
      { ...before, userId: users.viewer!.id },
      { ...before, widgets: [widgets[0], widgets[0]] },
      { ...before, widgets: [{ ...widgets[0], size: "invalid" }] },
      { ...before, widgets: [{ ...widgets[0], id: "not namespaced" }] },
      {
        ...before,
        widgets: Array.from({ length: 101 }, (_, i) => ({
          id: `test.w${i}`,
          size: "compact",
        })),
      },
    ])
      expect((await request("owner", projectId, payload)).statusCode).toBe(400);
    expect((await request("owner", projectId)).json()).toEqual(before);
  });

  it("does not serve layouts while the feature is disabled", async () => {
    process.env.ORBIT_HOME_WIDGETS = "false";
    const disabled = await buildServer();
    try {
      expect(
        (await request("owner", projectId, undefined, disabled)).statusCode,
      ).toBe(404);
      expect(
        (await request("owner", projectId, initial, disabled)).statusCode,
      ).toBe(404);
      const modules = await disabled.inject({
        url: `/api/projects/${projectId}/modules`,
        headers: { cookie: users.owner!.cookie },
      });
      expect(modules.json().features.homeWidgets).toBe(false);
    } finally {
      await disabled.close();
      process.env.ORBIT_HOME_WIDGETS = "true";
    }
  });
});
