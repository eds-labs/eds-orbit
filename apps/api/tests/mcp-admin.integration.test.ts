import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

// MCP administration (ADR 0014, WP3.6): administrators see clients and all
// grants as metadata, disable a client (which revokes its grants) and
// revoke single grants; nobody else reaches it.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
process.env.ORBIT_ADMINISTRATION = "true";

describe.skipIf(!enabled)("MCP administration (ADR 0014)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const cookies: Record<string, string> = {};
  let ws: string;
  const clientId = `synthetic-client-${randomUUID()}`;
  const grants: string[] = [];
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (method: "GET" | "POST" | "DELETE", url: string, who: string) =>
    app.inject({ method, url, headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: cookies[who]! } });

  beforeAll(async () => {
    app = await buildServer();
    const ids: Record<string, string> = {};
    for (const who of ["admin", "owner"]) {
      const email = `${randomUUID()}@example.invalid`;
      const r = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic ${who}`, password } });
      users.push(r.user.id);
      ids[who] = r.user.id;
      const s = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email, password },
      });
      const set = s.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ");
    }
    await authDb.user.update({ where: { id: ids.admin }, data: { role: "admin" } });
    ws = (
      await authDb.workspace.create({
        data: { name: "Synthetic MCP admin", members: { create: { userId: ids.owner!, role: "owner" } } },
      })
    ).id;
    await authDb.oauthClient.create({ data: { id: randomUUID(), clientId, name: "Synthetic client", scopes: [], redirectUris: [], contacts: [], postLogoutRedirectUris: [], clientCredentialsScopes: [] } as never });
    for (let i = 0; i < 2; i++)
      grants.push(
        (
          await authDb.mcpGrant.create({
            data: { userId: ids.owner!, clientId, workspaceId: ws, projectIds: [], allCurrentProjects: true, scopes: ["orbit:read"], modules: [], status: i === 0 ? "active" : "revoked" },
          })
        ).id,
      );
    grants.push(
      (
        await authDb.mcpGrant.create({
          data: { userId: ids.admin!, clientId, workspaceId: ws, projectIds: [], scopes: ["orbit:read"], modules: [], status: "active" },
        })
      ).id,
    );
  });
  afterAll(async () => {
    await authDb.oauthClient.deleteMany({ where: { clientId } });
    await authDb.workspace.deleteMany({ where: { id: ws } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("is for system administrators only", async () => {
    expect((await call("GET", "/api/admin/mcp", "owner")).statusCode).toBe(404);
    const r = await call("GET", "/api/admin/mcp", "admin");
    expect(r.statusCode).toBe(200);
    expect(r.json().clients.find((c: { clientId: string }) => c.clientId === clientId)).toMatchObject({
      name: "Synthetic client",
      disabled: false,
      activeGrants: 2,
    });
    const listed = await call("GET", `/api/admin/mcp/grants?workspaceId=${ws}`, "admin");
    expect(listed.json().items).toHaveLength(2);
    expect(JSON.stringify(listed.json())).not.toMatch(/token|secret/i);
  });

  it("revokes a single grant", async () => {
    expect((await call("DELETE", `/api/admin/mcp/grants/${grants[2]}`, "admin")).statusCode).toBe(204);
    expect((await authDb.mcpGrant.findUniqueOrThrow({ where: { id: grants[2]! } })).status).toBe("revoked");
  });

  it("disables a client and revokes everything it holds", async () => {
    const r = await call("POST", `/api/admin/mcp/clients/${encodeURIComponent(clientId)}/disable`, "admin");
    expect(r.json()).toMatchObject({ disabled: true, revokedGrants: 1 });
    expect((await authDb.oauthClient.findFirstOrThrow({ where: { clientId } })).disabled).toBe(true);
    expect(await authDb.mcpGrant.count({ where: { clientId, status: "active" } })).toBe(0);
    const audit = await authDb.systemAuditEvent.findFirst({ where: { action: "mcp_client.disabled", targetId: clientId } });
    expect(audit?.metadata).toMatchObject({ revokedGrants: 1 });
  });
});
