import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { ServerModule } from "../../../packages/module-contracts/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  moduleRegistry,
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { sortAttention } from "../src/platform/attention/attention.ts";
import type {
  AttentionContribution,
  AttentionItem,
  AttentionResponse,
} from "../src/platform/attention/types.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// Two modules that exist only in this file; each test sets what they answer.
const handlers: Record<"fake_a" | "fake_b", AttentionContribution> = {
  fake_a: async () => [],
  fake_b: async () => [],
};
const fakeModule = (id: "fake_a" | "fake_b"): ServerModule => ({
  id,
  version: "1.0.0",
  displayName: { en: id, de: id },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [],
  tables: [],
  permissions: [],
});
registerTestModules(
  (["fake_a", "fake_b"] as const).map((id) => ({
    module: fakeModule(id),
    contributions: {
      attention: (tx, scope, now) => handlers[id](tx, scope, now),
    },
  })),
);
registerModules();

const item = (
  moduleId: string,
  id: string,
  extra: Partial<AttentionItem> = {},
): AttentionItem => ({
  id: `${moduleId}:${id}`,
  moduleId,
  kind: `${moduleId}_thing`,
  severity: "warning",
  params: {},
  navKey: moduleId,
  link: `/${moduleId}`,
  ...extra,
});

/**
 * The project's attention items (UI restructure §4.1): one route over every
 * enabled module the member may use, sorted, capped, counted per nav entry.
 */
describe.skipIf(!enabled)("project attention", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  const ids = { owner: "", viewer: "" };
  const cookies = { owner: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const logs = new PassThrough();
  let raw = "";
  logs.on("data", (chunk) => (raw += chunk.toString()));
  const logLines = () =>
    raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const get = (who: keyof typeof cookies) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${scope.projectId}/attention`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
  const attention = async (who: keyof typeof cookies) => {
    const response = await get(who);
    expect(response.statusCode).toBe(200);
    return response.json() as AttentionResponse;
  };

  beforeAll(async () => {
    // tests/setup.ts silences the logger; the throwing case reads the log.
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    app = await buildServer(undefined, { logStream: logs });
    if (level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = level;
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "viewer"] as const) {
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
        name: "Synthetic attention",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic attention" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ids.owner,
      role: "owner",
    };
    await authDb.projectMember.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: ids.viewer,
        role: "viewer",
      },
    });
    for (const who of ["owner", "viewer"] as const) {
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
  afterEach(async () => {
    handlers.fake_a = async () => [];
    handlers.fake_b = async () => [];
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_MODULE_ROLES;
    await authDb.projectMemberModuleRole.deleteMany({
      where: { projectId: scope.projectId },
    });
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("sorts critical before warning, then by dueAt", async () => {
    handlers.fake_a = async () => [
      item("fake_a", "info", { severity: "info" }),
      item("fake_a", "late", { dueAt: "2026-10-20T10:00:00.000Z" }),
      item("fake_a", "undated-old", { since: "2026-10-01T10:00:00.000Z" }),
    ];
    handlers.fake_b = async () => [
      item("fake_b", "undated-new", { since: "2026-10-02T10:00:00.000Z" }),
      item("fake_b", "early", { dueAt: "2026-10-19T10:00:00.000Z" }),
      item("fake_b", "critical", { severity: "critical" }),
    ];
    const body = await attention("owner");
    expect(body.items.map((i) => i.id)).toEqual([
      "fake_b:critical",
      "fake_b:early",
      "fake_a:late",
      "fake_a:undated-old",
      "fake_b:undated-new",
      "fake_a:info",
    ]);
  });

  it("orders equal items by since, then by id", () => {
    const sorted = sortAttention([
      item("m", "b"),
      item("m", "a"),
      item("m", "c", { since: "2026-10-02T00:00:00.000Z" }),
      item("m", "d", { since: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["m:d", "m:c", "m:a", "m:b"]);
  });

  it("skips a disabled module", async () => {
    process.env.ORBIT_MODULES = "true";
    let called = false;
    handlers.fake_a = async () => [item("fake_a", "one")];
    handlers.fake_b = async () => {
      called = true;
      return [item("fake_b", "one")];
    };
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      setModuleEnabled(tx, scope, moduleRegistry(), "fake_b", false),
    );
    try {
      const body = await attention("owner");
      expect(body.items.map((i) => i.id)).toEqual(["fake_a:one"]);
      expect(body.counts).toEqual({ fake_a: 1 });
      expect(called).toBe(false);
    } finally {
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        setModuleEnabled(tx, scope, moduleRegistry(), "fake_b", true),
      );
    }
  });

  it("skips a module with role none", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    handlers.fake_a = async () => [item("fake_a", "one")];
    handlers.fake_b = async () => [item("fake_b", "one")];
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: ids.viewer,
        moduleId: "fake_b",
        role: "none",
        changedBy: ids.owner,
      },
    });
    expect((await attention("viewer")).items.map((i) => i.id)).toEqual([
      "fake_a:one",
    ]);
    // Owners keep every module.
    expect((await attention("owner")).items.map((i) => i.id).sort()).toEqual([
      "fake_a:one",
      "fake_b:one",
    ]);
  });

  it("counts per navKey before the 50 cap", async () => {
    handlers.fake_a = async () =>
      Array.from({ length: 60 }, (_, n) =>
        item("fake_a", String(n).padStart(2, "0"), { navKey: "x" }),
      );
    handlers.fake_b = async () => [
      item("fake_b", "one", { navKey: "y", severity: "info" }),
    ];
    const body = await attention("owner");
    expect(body.items).toHaveLength(50);
    expect(body.counts).toEqual({ x: 60, y: 1 });
    // The cap drops the least urgent: the info item goes first.
    expect(body.items.some((i) => i.navKey === "y")).toBe(false);
  });

  it("an aggregated item adds its count to its navKey (R17)", async () => {
    handlers.fake_a = async () => [
      item("fake_a", "unassigned", { navKey: "x", count: 2 }),
      item("fake_a", "single", { navKey: "x" }),
    ];
    handlers.fake_b = async () =>
      Array.from({ length: 55 }, (_, n) =>
        item("fake_b", String(n).padStart(2, "0"), {
          navKey: "y",
          severity: "info",
          count: 3,
        }),
      );
    const body = await attention("owner");
    expect(body.items).toHaveLength(50);
    expect(body.counts).toEqual({ x: 3, y: 165 });
  });

  it("contribution receives the module scope", async () => {
    process.env.ORBIT_MODULE_ROLES = "true";
    const seen: Record<string, { role: string; now: unknown }> = {};
    handlers.fake_a = async (_tx, s, now) => {
      seen.fake_a = { role: s.role, now };
      return [];
    };
    handlers.fake_b = async (_tx, s, now) => {
      seen.fake_b = { role: s.role, now };
      return [];
    };
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: ids.viewer,
        moduleId: "fake_a",
        role: "editor",
        changedBy: ids.owner,
      },
    });
    await attention("viewer");
    expect(seen.fake_a?.role).toBe("editor");
    expect(seen.fake_b?.role).toBe("viewer");
    expect(seen.fake_a?.now).toBeInstanceOf(Date);
    expect(seen.fake_b?.now).toBe(seen.fake_a?.now);
  });

  it("answers no-store", async () => {
    const response = await get("viewer");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reports the project's paused flag", async () => {
    expect((await attention("viewer")).status).toEqual({ paused: false });
    await authDb.project.update({
      where: { id: scope.projectId },
      data: { paused: true },
    });
    try {
      expect((await attention("viewer")).status).toEqual({ paused: true });
    } finally {
      await authDb.project.update({
        where: { id: scope.projectId },
        data: { paused: false },
      });
    }
  });

  it("a contribution that throws fails the route and logs its module", async () => {
    handlers.fake_a = async () => [item("fake_a", "one")];
    handlers.fake_b = async () => {
      throw new Error("secret detail of fake_b");
    };
    raw = "";
    const response = await get("owner");
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("REQUEST_FAILED");
    expect(response.body).not.toContain("secret detail");
    const failed = logLines().find(
      (line) => line.msg === "attention contribution failed",
    );
    expect(failed).toMatchObject({ moduleId: "fake_b" });
    expect(raw).not.toContain("secret detail");
  });
});
