import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { connectionAccess } from "../src/platform/connections/connections.ts";
import {
  assertAssignedSocialChannels,
  assignedPostizChannels,
} from "../src/modules/marketing/publishing/postiz-assignment.ts";

// Central Postiz channel assignment (ADR 0014): an organization connects
// Postiz once and hands each channel to exactly one project. A project
// with channels is bound automatically and uses only its channels; moving
// a channel away takes it from the project at once; a channel never goes
// to two projects, not even across organizations of a system connection.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  ORBIT_CONNECTIONS_CUTOVER: "postiz",
  ORBIT_MODULES: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const CHANNELS = [
  { id: "chan-x", name: "Desk on X", identifier: "x", disabled: false },
  { id: "chan-tg", name: "Desk Telegram", identifier: "telegram", disabled: false },
  { id: "chan-off", name: "Old page", identifier: "facebook", disabled: true },
];

describe.skipIf(!enabled)("Postiz channel assignment (ADR 0014)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const KEY = `postiz-${randomBytes(12).toString("hex")}`;
  const users: string[] = [];
  const workspaces: string[] = [];
  const who: Record<string, { id: string; cookie: string }> = {};
  let ws: string, other: string, p1: string, p2: string, p3: string, d1: string;
  let connectionId: string;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "PUT" | "POST",
    url: string,
    as: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: who[as]!.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const assign = (assignments: Record<string, string>, as = "owner", workspaceId = ws) =>
    call("PUT", `/api/organizations/${workspaceId}/connections/${connectionId}/channels`, as, {
      assignments,
    });
  const scope = (projectId: string, workspaceId = ws) =>
    ({ workspaceId, projectId, userId: who.owner!.id, role: "owner" }) as Scope;
  const bound = (projectId: string, id = connectionId, workspaceId = ws) =>
    scoped(workspaceId, projectId, async (tx) =>
      (await tx.entity.findMany({ where: { projectId, kind: "connectors" } })).find(
        (r) => (r.data as { centralConnectionId?: string }).centralConnectionId === id,
      ),
    );
  const marketing = (workspaceId: string, projectId: string, enabled = true) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "marketing", enabled, moduleVersion: "1" },
      }),
    );

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const emails: Record<string, string> = {};
    for (const key of ["owner", "otherOwner", "outsider", "admin"]) {
      emails[key] = `${randomUUID()}@example.invalid`;
      const r = await auth.api.signUpEmail({
        body: { email: emails[key]!, name: `Synthetic ${key}`, password },
      });
      users.push(r.user.id);
      who[key] = { id: r.user.id, cookie: "" };
    }
    await authDb.user.update({ where: { id: who.admin!.id }, data: { role: "admin" } });
    const a = await authDb.workspace.create({
      data: {
        name: "Synthetic channels",
        members: { create: { userId: who.owner!.id, role: "owner" } },
        projects: { create: [{ name: "P1" }, { name: "P2" }, { name: "P3" }] },
      },
      include: { projects: true },
    });
    const b = await authDb.workspace.create({
      data: {
        name: "Synthetic channels other",
        members: { create: { userId: who.otherOwner!.id, role: "owner" } },
        projects: { create: [{ name: "D1" }] },
      },
      include: { projects: true },
    });
    workspaces.push(a.id, b.id);
    ws = a.id;
    other = b.id;
    const byName = (n: string) => a.projects.find((p) => p.name === n)!.id;
    [p1, p2, p3] = [byName("P1"), byName("P2"), byName("P3")];
    d1 = b.projects[0]!.id;
    // Marketing is on for P1, P2 and D1; P3 has it off.
    await marketing(ws, p1);
    await marketing(ws, p2);
    await marketing(other, d1);
    await marketing(ws, p3, false);
    for (const key of Object.keys(who)) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email: emails[key], password },
      });
      const set = r.headers["set-cookie"];
      who[key]!.cookie = (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ");
    }
    const created = await call("POST", `/api/organizations/${ws}/connections`, "owner", {
      provider: "postiz",
      label: "Company Postiz",
      config: { baseUrl: "https://postiz.example.invalid/api/public/v1" },
      secret: KEY,
    });
    expect(created.statusCode).toBe(201);
    connectionId = created.json().id;
    // What a successful check records (the check itself calls Postiz).
    await authDb.connection.update({
      where: { id: connectionId },
      data: {
        status: "read_verified",
        health: { at: new Date().toISOString(), ok: true, channels: CHANNELS },
      },
    });
  });
  afterAll(async () => {
    await authDb.connection.deleteMany({ where: { createdBy: { in: users } } });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lists the channels and the organization's projects, nothing assigned", async () => {
    const r = await call("GET", `/api/organizations/${ws}/connections/${connectionId}/channels`, "owner");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ cutover: true, assignments: {}, unavailable: [] });
    expect(r.json().channels.map((c: { id: string }) => c.id)).toEqual(CHANNELS.map((c) => c.id));
    expect(r.json().projects.map((p: { name: string }) => p.name)).toEqual(["P1", "P2", "P3"]);
    expect(r.body).not.toContain(KEY);
    // Nobody outside the organization sees or changes them.
    expect(
      (await call("GET", `/api/organizations/${ws}/connections/${connectionId}/channels`, "outsider")).statusCode,
    ).toBe(404);
    expect((await assign({ "chan-x": p1 }, "otherOwner", other)).statusCode).toBe(404);
  });

  it("binds each project with channels and gives it only its channels", async () => {
    const r = await assign({ "chan-x": p1, "chan-tg": p2 });
    expect(r.statusCode).toBe(200);
    expect(r.json().attached).toEqual({ [p1]: true, [p2]: true });
    const row = await bound(p1);
    expect(row?.data).toMatchObject({
      provider: "postiz",
      status: "read_verified",
      allowedChannelIds: ["chan-x"],
    });
    expect((row!.data as Record<string, unknown>).encryptedCredential).toBeUndefined();
    expect(assignedPostizChannels(row!.data as Record<string, unknown>).map((c: any) => c.id)).toEqual([
      "chan-x",
    ]);
    expect(
      await scoped(ws, p1, (tx) =>
        connectionAccess(tx, scope(p1), row!.data as Record<string, unknown>),
      ),
    ).toMatchObject({ credential: KEY });
    await scoped(ws, p1, (tx) => assertAssignedSocialChannels(tx, scope(p1), ["chan-x"]));
    await expect(
      scoped(ws, p1, (tx) => assertAssignedSocialChannels(tx, scope(p1), ["chan-tg"])),
    ).rejects.toMatchObject({ code: "POSTIZ_CHANNEL_NOT_ASSIGNED" });
    const grants = await authDb.connectionGrant.findMany({
      where: { connectionId, revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(grants.map((g) => [g.projectId, (g.settings as any).channels])).toEqual([
      [p1, ["chan-x"]],
      [p2, ["chan-tg"]],
    ]);
  });

  it("refuses unknown or disabled channels, foreign projects and channels in plain grants", async () => {
    expect((await assign({ "chan-off": p1 })).json().error.code).toBe("CHANNEL_UNKNOWN");
    expect((await assign({ "chan-nope": p1 })).json().error.code).toBe("CHANNEL_UNKNOWN");
    expect((await assign({ "chan-x": d1 })).statusCode).toBe(404);
    const plain = await call("POST", `/api/organizations/${ws}/connections/${connectionId}/grants`, "owner", {
      projectId: p3,
      settings: { channels: ["chan-x"] },
    });
    expect(plain.json().error.code).toBe("USE_CHANNEL_ASSIGNMENT");
  });

  it("moves a channel: the old project loses it and, without channels, its access", async () => {
    const r = await assign({ "chan-x": p1, "chan-tg": p1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().assignments).toEqual({ "chan-x": p1, "chan-tg": p1 });
    expect((await bound(p1))?.data).toMatchObject({ allowedChannelIds: ["chan-tg", "chan-x"] });
    const old = await bound(p2);
    expect(old?.data).toMatchObject({ allowedChannelIds: [] });
    expect(assignedPostizChannels(old!.data as Record<string, unknown>)).toEqual([]);
    await expect(
      scoped(ws, p2, (tx) => connectionAccess(tx, scope(p2), old!.data as Record<string, unknown>)),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_GRANTED" });
    const audit = await authDb.systemAuditEvent.findMany({
      where: { targetId: connectionId, action: "connection.channels_assigned" },
    });
    expect(audit).toHaveLength(2);
  });

  it("grants a project without the module but binds it only once the module is on", async () => {
    const r = await assign({ "chan-x": p1, "chan-tg": p3 });
    expect(r.json().attached).toEqual({ [p1]: true, [p3]: false });
    expect(await bound(p3)).toBeUndefined();
  });

  it("needs the provider's cutover", async () => {
    process.env.ORBIT_CONNECTIONS_CUTOVER = "";
    try {
      expect((await assign({ "chan-x": p1 })).json().error.code).toBe("CUTOVER_NOT_ENABLED");
    } finally {
      process.env.ORBIT_CONNECTIONS_CUTOVER = "postiz";
    }
  });

  it("keeps a system connection's channel with one project across organizations", async () => {
    const created = await call("POST", "/api/admin/connections", "admin", {
      provider: "postiz",
      label: "System Postiz",
      config: { baseUrl: "https://postiz.example.invalid/api/public/v1" },
      secret: `${KEY}-system`,
    });
    expect(created.statusCode).toBe(201);
    const system = created.json().id as string;
    await authDb.connection.update({
      where: { id: system },
      data: { status: "read_verified", health: { at: new Date().toISOString(), channels: CHANNELS } },
    });
    for (const workspaceId of [ws, other])
      expect(
        (
          await call("POST", `/api/admin/connections/${system}/grants`, "admin", { workspaceId })
        ).statusCode,
      ).toBe(201);
    const path = (workspaceId: string) =>
      `/api/organizations/${workspaceId}/connections/${system}/channels`;
    expect(
      (await call("PUT", path(ws), "owner", { assignments: { "chan-x": p2 } })).statusCode,
    ).toBe(200);
    const taken = await call("PUT", path(other), "otherOwner", { assignments: { "chan-x": d1 } });
    expect(taken.json().error.code).toBe("CHANNEL_ASSIGNED_ELSEWHERE");
    const seen = await call("GET", path(other), "otherOwner");
    expect(seen.json().unavailable).toEqual(["chan-x"]);
    // The administrator assigns for an organization, naming it.
    const byAdmin = await call("PUT", `/api/admin/connections/${system}/channels`, "admin", {
      workspaceId: other,
      assignments: { "chan-tg": d1 },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect((await bound(d1, system, other))?.data).toMatchObject({ allowedChannelIds: ["chan-tg"] });
  });
});
