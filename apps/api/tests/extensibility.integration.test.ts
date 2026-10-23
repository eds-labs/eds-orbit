import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import {
  modules,
  moduleRegistry,
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import {
  registeredActionPermission,
  registeredActionType,
  registeredRegistry,
  registeredRoutesByOwner,
  registeredSchedulers,
  registeredToolOwner,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { availableTools } from "../src/modules/agents/tools/registry.ts";
import { enabledModules } from "../src/platform/modules/enforcement.ts";
import { sweepProject } from "../src/platform/jobs/scheduler.ts";
import {
  sweeps,
  tasksContributions,
  tasksFixture,
} from "./fixtures/modules/tasks/contributions.ts";
import { TASKS_MANAGE } from "./fixtures/modules/tasks/manifest.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// A third module, test only, before the server registers the modules (WP4.1).
registerTestModules([tasksFixture]);
registerModules();

/**
 * Extensibility (WP4.1, plans/orbit-modularization/07 §Phase 4): a third
 * module plugs in through the contracts alone. Its kind, permissions,
 * route, collection, action, tool, action type and scheduler work like the
 * built-in modules', and switching it off removes every one of them.
 */
describe("a third module through the contracts alone", () => {
  it("registers next to the static modules, never in production", () => {
    // Dependency order, ties alphabetical: finance, support and tasks need
    // nothing, marketing needs knowledge.
    expect(registeredRegistry().order).toEqual([
      "finance",
      "knowledge",
      "support",
      "tasks",
      "marketing",
    ]);
    expect(registeredRegistry().kindOwner.get("fixture_tasks")).toBe("tasks");
    expect(registeredRegistry().collectionKinds).toEqual([
      "marketing_plans",
      "fixture_tasks",
    ]);
    expect(registeredRegistry().kindOwner.get("marketing_plans")).toBe(
      "marketing",
    );
    expect(registeredToolOwner("propose_tasks")).toBe("tasks");
    expect(registeredActionType("tasks.create")).toBeDefined();
    expect(registeredActionPermission("complete-task")).toBe(TASKS_MANAGE);
    expect(registeredSchedulers()).toContain(tasksContributions.scheduler);
    expect(registeredRoutesByOwner().map(([owner]) => owner)).toContain(
      "tasks",
    );
    // The API and the worker register the static list only.
    expect(modules.map((m) => m.id)).toEqual([
      "knowledge",
      "marketing",
      "support",
      "finance",
    ]);
    expect(moduleRegistry().modules.map((m) => m.id)).toContain("tasks");
  });

  it("offers its proposal tool to owners and editors, not to viewers", () => {
    const offered = (role: Scope["role"]) =>
      availableTools(registeredTools(), role).map((tool) => tool.name);
    expect(offered("owner")).toContain("propose_tasks");
    expect(offered("editor")).toContain("propose_tasks");
    expect(offered("viewer")).not.toContain("propose_tasks");
  });
});

describe.skipIf(!enabled)("the third module over HTTP", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let otherProjectId: string;
  let taskId: string;
  const users: string[] = [];
  const workspaces: string[] = [];
  const cookies: Record<"owner" | "editor" | "viewer", string> = {
    owner: "",
    editor: "",
    viewer: "",
  };
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof cookies,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
    projectId = owner.projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const switchModule = (id: string, on: boolean) =>
    call("owner", "PUT", `/modules/${id}`, { enabled: on });

  beforeAll(async () => {
    app = await buildServer();
    const account = async () => {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: "Synthetic extensibility user", password },
      });
      users.push(created.user.id);
      return { id: created.user.id, email, password };
    };
    const signIn = async (
      who: keyof typeof cookies,
      email: string,
      password: string,
    ) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    };
    const [o, e, v] = [await account(), await account(), await account()];
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic extensibility",
        members: {
          create: [
            { userId: o.id, role: "owner" },
            { userId: e.id, role: "viewer" },
            { userId: v.id, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic extensibility" },
    });
    const other = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic other project" },
    });
    otherProjectId = other.id;
    for (const [userId, role] of [
      [e.id, "editor"],
      [v.id, "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          userId,
          role,
        },
      });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: o.id,
      role: "owner",
    };
    taskId = (
      await run((tx) =>
        create(tx, owner, "fixture_tasks", { title: "Synthetic task" }),
      )
    ).id;
    await signIn("owner", o.email, o.password);
    await signIn("editor", e.email, e.password);
    await signIn("viewer", v.email, v.password);
  });
  afterAll(async () => {
    delete process.env.ORBIT_MODULES;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("serves its route and collection to every member and nobody else", async () => {
    for (const who of ["owner", "editor", "viewer"] as const) {
      const route = await call(who, "GET", "/fixture-tasks");
      expect(route.statusCode, who).toBe(200);
      expect(route.json().items).toEqual([
        { id: taskId, title: "Synthetic task" },
      ]);
      expect((await call(who, "GET", "/fixture_tasks")).statusCode, who).toBe(
        200,
      );
    }
    // The editor is no member of the other project.
    const outside = await call(
      "editor",
      "GET",
      "/fixture-tasks",
      undefined,
      otherProjectId,
    );
    expect(outside.statusCode).toBe(404);
  });

  it("checks its own action permission: editors complete tasks, viewers cannot", async () => {
    const refused = await call("viewer", "POST", "/actions/complete-task", {
      id: taskId,
    });
    expect(refused.statusCode).toBe(403);
    const done = await call("editor", "POST", "/actions/complete-task", {
      id: taskId,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({ done: true });
  });

  it("disappears everywhere while switched off and comes back unchanged", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("tasks", false)).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ["GET", "/fixture-tasks"],
      ["GET", "/fixture_tasks"],
      ["POST", "/actions/complete-task", { id: taskId }],
    ] as const) {
      const response = await call("owner", method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        "MODULE_DISABLED",
      );
    }
    const on = await run((tx) => enabledModules(tx, owner));
    expect([...on!].sort()).toEqual(["knowledge", "marketing"]);
    expect(registeredTools(on).map((t) => t.name)).not.toContain(
      "propose_tasks",
    );
    expect(registeredSchedulers(on)).not.toContain(
      tasksContributions.scheduler,
    );
    const before = sweeps.count;
    await run((tx) => sweepProject(tx, owner));
    expect(sweeps.count).toBe(before);

    expect((await switchModule("tasks", true)).statusCode).toBe(200);
    expect((await call("owner", "GET", "/fixture-tasks")).statusCode).toBe(200);
    await run((tx) => sweepProject(tx, owner));
    expect(sweeps.count).toBe(before + 1);
    delete process.env.ORBIT_MODULES;
  });
});
