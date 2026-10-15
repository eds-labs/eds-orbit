import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  registeredAssistants,
  registeredToolOwner,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { enabledModules } from "../src/platform/modules/enforcement.ts";
import { sweepProject } from "../src/platform/jobs/scheduler.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/**
 * Module activation enforcement (WP2.4, docs/MODULE_ACTIVATION.md): with
 * ORBIT_MODULES on, a disabled module is hidden and blocked everywhere and
 * nothing is lost; with the flag off a recorded "disabled" changes nothing.
 */
describe.skipIf(!enabled)("Module activation enforcement", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${scope.projectId}${url}`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const switchModule = (id: string, on: boolean) =>
    call("PUT", `/modules/${id}`, { enabled: on });
  const snapshot = () =>
    run(async (tx) =>
      (
        await tx.entity.findMany({
          where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
          select: { id: true, kind: true, version: true },
        })
      ).sort((a, b) => a.id.localeCompare(b.id)),
    );

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic enforcement owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic module enforcement",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set])
      .map((v) => v!.split(";")[0])
      .join("; ");
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { name: "Synthetic enforcement", workspaceId: workspace.id },
    });
    expect(project.statusCode).toBe(201);
    scope = {
      workspaceId: workspace.id,
      projectId: project.json().id,
      userId: created.user.id,
      role: "owner",
    };
    // A mission the marketing sweep would start, and a knowledge source.
    await run(async (tx) => {
      await create(tx, scope, "missions", {
        title: "Synthetic mission",
        status: "ready",
        maxContents: 1,
        completedRuns: 0,
        startAt: new Date(Date.now() - HOUR).toISOString(),
        endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
      });
      await create(tx, scope, "sources", {
        name: "Synthetic source",
        status: "active",
        generation: 1,
      });
    });
  });
  // Every test starts with knowledge and marketing on, even after a failed one.
  afterEach(async () => {
    process.env.ORBIT_MODULES = "true";
    await switchModule("knowledge", true);
    await switchModule("marketing", true);
    delete process.env.ORBIT_MODULES;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("changes nothing while the flag is off, whatever the table records", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    delete process.env.ORBIT_MODULES;
    expect((await call("GET", "/missions")).statusCode).toBe(200);
    expect((await call("GET", "/marketing-profile")).statusCode).toBe(200);
    expect(await run((tx) => enabledModules(tx, scope))).toBeUndefined();
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", true)).statusCode).toBe(200);
  });

  it("hides and blocks a disabled module everywhere and loses nothing", async () => {
    process.env.ORBIT_MODULES = "true";
    const before = await snapshot();
    expect((await switchModule("marketing", false)).statusCode).toBe(200);

    // Routes, actions and collections of marketing.
    for (const [method, url, payload] of [
      ["GET", "/marketing-profile"],
      ["GET", "/missions"],
      ["POST", "/missions", {}],
      ["POST", "/actions/analyze", {}],
      ["POST", "/actions/render", {}],
    ] as const) {
      const response = await call(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        "MODULE_DISABLED",
      );
    }
    // Knowledge and the platform keep working.
    expect((await call("GET", "/sources")).statusCode).toBe(200);
    expect((await call("GET", "/modules")).statusCode).toBe(200);

    // No marketing tool or prompt fragment reaches the assistant.
    const on = await run((tx) => enabledModules(tx, scope));
    expect([...on!]).toEqual(["knowledge"]);
    expect(
      registeredTools(on).filter(
        (tool) => registeredToolOwner(tool.name) === "marketing",
      ),
    ).toEqual([]);
    expect(registeredAssistants(on)).toEqual([]);

    // The marketing sweep does not run: the due mission queues nothing.
    expect(await run((tx) => sweepProject(tx, scope))).toEqual({ queued: 0 });

    // Turning it on again restores everything unchanged.
    expect((await switchModule("marketing", true)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await call("GET", "/missions")).statusCode).toBe(200);
    expect((await call("GET", "/marketing-profile")).statusCode).toBe(200);
    expect(
      registeredTools(await run((tx) => enabledModules(tx, scope))),
    ).toHaveLength(registeredTools().length); // The same due mission is started once marketing is on again.
    expect((await run((tx) => sweepProject(tx, scope))).queued).toBeGreaterThan(
      0,
    );
  });

  it("switches knowledge off after marketing and keeps the assistant's search (WP3.3)", async () => {
    process.env.ORBIT_MODULES = "true";
    const before = await snapshot();
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    expect((await switchModule("knowledge", false)).statusCode).toBe(200);

    // The knowledge module's routes, collections and actions.
    for (const [method, url, payload] of [
      ["GET", "/knowledge-health"],
      ["GET", "/documents"],
      ["GET", "/indexes"],
      ["GET", "/sources"],
      ["POST", "/actions/retrieve", { query: "synthetic" }],
    ] as const) {
      const response = await call(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        "MODULE_DISABLED",
      );
    }
    // The knowledge services are the platform's: the assistant still searches.
    const on = await run((tx) => enabledModules(tx, scope));
    expect([...on!]).toEqual([]);
    expect(registeredTools(on).map((tool) => tool.name)).toEqual([
      "knowledge_search",
    ]);
    expect(registeredToolOwner("knowledge_search")).toBe("platform");

    // Marketing needs knowledge first; then everything is back unchanged.
    const early = await switchModule("marketing", true);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("MODULE_DEPENDENCY_DISABLED");
    expect((await switchModule("knowledge", true)).statusCode).toBe(200);
    expect((await switchModule("marketing", true)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await call("GET", "/knowledge-health")).statusCode).toBe(200);
  });

  it("keeps knowledge on while marketing is on", async () => {
    process.env.ORBIT_MODULES = "true";
    const refused = await switchModule("knowledge", false);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("MODULE_REQUIRED");
  });

  it("answers a non-member like before, without revealing the module state", async () => {
    process.env.ORBIT_MODULES = "true";
    expect((await switchModule("marketing", false)).statusCode).toBe(200);
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/projects/${scope.projectId}/marketing-profile`,
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await switchModule("marketing", true)).statusCode).toBe(200);
  });
});
