import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { CatalogEntry } from "../src/platform/management/integration-catalog.ts";
import type { ProjectIntegration } from "../src/platform/management/project-integrations.ts";
import { createProjectConnection } from "../src/platform/connections/project-secrets.ts";
import { registeredProjectIntegrations } from "../src/platform/modules/contributions.ts";
import { encrypt } from "../src/platform/shared.ts";

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
  ORBIT_TELEGRAM: "true",
  ORBIT_KNOWLEDGE_WORKSPACE: "true",
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
  let orgId = "";
  let projectId = "";
  // Fixture ids and the secret values that must never leave the server.
  const f = {
    postiz: "", matomo: "", matomoGrant: "", postizRow: "", slackRow: "", mailboxRow: "",
    socialAccount: "", githubRow: "",
  };
  const SECRETS = {
    slack: `slack-${randomBytes(12).toString("hex")}`,
    mail: `mail-${randomBytes(12).toString("hex")}`,
    social: `social-${randomBytes(12).toString("hex")}`,
    drive: `drive-${randomBytes(12).toString("hex")}`,
  };

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


  const inProject = <T>(fn: Parameters<typeof scoped<T>>[2]) => scoped(orgId, projectId, fn);
  const row = (kind: string, data: Record<string, unknown>) =>
    inProject((tx) => tx.entity.create({ data: { workspaceId: orgId, projectId, kind, data: data as object } }));
  const setModule = (moduleId: string, enabled: boolean) =>
    inProject((tx) =>
      tx.projectModule.upsert({
        where: { workspaceId_projectId_moduleId: { workspaceId: orgId, projectId, moduleId } },
        create: { workspaceId: orgId, projectId, moduleId, enabled, moduleVersion: "1" },
        update: { enabled },
      }),
    );
  const items = async (who: Person) => {
    const r = await get(`/api/management/projects/${projectId}/integrations`, who);
    expect(r.statusCode).toBe(200);
    return (r.json() as { items: ProjectIntegration[] }).items;
  };
  const byId = (list: ProjectIntegration[], id: string) => list.find((i) => i.id === id);

  // A system Postiz connection granted to the organization and the project
  // and bound there; an organization Matomo connection granted and not bound;
  // the project's own Slack connector and mailbox; a social account; the
  // owner's Telegram bot; a Knowledge GitHub installation; Google Drive.
  async function seedProjectIntegrations() {
    for (const moduleId of ["marketing", "social", "knowledge"]) await setModule(moduleId, true);
    f.postiz = (
      await authDb.connection.create({
        data: {
          provider: "postiz", scope: "system", label: "Synthetic system Postiz",
          config: { baseUrl: "https://postiz.example.invalid/api/public/v1" },
          status: "write_verified", health: { at: new Date().toISOString() }, createdBy: p.admin.id,
        },
      })
    ).id;
    const orgGrant = await authDb.connectionGrant.create({
      data: { connectionId: f.postiz, workspaceId: orgId, createdBy: p.admin.id },
    });
    await authDb.connectionGrant.create({
      data: { connectionId: f.postiz, workspaceId: orgId, projectId, parentGrantId: orgGrant.id, createdBy: p.owner.id },
    });
    f.matomo = (
      await authDb.connection.create({
        data: {
          provider: "matomo", scope: "workspace", workspaceId: orgId, label: "Synthetic organization Matomo",
          config: { baseUrl: "https://matomo.example.invalid" }, status: "read_verified", createdBy: p.owner.id,
        },
      })
    ).id;
    f.matomoGrant = (
      await authDb.connectionGrant.create({
        data: { connectionId: f.matomo, workspaceId: orgId, projectId, createdBy: p.owner.id },
      })
    ).id;
    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/actions/connector-attach`,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: p.owner.cookie! },
      payload: { connectionId: f.postiz },
    });
    expect(attached.statusCode).toBe(200);
    f.postizRow = attached.json().id;
    const key = process.env.CREDENTIAL_KEY!;
    f.slackRow = (
      await row("connectors", {
        provider: "slack", baseUrl: "https://hooks.example.invalid/services/synthetic", channelId: "C0SYNTHETIC",
        encryptedCredential: encrypt(SECRETS.slack, key), status: "configured",
      })
    ).id;
    f.mailboxRow = (
      await row("connectors", {
        provider: "email", fromAddress: "desk@example.test", smtpHost: "mail.example.test", imapHost: "imap.example.test",
        encryptedCredential: encrypt(SECRETS.mail, key), status: "read_verified", verifiedAt: "2026-11-01T08:00:00.000Z",
      })
    ).id;
    const scope = { workspaceId: orgId, projectId, userId: p.owner.id, role: "owner" as const };
    const { connectionId } = await createProjectConnection(scope, {
      moduleId: "social", provider: "social.account.x", label: "x synthetic_handle",
      config: {}, secret: SECRETS.social, purposes: ["social_publish"],
    });
    f.socialAccount = randomUUID();
    await inProject((tx) =>
      tx.socialAccount.create({
        data: {
          id: f.socialAccount, workspaceId: orgId, projectId, connectionId, platform: "x", externalId: "4242",
          handle: "synthetic_handle", displayName: "Synthetic handle", capability: "write_verified",
          settings: { lastCheckedAt: "2026-11-02T09:00:00.000Z" }, createdBy: p.owner.id,
        },
      }),
    );
    await row("telegram_connections", { status: "linked", linkedAt: "2026-11-03T10:00:00.000Z" });
    f.githubRow = (await row("knowledge_github_connections", { account: "synthetic-org", installationId: 4242 })).id;
    await row("drive_connection", { encryptedRefreshToken: encrypt(SECRETS.drive, key), account: "drive@example.invalid" });
  }

  beforeAll(async () => {
    app = await buildServer();
    for (const key of KEYS) p[key] = await signUp(`Synthetic ${key}`);
    await authDb.user.update({ where: { id: p.admin.id }, data: { role: "admin" } });
    orgId = (
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
    projectId = (
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
      })
    ).id;
    for (const key of KEYS) p[key].cookie = await signIn(p[key].email);
    await seedProjectIntegrations();
  });
  afterAll(async () => {
    // The system connection belongs to no organization: removed on its own.
    if (f.postiz) await authDb.connection.deleteMany({ where: { id: f.postiz } });
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

  it("lists the project's integrations with a uniform state", async () => {
    const list = await items(p.owner);
    expect(byId(list, `connection:${f.postiz}`)).toMatchObject({
      provider: "postiz", label: "Synthetic system Postiz", category: "social", scope: "central", state: "ready", checkedAt: null, group: null,
    });
    expect(byId(list, `connection:${f.matomo}`)).toMatchObject({ provider: "matomo", scope: "central", state: "verified" });
    // The bound Postiz row is the central item, not a second project item.
    expect(byId(list, `connector:${f.postizRow}`)).toBeUndefined();
    expect(byId(list, `connector:${f.slackRow}`)).toMatchObject({ provider: "slack", label: "Slack", scope: "project", state: "stored", group: null });
    expect(byId(list, `connector:${f.mailboxRow}`)).toMatchObject({
      provider: "email", label: "desk@example.test", category: "email", scope: "project", state: "ready",
      checkedAt: "2026-11-01T08:00:00.000Z", group: "mail.example.test",
    });
    expect(byId(list, `social:${f.socialAccount}`)).toMatchObject({
      provider: "social.account.x", label: "synthetic_handle", category: "social", scope: "project", state: "ready",
      checkedAt: "2026-11-02T09:00:00.000Z", group: null,
    });
    expect(byId(list, "telegram_owner_bot")).toMatchObject({ state: "verified", checkedAt: "2026-11-03T10:00:00.000Z" });
    expect(byId(list, `knowledge_github:${f.githubRow}`)).toMatchObject({
      provider: "knowledge_github", label: "synthetic-org", category: "development", state: "ready",
    });
    expect(byId(list, "google_drive")).toMatchObject({ label: "Google Drive", category: "google", state: "verified" });
    // Central items first.
    const scopes = list.map((i) => i.scope);
    expect(scopes.lastIndexOf("central")).toBeLessThan(scopes.indexOf("project"));
  });

  it("never exposes more than the existing reads", async () => {
    const response = await get(`/api/management/projects/${projectId}/integrations`, p.viewer);
    expect(response.statusCode).toBe(200);
    const list = (response.json() as { items: ProjectIntegration[] }).items;
    expect(list.length).toBeGreaterThan(0);
    for (const item of list)
      expect(Object.keys(item).sort()).toEqual(["category", "checkedAt", "group", "id", "label", "provider", "scope", "state"]);
    for (const word of ["encryptedCredential", "baseUrl", "channelId", "config", "health", ...Object.values(SECRETS)])
      expect(response.body).not.toContain(word);
    // Every label and group is already readable by the viewer: the project's
    // connectors, its granted connections, its social accounts, or a name
    // from the catalog.
    const existing = await Promise.all(
      ["connectors", "connections", "social/accounts"].map(async (path) => {
        const r = await get(`/api/projects/${projectId}/${path}`, p.viewer);
        expect(r.statusCode).toBe(200);
        return r.body;
      }),
    );
    const catalog = ((await get("/api/management/integrations/catalog", p.viewer)).json() as { items: CatalogEntry[] }).items;
    const names = new Set(catalog.flatMap((e) => [e.label.en, e.label.de]));
    for (const item of list)
      for (const value of [item.label, item.group].filter((v): v is string => v !== null))
        expect(names.has(value) || existing.some((body) => body.includes(JSON.stringify(value))), value).toBe(true);
  });

  it("shows owner-only items to owners only", async () => {
    for (const who of [p.viewer, p.editor]) {
      const ids = (await items(who)).map((i) => i.id);
      expect(ids).not.toContain("telegram_owner_bot");
      expect(ids.some((id) => id.startsWith("knowledge_github"))).toBe(false);
      // What every member reads is still there.
      expect(ids).toContain(`social:${f.socialAccount}`);
    }
    const ids = (await items(p.owner)).map((i) => i.id);
    expect(ids).toContain("telegram_owner_bot");
    expect(ids).toContain(`knowledge_github:${f.githubRow}`);
  });

  it("module off or hidden contributes nothing", async () => {
    const marketing = [`connection:${f.postiz}`, `connection:${f.matomo}`, `connector:${f.slackRow}`];
    await setModule("social", false);
    try {
      expect((await items(p.owner)).map((i) => i.id)).not.toContain(`social:${f.socialAccount}`);
    } finally {
      await setModule("social", true);
    }
    await setModule("marketing", false);
    try {
      const ids = (await items(p.owner)).map((i) => i.id);
      for (const id of marketing) expect(ids).not.toContain(id);
      expect(ids).toContain(`connector:${f.mailboxRow}`);
    } finally {
      await setModule("marketing", true);
    }
    await authDb.projectMemberModuleRole.create({
      data: { workspaceId: orgId, projectId, userId: p.viewer.id, moduleId: "social", role: "none", changedBy: p.owner.id },
    });
    try {
      expect((await items(p.viewer)).map((i) => i.id)).not.toContain(`social:${f.socialAccount}`);
      expect((await items(p.editor)).map((i) => i.id)).toContain(`social:${f.socialAccount}`);
    } finally {
      await authDb.projectMemberModuleRole.deleteMany({ where: { projectId, userId: p.viewer.id } });
    }
  });

  it("leaves out a contribution that throws and still answers", async () => {
    // The registry hands out its own entries; swap the social one for the
    // duration of this case only.
    const entry = registeredProjectIntegrations().find(([owner]) => owner === "social")!;
    const original = entry[1];
    entry[1] = async () => {
      throw new Error("synthetic contribution failure");
    };
    try {
      const ids = (await items(p.owner)).map((i) => i.id);
      expect(ids.some((id) => id.startsWith("social:"))).toBe(false);
      expect(ids).toContain(`knowledge_github:${f.githubRow}`);
      expect(ids).toContain(`connection:${f.postiz}`);
    } finally {
      entry[1] = original;
    }
  });

  it("keeps the later contributions when one fails in the database", async () => {
    // The first registered contribution (knowledge) runs an invalid query, which
    // would abort the whole read transaction without a savepoint.
    const entry = registeredProjectIntegrations()[0]!;
    expect(entry[0]).toBe("knowledge");
    const original = entry[1];
    entry[1] = async (tx) => {
      await tx.$queryRawUnsafe("select * from no_such_table_for_test");
      return [];
    };
    try {
      const ids = (await items(p.owner)).map((i) => i.id);
      expect(ids).toContain(`social:${f.socialAccount}`);
      expect(ids.some((id) => id.startsWith("knowledge_github"))).toBe(false);
    } finally {
      entry[1] = original;
    }
  });

  it("hides the generic rows of a module the member may not use", async () => {
    const marketing = [`connection:${f.postiz}`, `connection:${f.matomo}`, `connector:${f.slackRow}`, `connector:${f.postizRow}`];
    await authDb.projectMemberModuleRole.create({
      data: { workspaceId: orgId, projectId, userId: p.viewer.id, moduleId: "marketing", role: "none", changedBy: p.owner.id },
    });
    try {
      const ids = (await items(p.viewer)).map((i) => i.id);
      for (const id of marketing) expect(ids).not.toContain(id);
      expect(ids).toContain(`connector:${f.mailboxRow}`);
      expect((await items(p.editor)).map((i) => i.id)).toContain(`connection:${f.postiz}`);
    } finally {
      await authDb.projectMemberModuleRole.deleteMany({ where: { projectId, userId: p.viewer.id } });
    }
  });

  it("answers 404 to non-members and to a system administrator who is not a member", async () => {
    const url = `/api/management/projects/${projectId}/integrations`;
    expect((await get(url, p.outsider)).statusCode).toBe(404);
    expect((await get(url, p.admin)).statusCode).toBe(404);
    expect((await get(url)).statusCode).toBe(401);
    expect((await get("/api/management/projects/not-a-uuid/integrations", p.owner)).statusCode).toBe(400);
  });

  it("maps revoked, disabled, failed and reconnect_required", async () => {
    try {
      await authDb.connection.update({ where: { id: f.matomo }, data: { status: "failed" } });
      expect(byId(await items(p.owner), `connection:${f.matomo}`)?.state).toBe("needs_attention");
      await authDb.connection.update({ where: { id: f.postiz }, data: { disabledAt: new Date() } });
      await authDb.connectionGrant.update({ where: { id: f.matomoGrant }, data: { revokedAt: new Date(), revokedBy: p.owner.id } });
      await inProject((tx) =>
        tx.socialAccount.update({ where: { id: f.socialAccount }, data: { status: "reconnect_required" } }),
      );
      const list = await items(p.owner);
      expect(byId(list, `connection:${f.postiz}`)).toBeUndefined();
      expect(byId(list, `connector:${f.postizRow}`)).toMatchObject({ provider: "postiz", label: "Postiz", scope: "central", state: "disabled" });
      expect(list.some((i) => i.id.includes(f.matomo))).toBe(false);
      expect(byId(list, `social:${f.socialAccount}`)?.state).toBe("needs_attention");
      for (const id of [`connector:${f.postizRow}`, `social:${f.socialAccount}`])
        expect(byId(list, id)?.state).not.toBe("ready");
    } finally {
      // Later cases (organization usage) build on the original fixtures.
      await authDb.connection.update({ where: { id: f.matomo }, data: { status: "read_verified" } });
      await authDb.connection.update({ where: { id: f.postiz }, data: { disabledAt: null } });
      await authDb.connectionGrant.update({ where: { id: f.matomoGrant }, data: { revokedAt: null, revokedBy: null } });
      await inProject((tx) => tx.socialAccount.update({ where: { id: f.socialAccount }, data: { status: "active" } }));
    }
    const restored = await items(p.owner);
    expect(byId(restored, `connection:${f.postiz}`)?.state).toBe("ready");
    expect(byId(restored, `connection:${f.matomo}`)?.state).toBe("verified");
    expect(byId(restored, `social:${f.socialAccount}`)?.state).toBe("ready");
  });
});
