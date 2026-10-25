import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { defaultWorkSettings } from "../src/modules/work/settings.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The project management HTTP API (WP1.6): reachable only with ORBIT_WORK on
 * and the module enabled in the project; viewers read, editors change,
 * owners delete and manage the settings.
 */
describe.skipIf(!enabled)("project management routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic work ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic work",
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
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic work" } })).id;
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
    process.env.ORBIT_WORK = "true";
    process.env.ORBIT_MODULES = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_WORK;
    delete process.env.ORBIT_MODULES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("answers 404 until the module is on for the installation and the project", async () => {
    delete process.env.ORBIT_WORK;
    const off = await call("owner", "GET", "/work/overview");
    expect([off.statusCode, code(off)]).toEqual([404, "WORK_DISABLED"]);
    process.env.ORBIT_WORK = "true";
    const notEnabled = await call("owner", "GET", "/work/overview");
    expect(notEnabled.statusCode).toBe(404);
    const enable = await call("owner", "PUT", "/modules/work", { enabled: true });
    expect(enable.statusCode).toBe(200);
    const on = await call("viewer", "GET", "/work/overview");
    expect(on.statusCode).toBe(200);
    expect(on.json().counts.open).toBe(0);
  });

  it("lets editors work, viewers read and only owners delete", async () => {
    const initiative = await call("editor", "POST", "/work/initiatives", { title: "Marketplace launch" });
    expect(initiative.statusCode).toBe(200);
    const { id: initiativeId, key } = initiative.json();
    expect(key).toBe("ML");
    const created = await call("editor", "POST", "/work/tasks", {
      title: "Write the launch post",
      initiativeId,
      assigneeUserId: ids.editor,
      dueDate: "2026-12-01",
    });
    expect(created.statusCode).toBe(200);
    const task = created.json();
    expect(task).toMatchObject({ number: 1, status: "todo", initiativeId });
    expect((await call("viewer", "POST", "/work/tasks", { title: "x" })).statusCode).toBe(403);
    const list = await call("viewer", "GET", "/work/tasks?open=true");
    expect(list.json().items.map((t: { id: string }) => t.id)).toEqual([task.id]);
    const patched = await call("editor", "PATCH", `/work/tasks/${task.id}`, {
      expectedVersion: task.version,
      status: "in_progress",
    });
    expect(patched.json()).toMatchObject({ status: "in_progress", statusCategory: "in_progress" });
    const stale = await call("editor", "PATCH", `/work/tasks/${task.id}`, { expectedVersion: task.version, priority: "high" });
    expect([stale.statusCode, code(stale)]).toEqual([409, "WORK_VERSION_CONFLICT"]);
    const comment = await call("editor", "POST", `/work/tasks/${task.id}/comments`, { body: "Draft is ready" });
    expect(comment.statusCode).toBe(200);
    expect((await call("viewer", "POST", `/work/tasks/${task.id}/comments`, { body: "x" })).statusCode).toBe(403);
    const detail = await call("viewer", "GET", `/work/tasks/${task.id}`);
    expect(detail.json().timeline.map((e: { kind: string; type?: string }) => e.type ?? e.kind)).toEqual([
      "created",
      "status",
      "comment",
    ]);
    expect((await call("editor", "DELETE", `/work/tasks/${task.id}`)).statusCode).toBe(403);
    expect((await call("owner", "DELETE", `/work/tasks/${task.id}`)).statusCode).toBe(200);
    expect((await call("viewer", "GET", `/work/tasks/${task.id}`)).statusCode).toBe(404);
  });

  it("refuses unknown fields and malformed ids", async () => {
    const extra = await call("editor", "POST", "/work/tasks", { title: "x", secret: true });
    expect([extra.statusCode, code(extra)]).toEqual([400, "VALIDATION_FAILED"]);
    expect((await call("viewer", "GET", "/work/tasks/not-a-uuid")).statusCode).toBe(400);
    expect((await call("viewer", "GET", `/work/tasks/${randomUUID()}`)).statusCode).toBe(404);
    const source = (await call("editor", "POST", "/work/tasks", { title: "Source" })).json();
    const link = await call("editor", "POST", `/work/tasks/${source.id}/links`, {
      targetType: "nobody.thing",
      targetId: randomUUID(),
      relation: "relates_to",
    });
    expect(link.statusCode).toBe(422);
  });

  it("links tasks to each other and lists link targets", async () => {
    const a = (await call("editor", "POST", "/work/tasks", { title: "Alpha task" })).json();
    const b = (await call("editor", "POST", "/work/tasks", { title: "Beta task" })).json();
    const targets = await call("editor", "GET", "/work/link-targets?type=work.task&q=Beta");
    expect(targets.json().items.map((t: { id: string }) => t.id)).toEqual([b.id]);
    const link = await call("editor", "POST", `/work/tasks/${a.id}/links`, {
      targetType: "work.task",
      targetId: b.id,
      relation: "relates_to",
    });
    expect(link.statusCode).toBe(200);
    const seen = await call("viewer", "GET", `/work/tasks/${b.id}/links`);
    expect(seen.json().items[0]).toMatchObject({ direction: "incoming", object: { id: a.id, state: "ok" } });
    expect((await call("editor", "DELETE", `/work/links/${link.json().id}`)).statusCode).toBe(200);
    expect((await call("viewer", "GET", `/work/tasks/${b.id}/links`)).json().items).toEqual([]);
  });

  it("keeps the settings with the owner and refuses removing a used status", async () => {
    const read = await call("viewer", "GET", "/work/settings");
    expect(read.statusCode).toBe(200);
    const { settings, version } = read.json();
    expect(settings.workflow.statuses).toHaveLength(7);
    const next = defaultWorkSettings();
    next.categories = [{ key: "bug", label: "Bug", color: "red" }];
    expect((await call("editor", "PUT", "/work/settings", { settings: next, version })).statusCode).toBe(403);
    const saved = await call("owner", "PUT", "/work/settings", { settings: next, version });
    expect(saved.statusCode).toBe(200);
    const withoutTodo = {
      ...next,
      workflow: { statuses: next.workflow.statuses.filter((s) => s.key !== "todo") },
    };
    const refused = await call("owner", "PUT", "/work/settings", { settings: withoutTodo, version: saved.json().version });
    expect([refused.statusCode, code(refused)]).toEqual([409, "WORK_STATUS_IN_USE"]);
    const badTeam = { ...next, teams: [{ key: "dev", name: "Dev", memberUserIds: [randomUUID()] }] };
    const team = await call("owner", "PUT", "/work/settings", { settings: badTeam, version: saved.json().version });
    expect(code(team)).toBe("WORK_TEAM_MEMBER_INVALID");
  });

  it("moves a status's tasks along when its category changes", async () => {
    const created = await call("editor", "POST", "/work/tasks", { title: "Waiting for review", status: "in_review" });
    expect(created.statusCode).toBe(200);
    const taskId: string = created.json().id;
    const recategorize = async (category: string) => {
      const { settings, version } = (await call("owner", "GET", "/work/settings")).json();
      settings.workflow.statuses = settings.workflow.statuses.map((s: { key: string }) =>
        s.key === "in_review" ? { ...s, category } : s,
      );
      expect((await call("owner", "PUT", "/work/settings", { settings, version })).statusCode).toBe(200);
      return scoped(workspaceId, projectId, async (tx) => ({
        task: await tx.workTask.findFirstOrThrow({ where: { id: taskId } }),
        history: await tx.workEvent.findMany({ where: { taskId, type: "status" }, orderBy: { createdAt: "asc" } }),
        events: await tx.domainEvent.findMany({
          where: { subjectId: taskId, type: "work.task.status_changed" },
          orderBy: { createdAt: "asc" },
        }),
      }));
    };
    const done = await recategorize("done");
    expect(done.task).toMatchObject({ status: "in_review", statusCategory: "done", version: 2 });
    expect(done.task.completedAt).toBeInstanceOf(Date);
    expect(done.history.at(-1)).toMatchObject({
      actorKind: "user",
      actorId: ids.owner,
      before: { statusCategory: "in_review" },
      after: { statusCategory: "done" },
    });
    expect(done.events.at(-1)!.data).toMatchObject({ fromCategory: "in_review", toCategory: "done" });
    const back = await recategorize("in_review");
    expect(back.task).toMatchObject({ statusCategory: "in_review", completedAt: null, version: 3 });
    expect(back.events).toHaveLength(2);
  });

  it("serves my tasks and the members list", async () => {
    const members = await call("viewer", "GET", "/work/members");
    expect(members.json().items.map((m: { userId: string; role: string }) => [m.userId, m.role]).sort()).toEqual(
      [[ids.editor, "editor"], [ids.owner, "owner"], [ids.viewer, "viewer"]].sort(),
    );
    await call("owner", "POST", "/work/tasks", { title: "For the editor", assigneeUserId: ids.editor, dueDate: "2020-01-01" });
    const mine = await call("editor", "GET", "/work/my");
    expect(mine.json().overdue.map((t: { title: string }) => t.title)).toContain("For the editor");
  });
});
