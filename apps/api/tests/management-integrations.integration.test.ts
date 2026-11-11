import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { CatalogEntry } from "../src/platform/management/integration-catalog.ts";

// The Integrations Center endpoints of the settings center (ADR 0027). The
// catalog is the same for every signed-in member; later cases cover the
// organization and project listings.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  ORBIT_MODULES: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_SOCIAL: "true",
  ORBIT_CONNECTIONS_CUTOVER: "postiz,matomo",
  ORBIT_SETTINGS_CENTER: "preview",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

type Person = { id: string; email: string; cookie?: string };
const KEYS = ["admin", "owner", "editor", "viewer", "outsider"] as const;

describe.skipIf(!enabled)("Management integrations (ADR 0027)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  const p: Record<(typeof KEYS)[number], Person> = {} as never;

  // One address per request: Better Auth limits sign-ins per address.
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name, password } });
    users.push(r.user.id);
    return { id: r.user.id, email };
  }
  async function signIn(email: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  }
  const get = (url: string, who?: Person) =>
    app.inject({
      method: "GET",
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), ...(who ? { cookie: who.cookie! } : {}) },
    });

  beforeAll(async () => {
    app = await buildServer();
    for (const key of KEYS) p[key] = await signUp(`Synthetic ${key}`);
    await authDb.user.update({ where: { id: p.admin.id }, data: { role: "admin" } });
    const orgId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic integrations org",
          members: {
            create: [
              { userId: p.owner.id, role: "owner" },
              { userId: p.editor.id, role: "viewer" },
              { userId: p.viewer.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    const otherOrgId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic foreign org",
          members: { create: { userId: p.outsider.id, role: "owner" } },
        },
      })
    ).id;
    workspaces.push(orgId, otherOrgId);
    await authDb.project.create({
      data: {
        workspaceId: orgId,
        name: "Synthetic integrations project",
        members: {
          create: [
            { userId: p.editor.id, role: "editor" },
            { userId: p.viewer.id, role: "viewer" },
          ],
        },
      },
    });
    for (const key of KEYS) p[key].cookie = await signIn(p[key].email);
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("answers 404 before authentication while the flag is off", async () => {
    process.env.ORBIT_SETTINGS_CENTER = "off";
    try {
      expect((await get("/api/management/integrations/catalog")).statusCode).toBe(404);
    } finally {
      process.env.ORBIT_SETTINGS_CENTER = "preview";
    }
  });

  it("answers 401 without a session", async () => {
    expect((await get("/api/management/integrations/catalog")).statusCode).toBe(401);
  });

  it("gives every signed-in member the same catalog without secrets", async () => {
    const viewer = await get("/api/management/integrations/catalog", p.viewer);
    const admin = await get("/api/management/integrations/catalog", p.admin);
    expect(viewer.statusCode).toBe(200);
    expect(admin.statusCode).toBe(200);
    expect(viewer.json()).toEqual(admin.json());
    const { items } = viewer.json() as { items: CatalogEntry[] };
    expect(items.map((e) => e.id)).toContain("postiz");
    // Only the static fields; auth type values such as "json_secret" and
    // "webhook_secret" are labels, not secrets, so they are left out of the text check.
    for (const e of items)
      expect(Object.keys(e).sort()).toEqual(
        ["authType", "available", "category", "checkable", "id", "label", "owner", "scopes", "storage"],
      );
    const text = JSON.stringify(items.map(({ authType: _authType, ...rest }) => rest));
    for (const word of ["secret", "config", "health"]) expect(text).not.toContain(word);
  });
});
