import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { ManagementCapabilities } from "../src/platform/management/capabilities.ts";

// The capabilities endpoint of the settings center (ADR 0027): which scopes
// and sections a member may open. It is a navigation hint; the routes keep
// their own checks, which the "agrees with the routes" test pins down.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_ACCOUNT: "true",
  ORBIT_CONNECTIONS: "true",
  ORBIT_SETTINGS_CENTER: "preview",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

type Person = { id: string; email: string; cookie?: string };
const KEYS = [
  "admin",
  "owner",
  "projectOwner",
  "editor",
  "viewer",
  "outsider",
] as const;

describe.skipIf(!enabled)("Management capabilities (ADR 0027)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  let orgId: string,
    otherOrgId: string,
    first: string,
    second: string,
    personal: string;
  const p: Record<(typeof KEYS)[number], Person> = {} as never;

  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({
      body: { email, name, password },
    });
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
      headers: {
        origin,
        [CLIENT_IP_HEADER]: ip(),
        ...(who ? { cookie: who.cookie! } : {}),
      },
    });
  const caps = async (who: Person) => {
    const r = await get("/api/management/capabilities", who);
    expect(r.statusCode).toBe(200);
    return r.json() as ManagementCapabilities;
  };
  const projectCaps = (c: ManagementCapabilities, id: string) =>
    c.projects.find((x) => x.id === id);

  beforeAll(async () => {
    app = await buildServer();
    for (const key of KEYS) p[key] = await signUp(`Synthetic ${key}`);
    await authDb.user.update({
      where: { id: p.admin.id },
      data: { role: "admin" },
    });
    orgId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic capabilities org",
          members: {
            create: [
              { userId: p.owner.id, role: "owner" },
              { userId: p.projectOwner.id, role: "viewer" },
              { userId: p.editor.id, role: "viewer" },
              { userId: p.viewer.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    otherOrgId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic foreign org",
          members: { create: { userId: p.outsider.id, role: "owner" } },
        },
      })
    ).id;
    workspaces.push(orgId, otherOrgId);
    first = (
      await authDb.project.create({
        data: {
          workspaceId: orgId,
          name: "Synthetic first project",
          members: {
            create: [
              { userId: p.projectOwner.id, role: "owner" },
              { userId: p.editor.id, role: "editor" },
              { userId: p.viewer.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    second = (
      await authDb.project.create({
        data: { workspaceId: orgId, name: "Synthetic second project" },
      })
    ).id;
    // The organization owner's personal space (ADR 0022): never listed.
    personal = (
      await authDb.project.create({
        data: {
          workspaceId: orgId,
          name: "Synthetic personal space",
          kind: "personal",
          personalUserId: p.owner.id,
          members: { create: { userId: p.owner.id, role: "owner" } },
        },
      })
    ).id;
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
      expect((await get("/api/management/capabilities")).statusCode).toBe(404);
    } finally {
      process.env.ORBIT_SETTINGS_CENTER = "preview";
    }
  });

  it("answers 401 without a session", async () => {
    expect((await get("/api/management/capabilities")).statusCode).toBe(401);
  });

  it("gives a system administrator the system scope and nothing of the organization", async () => {
    const c = await caps(p.admin);
    expect(c.stage).toBe("preview");
    expect(c.system).toContain("system.users");
    expect(c.system).toContain("system.connections");
    expect(c.organizations).toEqual([]);
    expect(c.projects).toEqual([]);
  });

  it("gives an organization owner the organization and every project as owner", async () => {
    const c = await caps(p.owner);
    expect(c.system).toEqual([]);
    expect(c.organizations).toHaveLength(1);
    expect(c.organizations[0]).toMatchObject({ id: orgId });
    expect(c.organizations[0]!.capabilities).toContain("organization.members");
    expect(c.organizations[0]!.capabilities).toContain(
      "organization.connections",
    );
    for (const id of [first, second]) {
      const project = projectCaps(c, id);
      expect(project?.role).toBe("owner");
      expect(project?.capabilities).toContain("project.ai");
    }
  });

  it("limits a project owner to their project", async () => {
    const c = await caps(p.projectOwner);
    expect(c.organizations).toEqual([]);
    expect(c.projects.map((x) => x.id)).toEqual([first]);
    expect(projectCaps(c, first)?.capabilities).toContain("project.members");
    expect(projectCaps(c, second)).toBeUndefined();
  });

  it("gives editors and viewers no owner sections", async () => {
    for (const who of [p.editor, p.viewer]) {
      const project = projectCaps(await caps(who), first);
      expect(project?.capabilities).toContain("project.overview");
      for (const owner of ["project.members", "project.ai", "project.data"])
        expect(project?.capabilities).not.toContain(owner);
    }
  });

  it("lists nothing of another organization", async () => {
    const c = await caps(p.outsider);
    const body = JSON.stringify(c);
    for (const id of [orgId, first, second]) expect(body).not.toContain(id);
    expect(c.organizations.map((o) => o.id)).toEqual([otherOrgId]);
  });

  it("follows the flags", async () => {
    process.env.ORBIT_CONNECTIONS = "false";
    try {
      expect(
        (await caps(p.owner)).organizations[0]!.capabilities,
      ).not.toContain("organization.connections");
      expect((await caps(p.admin)).system).not.toContain("system.ai");
    } finally {
      process.env.ORBIT_CONNECTIONS = "true";
    }
  });

  it("reports the AI flags", async () => {
    const saved = {
      catalog: process.env.ORBIT_AI_CATALOG,
      defaults: process.env.ORBIT_AI_DEFAULTS,
      budget: process.env.ORBIT_AI_ORG_BUDGET,
    };
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    process.env.ORBIT_AI_CATALOG = "true";
    delete process.env.ORBIT_AI_DEFAULTS;
    delete process.env.ORBIT_AI_ORG_BUDGET;
    try {
      expect((await caps(p.viewer)).flags).toEqual({
        connections: true,
        aiCatalog: true,
        aiDefaults: false,
        aiOrgBudget: false,
      });
      // The standard needs the catalog, as the runtime reads it.
      process.env.ORBIT_AI_DEFAULTS = "true";
      process.env.ORBIT_AI_CATALOG = "false";
      expect((await caps(p.viewer)).flags.aiDefaults).toBe(false);
      process.env.ORBIT_AI_CATALOG = "true";
      expect((await caps(p.viewer)).flags.aiDefaults).toBe(true);
    } finally {
      restore("ORBIT_AI_CATALOG", saved.catalog);
      restore("ORBIT_AI_DEFAULTS", saved.defaults);
      restore("ORBIT_AI_ORG_BUDGET", saved.budget);
    }
  });

  it("agrees with the routes", async () => {
    const pairs: Array<{
      scope: "system" | "organization" | "project";
      capability: string;
      url: (project: string) => string;
      // The route admits system administrators that D-9 does not list.
      skipAdmin?: boolean;
    }> = [
      {
        scope: "system",
        capability: "system.users",
        url: () => "/api/admin/users",
      },
      {
        scope: "organization",
        capability: "organization.connections",
        url: () => `/api/organizations/${orgId}/connections`,
      },
      {
        scope: "organization",
        capability: "organization.members",
        url: () => `/api/organizations/${orgId}`,
        skipAdmin: true,
      },
      {
        scope: "project",
        capability: "project.members",
        url: () => `/api/projects/${first}/members`,
      },
      {
        scope: "project",
        capability: "project.ai",
        url: () => `/api/projects/${first}/ai-spend-policy`,
      },
      {
        scope: "project",
        capability: "project.overview",
        url: () => `/api/projects/${first}/modules`,
      },
    ];
    for (const key of KEYS) {
      const who = p[key];
      const c = await caps(who);
      for (const pair of pairs) {
        if (pair.skipAdmin && key === "admin") continue;
        const listed =
          pair.scope === "system"
            ? c.system
            : pair.scope === "organization"
              ? (c.organizations.find((o) => o.id === orgId)?.capabilities ??
                [])
              : (projectCaps(c, first)?.capabilities ?? []);
        const status = (await get(pair.url(first), who)).statusCode;
        expect(
          { who: key, capability: pair.capability, allowed: status === 200 },
          `${key} ${pair.capability} -> ${status}`,
        ).toEqual({
          who: key,
          capability: pair.capability,
          allowed: (listed as string[]).includes(pair.capability),
        });
      }
    }
  });

  it("lists no organization while administration is off, but still the projects", async () => {
    const shares = process.env.ORBIT_KNOWLEDGE_SHARES;
    process.env.ORBIT_ADMINISTRATION = "false";
    process.env.ORBIT_KNOWLEDGE_SHARES = "true";
    try {
      const c = await caps(p.owner);
      expect(c.organizations).toEqual([]);
      expect(c.projects.map((x) => x.role)).toEqual(["owner", "owner"]);
      expect(c.projects.map((x) => x.id).sort()).toEqual(
        [first, second].sort(),
      );
    } finally {
      process.env.ORBIT_ADMINISTRATION = "true";
      if (shares === undefined) delete process.env.ORBIT_KNOWLEDGE_SHARES;
      else process.env.ORBIT_KNOWLEDGE_SHARES = shares;
    }
  });

  it("never lists a personal space", async () => {
    for (const who of [p.owner, p.projectOwner, p.admin])
      expect(JSON.stringify(await caps(who))).not.toContain(personal);
  });

  it("follows a role change on the next request", async () => {
    expect(
      projectCaps(await caps(p.projectOwner), first)?.capabilities,
    ).toContain("project.members");
    const where = { projectId: first, userId: p.projectOwner.id };
    try {
      await authDb.projectMember.updateMany({
        where,
        data: { role: "viewer" },
      });
      expect(
        projectCaps(await caps(p.projectOwner), first)?.capabilities,
      ).not.toContain("project.members");
    } finally {
      await authDb.projectMember.updateMany({ where, data: { role: "owner" } });
    }
  });
});
