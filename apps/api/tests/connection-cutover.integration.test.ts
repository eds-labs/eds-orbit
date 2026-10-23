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
import { connectionAccess } from "../src/platform/connections/connections.ts";
import { encrypt } from "../src/platform/shared.ts";

// Provider cutover (ADR 0014, WP3.4): a project connection bound to a
// granted central connection reads the central key, only while the grant
// holds and the provider's cutover is on; project connections with their
// own key keep working unchanged.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  ORBIT_CONNECTIONS_CUTOVER: "postiz",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

describe.skipIf(!enabled)("Postiz cutover to central connections (ADR 0014)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const KEY = `postiz-${randomBytes(12).toString("hex")}`;
  const users: string[] = [];
  let owner: { id: string; cookie: string };
  let ws: string, p1: string, p2: string, connectionId: string, grantId: string;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (method: "POST" | "DELETE" | "GET", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: owner.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const attach = (project: string) =>
    call("POST", `/api/projects/${project}/actions/connector-attach`, { connectionId });
  const access = async (project: string) =>
    scoped(ws, project, async (tx) => {
      const row = (await tx.entity.findMany({ where: { projectId: project, kind: "connectors" } })).find(
        (r) => (r.data as { provider?: string }).provider === "postiz",
      )!;
      return connectionAccess(tx, { workspaceId: ws, projectId: project }, row.data as Record<string, unknown>);
    });

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name: "Synthetic owner", password } });
    users.push(r.user.id);
    const w = await authDb.workspace.create({
      data: {
        name: "Synthetic cutover",
        members: { create: { userId: r.user.id, role: "owner" } },
        projects: { create: [{ name: "P1" }, { name: "P2" }] },
      },
      include: { projects: true },
    });
    ws = w.id;
    p1 = w.projects.find((p) => p.name === "P1")!.id;
    p2 = w.projects.find((p) => p.name === "P2")!.id;
    // Marketing (and with it Postiz) is on for both projects.
    for (const project of [p1, p2])
      await scoped(ws, project, (tx) =>
        tx.projectModule.create({
          data: { workspaceId: ws, projectId: project, moduleId: "marketing", enabled: true, moduleVersion: "1" },
        }),
      );
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    const set = signIn.headers["set-cookie"];
    owner = { id: r.user.id, cookie: (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ") };
    const created = await call("POST", `/api/organizations/${ws}/connections`, {
      provider: "postiz",
      label: "Company Postiz",
      config: { baseUrl: "https://postiz.example.invalid/api/public/v1" },
      secret: KEY,
    });
    expect(created.statusCode).toBe(201);
    connectionId = created.json().id;
    const grant = await call("POST", `/api/organizations/${ws}/connections/${connectionId}/grants`, { projectId: p1 });
    expect(grant.statusCode).toBe(201);
    grantId = grant.json().id;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: ws } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("binds the granted connection without storing a key in the project", async () => {
    const r = await attach(p1);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(KEY);
    const row = await scoped(ws, p1, (tx) => tx.entity.findFirstOrThrow({ where: { id: r.json().id } }));
    expect(row.data).toMatchObject({ provider: "postiz", centralConnectionId: connectionId, status: "configured" });
    expect((row.data as Record<string, unknown>).encryptedCredential).toBeUndefined();
    expect(await access(p1)).toEqual({ credential: KEY, baseUrl: "https://postiz.example.invalid/api/public/v1" });
    // A project without a grant cannot bind it.
    expect((await attach(p2)).json().error.code).toBe("CONNECTION_NOT_GRANTED");
  });

  it("keeps project connections with their own key working as before", async () => {
    const own = `own-${randomBytes(8).toString("hex")}`;
    await scoped(ws, p2, (tx) =>
      tx.entity.create({
        data: {
          workspaceId: ws,
          projectId: p2,
          kind: "connectors",
          data: { provider: "postiz", baseUrl: "https://own.example.invalid", status: "configured", encryptedCredential: encrypt(own, process.env.CREDENTIAL_KEY!) },
        },
      }),
    );
    expect(await access(p2)).toEqual({ credential: own, baseUrl: "https://own.example.invalid" });
  });

  it("fails closed without the cutover flag or after the grant is revoked", async () => {
    process.env.ORBIT_CONNECTIONS_CUTOVER = "";
    try {
      await expect(access(p1)).rejects.toMatchObject({ code: "CONNECTION_NOT_GRANTED" });
      expect((await attach(p1)).json().error.code).toBe("CUTOVER_NOT_ENABLED");
    } finally {
      process.env.ORBIT_CONNECTIONS_CUTOVER = "postiz";
    }
    expect((await call("DELETE", `/api/organizations/${ws}/connection-grants/${grantId}`)).statusCode).toBe(204);
    await expect(access(p1)).rejects.toMatchObject({ code: "CONNECTION_NOT_GRANTED" });
  });
});
