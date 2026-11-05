import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createConnection, grantConnection } from "../src/platform/administration/connections.ts";
import { setGithubFetchForTests } from "../src/platform/connections/github-app.ts";
import { componentRepository } from "../src/modules/issues/github-connection.ts";
import { defaultIssuesSettings, issuesSettingsSchema } from "../src/modules/issues/settings.ts";
import { createIssuesProject } from "./support/issues-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SECRET = JSON.stringify({
  appId: "123",
  appSlug: "orbit-issues",
  installationId: "456",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const REPOS = [
  { full_name: "acme/web", private: true, archived: false },
  { full_name: "acme/public-site", private: false, archived: false },
  { full_name: "acme/old", private: true, archived: true },
];

/** GitHub settings and status of the issue center (slice 1, Task 2). */
describe.skipIf(!enabled)("issues GitHub allow-list and status", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let connectionId = "";
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const cookies = { owner: "", editor: "" };
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  let githubCalls = 0;
  const call = (who: keyof typeof cookies, method: "GET" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${p.owner.projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (r: { json(): { error?: { code: string } } }) => r.json().error?.code;
  const fakeGithub = () =>
    setGithubFetchForTests(async (url) => {
      githubCalls += 1;
      const u = String(url);
      if (u.endsWith("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
      if (u.includes("/installation/repositories"))
        return new Response(JSON.stringify({ repositories: REPOS }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
  const saveWith = async (repositories: unknown[]) => {
    const current = await call("owner", "GET", "/issues/settings");
    return call("owner", "PUT", "/issues/settings", {
      settings: { ...defaultIssuesSettings(), github: { repositories } },
      version: current.json().version,
    });
  };

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    app = await buildServer();
    p = await createIssuesProject();
    for (const who of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const scope = p[who];
      // Replace the fixture user's identity with a real sign-in.
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic ${who}`, password } });
      await authDb.workspaceMember.create({ data: { workspaceId: scope.workspaceId, userId: created.user.id, role: who === "owner" ? "owner" : "viewer" } });
      if (who === "editor") await authDb.projectMember.create({ data: { workspaceId: scope.workspaceId, projectId: scope.projectId, userId: created.user.id, role: "editor" } });
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: { email, password } });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_ISSUES = "true";
    process.env.ORBIT_MODULES = "true";
    process.env.ORBIT_ISSUES_GITHUB = "true";
    githubCalls = 0;
    fakeGithub();
  });
  afterEach(() => {
    setGithubFetchForTests(null);
    delete process.env.ORBIT_ISSUES;
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_ISSUES_GITHUB;
  });
  afterAll(async () => {
    if (connectionId) await authDb.connection.deleteMany({ where: { id: connectionId } });
    delete process.env.ORBIT_CONNECTIONS;
    await p?.cleanup();
    await closeDatabase();
  });

  it("reports the GitHub status: flag, permission, grant", async () => {
    delete process.env.ORBIT_ISSUES_GITHUB;
    const off = await call("owner", "GET", "/issues/github/status");
    expect([off.statusCode, code(off)]).toEqual([404, "ISSUES_GITHUB_DISABLED"]);
    process.env.ORBIT_ISSUES_GITHUB = "true";
    expect((await call("editor", "GET", "/issues/github/status")).statusCode).toBe(403);
    const none = await call("owner", "GET", "/issues/github/status");
    expect(none.statusCode).toBe(200);
    expect(none.json()).toMatchObject({ connected: false, repositories: [] });

    const connection = await createConnection(admin, { provider: "github_app", label: "Synthetic GitHub", config: {}, secret: SECRET });
    connectionId = connection.id;
    for (const projectId of [undefined, p.owner.projectId])
      await grantConnection(admin, connection.id, {
        workspaceId: p.owner.workspaceId,
        ...(projectId ? { projectId } : {}),
        purposes: ["issues"],
        modules: ["issues"],
      });
    const granted = await call("owner", "GET", "/issues/github/status");
    expect(granted.json()).toMatchObject({ connected: true, account: "orbit-issues" });
    expect(granted.json().available.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/web", "acme/public-site", "acme/old"]);
    expect(JSON.stringify(granted.json())).not.toMatch(/PRIVATE KEY|ghs_fake/);

    setGithubFetchForTests(async () => new Response("nope", { status: 500 }));
    const failing = await call("owner", "GET", "/issues/github/status");
    expect(failing.statusCode).toBe(200);
    expect(failing.json()).toMatchObject({ connected: true });
    expect(typeof failing.json().error).toBe("string");
  });

  it("saves the allow-list only for private, unarchived installation repositories", async () => {
    expect(code(await saveWith([{ key: "site", fullName: "acme/public-site" }]))).toBe("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED");
    expect(code(await saveWith([{ key: "ghost", fullName: "acme/ghost" }]))).toBe("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED");
    expect(code(await saveWith([{ key: "old", fullName: "acme/old" }]))).toBe("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED");
    expect((await saveWith([{ key: "web", fullName: "acme/web" }])).statusCode).toBe(200);
    // Unchanged entries need no GitHub call; saving other settings neither.
    githubCalls = 0;
    expect((await saveWith([{ key: "web", fullName: "acme/web" }])).statusCode).toBe(200);
    expect(githubCalls).toBe(0);
  });

  it("requires issues.github to change the allow-list", async () => {
    const current = await call("editor", "GET", "/issues/settings");
    const update = { settings: { ...defaultIssuesSettings(), github: { repositories: [{ key: "web", fullName: "acme/web" }] } }, version: current.json().version };
    expect((await call("editor", "PUT", "/issues/settings", update)).statusCode).toBe(403);
  });

  it("resolves a component's repository through the allow-list", () => {
    const settings = issuesSettingsSchema.parse({
      ...defaultIssuesSettings(),
      components: [
        { key: "frontend", label: { en: "Web", de: "Web" }, repository: "web" },
        { key: "backend", label: { en: "API", de: "API" }, repository: "unknown" },
        { key: "docs", label: { en: "Docs", de: "Doku" } },
      ],
      github: { repositories: [{ key: "web", fullName: "acme/web" }] },
    });
    expect(componentRepository(settings, ["docs", "frontend"])).toBe("web");
    expect(componentRepository(settings, ["backend"])).toBeNull();
    expect(componentRepository(settings, ["docs"])).toBeNull();
  });
});
