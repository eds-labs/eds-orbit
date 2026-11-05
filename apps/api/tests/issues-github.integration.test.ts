import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createConnection, grantConnection, revokeConnectionGrant } from "../src/platform/administration/connections.ts";
import { setGithubFetchForTests } from "../src/platform/connections/github-app.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { data } from "../src/shared.ts";
import { userActor } from "../src/modules/issues/common.ts";
import { ISSUES_GITHUB, REQUEST_KIND } from "../src/modules/issues/github.ts";
import { componentRepository, githubApp } from "../src/modules/issues/github-connection.ts";
import { createIssue, setIssueStatus, setShareReview, updateIssue } from "../src/modules/issues/issues.ts";
import {
  defaultIssuesSettings,
  issuesSettingsSchema,
  readIssuesSettings,
  saveIssuesSettings,
} from "../src/modules/issues/settings.ts";
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
    // The detail block's status: stored state only, no GitHub call.
    githubCalls = 0;
    const plain = await call("owner", "GET", "/issues/github/status");
    expect(plain.json()).toEqual({ connected: true, account: "orbit-issues", repositories: [] });
    expect(githubCalls).toBe(0);
    const granted = await call("owner", "GET", "/issues/github/status?available=1");
    expect(granted.json()).toMatchObject({ connected: true, account: "orbit-issues" });
    expect(granted.json().available.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/web", "acme/public-site", "acme/old"]);
    expect(githubCalls).toBeGreaterThan(0);
    expect(JSON.stringify(granted.json())).not.toMatch(/PRIVATE KEY|ghs_fake/);

    setGithubFetchForTests(async () => new Response("nope", { status: 500 }));
    expect((await call("owner", "GET", "/issues/github/status")).json()).toEqual(plain.json());
    const failing = await call("owner", "GET", "/issues/github/status?available=1");
    expect(failing.statusCode).toBe(200);
    expect(failing.json()).toMatchObject({ connected: true });
    expect(typeof failing.json().error).toBe("string");
  });

  it("uses only a GitHub grant released for the issues module", async () => {
    const other = await createConnection(admin, { provider: "github_app", label: "Synthetic GitHub (social)", config: {}, secret: SECRET });
    try {
      // A second project whose grants name another module only.
      const q = await createIssuesProject();
      try {
        for (const projectId of [undefined, q.owner.projectId])
          await grantConnection(admin, other.id, {
            workspaceId: q.owner.workspaceId,
            ...(projectId ? { projectId } : {}),
            purposes: ["issues"],
            modules: ["social"],
          });
        await expect(q.run((tx) => githubApp(tx, q.owner))).rejects.toMatchObject({ code: "ISSUES_GITHUB_NOT_CONNECTED" });
      } finally {
        await q.cleanup();
      }
    } finally {
      await authDb.connection.deleteMany({ where: { id: other.id } });
    }
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

const CANARY = "kunde.weber@example.org";
const ISSUES_URL = "https://api.github.com/repos/o/web/issues";

/** Creating GitHub issues exactly once (slice 1, Task 4). */
describe.skipIf(!enabled)("issues GitHub create requests", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let connectionId = "";
  let projectGrantId = "";
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const cookies = { owner: "", editor: "" };
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const code = (r: { json(): { error?: { code: string } } }) => r.json().error?.code;
  const call = (who: keyof typeof cookies, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${p.owner.projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });

  // The fake GitHub: records every call; created issues are listed again.
  type Call = { method: string; url: string; body: string };
  let calls: Call[] = [];
  const gh = {
    private: true,
    next: 7,
    issues: [] as Array<{ number: number; html_url: string; body: string; user: { login: string } }>,
    /** ok: 201; unclear: created, then the connection drops; 502: not created; 422: refused. */
    create: [] as Array<"ok" | "unclear" | "502" | "422">,
    /** The answer to listing the App's issues. */
    list: 200,
    /** GitHub has not indexed the created issues yet: the listing is empty. */
    lagging: false,
    /** Existing GitHub issues by number, for linking and refreshing. */
    remote: {} as Record<number, { state: string; state_reason?: string | null; pull_request?: object }>,
  };
  const posts = () => calls.filter((c) => c.method === "POST" && c.url === ISSUES_URL);
  const fakeGithub = () =>
    setGithubFetchForTests(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url: u, body });
      if (u.endsWith("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_fake" }), { status: 201 });
      if (u === "https://api.github.com/repos/o/web")
        return new Response(JSON.stringify({ full_name: "o/web", private: gh.private, archived: false }), { status: 200 });
      if (u.startsWith(`${ISSUES_URL}?`) && method === "GET") {
        expect(u).toContain("creator=orbit-issues%5Bbot%5D");
        if (gh.list !== 200) return new Response("{}", { status: gh.list });
        return new Response(JSON.stringify(gh.lagging ? [] : gh.issues), { status: 200 });
      }
      const single = /^https:\/\/api\.github\.com\/repos\/o\/web\/issues\/(\d+)$/.exec(u);
      if (single && method === "GET") {
        const number = Number(single[1]);
        const found = gh.remote[number];
        return found ? new Response(JSON.stringify({ number, ...found }), { status: 200 }) : new Response("{}", { status: 404 });
      }
      if (u === ISSUES_URL && method === "POST") {
        const mode = gh.create.shift() ?? "ok";
        if (mode === "422") return new Response("{}", { status: 422 });
        if (mode === "502") return new Response("{}", { status: 502 });
        const number = gh.next++;
        const created = {
          number,
          html_url: `https://github.com/o/web/issues/${number}`,
          body: JSON.parse(body).body as string,
          user: { login: "orbit-issues[bot]" },
        };
        gh.issues.push(created);
        if (mode === "unclear") throw new TypeError("socket hang up");
        return new Response(JSON.stringify(created), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });

  const worker = () => ({ ...p.owner, userId: "worker" });
  /** Runs the request's job as the worker does on attempt `attempts` of 3. */
  const runJob = async (requestId: string, attempts = 1) => {
    const job = await p.run((tx) =>
      tx.entity.findFirst({
        where: {
          projectId: p.owner.projectId,
          kind: "jobs",
          AND: [{ data: { path: ["topic"], equals: ISSUES_GITHUB } }, { data: { path: ["resourceId"], equals: requestId } }],
        },
      }),
    );
    expect(job).toBeTruthy();
    return registeredJobs().get(ISSUES_GITHUB)!.handler({
      scope: worker(),
      jobId: job!.id,
      job: { ...data(job), status: "running", attempts },
      executionMode: "test",
    });
  };
  const request = (requestId: string) =>
    p.run(async (tx) => data(await tx.entity.findFirst({ where: { id: requestId, kind: REQUEST_KIND } })));
  const readyIssue = (options: { confirmed?: boolean; reviewed?: boolean; summary?: string } = {}) =>
    p.run(async (tx) => {
      const actor = userActor(p.owner);
      let issue = await createIssue(
        tx,
        p.owner,
        {
          title: "Checkout button does nothing",
          summary: options.summary ?? "Clicking checkout leaves the cart unchanged.",
          acceptanceCriteria: ["Checkout completes"],
        },
        actor,
      );
      if (options.confirmed !== false)
        issue = await setIssueStatus(tx, p.owner, issue.id, { status: "confirmed", expectedVersion: issue.version }, actor);
      if (options.reviewed !== false)
        issue = await setShareReview(tx, p.owner, issue.id, { reviewed: true, expectedVersion: issue.version }, actor);
      return issue;
    });
  const requestCreate = async (issueId: string, repository = "web") => {
    const response = await call("owner", "POST", `/issues/issues/${issueId}/github`, { repository });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued" });
    return response.json().requestId as string;
  };
  /** Moves the request's last POST 3 minutes into the past. */
  const ageSending = (requestId: string) =>
    p.run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id: requestId } });
      const old = new Date(Date.now() - 3 * 60_000).toISOString();
      await tx.entity.update({ where: { id: requestId }, data: { data: { ...data(row), sendingAt: old } } });
    });
  const countRows = (issueId: string) =>
    p.run(async (tx) => ({
      requests: await tx.entity.count({ where: { projectId: p.owner.projectId, kind: REQUEST_KIND } }),
      events: await tx.issueEvent.count({ where: { issueId } }),
      audits: await tx.auditEvent.count({ where: { projectId: p.owner.projectId, resourceId: issueId } }),
      jobs: await tx.entity.count({ where: { projectId: p.owner.projectId, kind: "jobs" } }),
    }));

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    app = await buildServer();
    p = await createIssuesProject();
    for (const who of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const scope = p[who];
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic ${who}`, password } });
      await authDb.workspaceMember.create({ data: { workspaceId: scope.workspaceId, userId: created.user.id, role: who === "owner" ? "owner" : "viewer" } });
      if (who === "editor") await authDb.projectMember.create({ data: { workspaceId: scope.workspaceId, projectId: scope.projectId, userId: created.user.id, role: "editor" } });
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: { email, password } });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
    const connection = await createConnection(admin, { provider: "github_app", label: "Synthetic GitHub", config: {}, secret: SECRET });
    connectionId = connection.id;
    await grantConnection(admin, connection.id, { workspaceId: p.owner.workspaceId, purposes: ["issues"], modules: ["issues"] });
    projectGrantId = (
      await grantConnection(admin, connection.id, {
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        purposes: ["issues"],
        modules: ["issues"],
      })
    ).id;
    await p.run(async (tx) => {
      const stored = await readIssuesSettings(tx, p.owner);
      await saveIssuesSettings(
        tx,
        p.owner,
        { ...stored.settings, github: { repositories: [{ key: "web", fullName: "o/web" }] } },
        stored.version,
      );
    });
  });
  beforeEach(() => {
    process.env.ORBIT_ISSUES = "true";
    process.env.ORBIT_MODULES = "true";
    process.env.ORBIT_ISSUES_GITHUB = "true";
    calls = [];
    // GitHub numbers stay unique across tests, as refs do in the project.
    Object.assign(gh, { private: true, issues: [], create: [], list: 200, lagging: false, remote: {} });
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

  it("creates one GitHub issue and links it", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    expect(await request(requestId)).toMatchObject({ status: "queued", fullName: "o/web", repositoryKey: "web", attempts: 0 });
    expect(calls).toHaveLength(0);

    await runJob(requestId);
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]!.body);
    expect(sent.title).toBe(`[ISS-${issue.number}] Checkout button does nothing`);
    expect(sent.body.split("\n")[0]).toBe(`<!-- orbit-ref:${requestId} -->`);
    // The write token names exactly the one repository and the minimum rights.
    const tokens = calls.filter((c) => c.url.endsWith("/access_tokens")).map((c) => JSON.parse(c.body));
    expect(tokens).toContainEqual({ repositories: ["web"], permissions: { issues: "write", metadata: "read" } });
    expect(tokens.every((t) => JSON.stringify(t.repositories) === '["web"]')).toBe(true);

    const refs = await p.run((tx) => tx.issueExternalRef.findMany({ where: { issueId: issue.id } }));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ system: "github", externalId: "o/web#7", state: "open", url: "https://github.com/o/web/issues/7" });
    expect(await request(requestId)).toMatchObject({ status: "done", externalId: "o/web#7", attempts: 1 });
    // The core migration allows the history type "github"; the action names the step.
    const history = await p.run((tx) => tx.issueEvent.findMany({ where: { issueId: issue.id, type: "github" }, orderBy: { createdAt: "asc" } }));
    expect(history.map((e) => (e.after as { action: string }).action)).toEqual(["requested", "linked"]);
    expect(
      await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.linked", resourceId: requestId } })),
    ).toBe(1);
    const events = await p.run((tx) => tx.domainEvent.findMany({ where: { projectId: p.owner.projectId, type: "issues.github.linked", subjectId: issue.id } }));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.data)).not.toContain("Checkout");

    // A second run of the same job changes nothing.
    await runJob(requestId, 2);
    expect(posts()).toHaveLength(1);
    const detail = await call("owner", "GET", `/issues/issues/${issue.id}`);
    expect(detail.json().githubRequests).toEqual([
      expect.objectContaining({ id: requestId, status: "done", repository: "o/web", code: null }),
    ]);
    expect(typeof detail.json().githubRequests[0].requestedAt).toBe("string");
  });

  it("reconciles after an unclear create", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["unclear"];
    await expect(runJob(requestId, 1)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(await request(requestId)).toMatchObject({ status: "sending", attempts: 1 });
    expect(posts()).toHaveLength(1);

    await runJob(requestId, 2);
    // The retry listed the App's issues, found the marker and did not post.
    expect(calls.some((c) => c.method === "GET" && c.url.startsWith(`${ISSUES_URL}?`))).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(gh.issues).toHaveLength(1);
    const externalId = `o/web#${gh.issues[0]!.number}`;
    expect(await request(requestId)).toMatchObject({ status: "done", externalId });
    const refs = await p.run((tx) => tx.issueExternalRef.findMany({ where: { issueId: issue.id } }));
    expect(refs.map((r) => r.externalId)).toEqual([externalId]);
  });

  it("marks outcome_unknown on the last attempt without a second POST; reconcile settles it later", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["502", "502", "502"];
    await expect(runJob(requestId, 1)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    // Attempts 2 and 3 run seconds after the unclear POST: an empty listing
    // proves nothing yet (GitHub may lag), so neither posts again (R15).
    await expect(runJob(requestId, 2)).rejects.toThrow("ISSUES_GITHUB_RECONCILE_WAIT");
    expect(await request(requestId)).toMatchObject({ status: "sending", attempts: 1 });
    // The last attempt gives up without throwing.
    await runJob(requestId, 3);
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown", code: "JOB_OUTCOME_UNKNOWN", attempts: 1 });
    expect(posts()).toHaveLength(1);
    expect(await p.run((tx) => tx.issueExternalRef.count({ where: { issueId: issue.id } }))).toBe(0);

    expect((await call("editor", "POST", `/issues/github/requests/${requestId}/reconcile`)).statusCode).toBe(403);
    const reconcile = () => call("owner", "POST", `/issues/github/requests/${requestId}/reconcile`);
    // Still under 2 minutes after the POST: nothing settles.
    expect((await reconcile()).json()).toEqual({ status: "outcome_unknown" });
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown" });
    await ageSending(requestId);
    const settled = await reconcile();
    expect([settled.statusCode, settled.json()]).toEqual([200, { status: "failed" }]);
    expect(await request(requestId)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_NOT_FOUND" });
    expect(posts()).toHaveLength(1);
  });

  it("an empty listing right after an unclear POST makes no second POST; an old one does", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["502", "ok"];
    await expect(runJob(requestId, 1)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    await expect(runJob(requestId, 2)).rejects.toThrow("ISSUES_GITHUB_RECONCILE_WAIT");
    expect(calls.some((c) => c.method === "GET" && c.url.startsWith(`${ISSUES_URL}?`))).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(await request(requestId)).toMatchObject({ status: "sending", attempts: 1 });
    // The complete listing is still empty once the POST is 2 minutes old: definitely not created.
    await ageSending(requestId);
    await runJob(requestId, 3);
    expect(posts()).toHaveLength(2);
    expect(await request(requestId)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("an issue GitHub lists late is linked by reconcile, never created twice", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["unclear"];
    gh.lagging = true;
    await expect(runJob(requestId, 1)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    await expect(runJob(requestId, 2)).rejects.toThrow("ISSUES_GITHUB_RECONCILE_WAIT");
    await runJob(requestId, 3);
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown", code: "JOB_OUTCOME_UNKNOWN" });
    expect(posts()).toHaveLength(1);
    gh.lagging = false;
    const reconciled = await call("owner", "POST", `/issues/github/requests/${requestId}/reconcile`);
    expect([reconciled.statusCode, reconciled.json()]).toEqual([200, { status: "done" }]);
    expect(await request(requestId)).toMatchObject({ status: "done", externalId: `o/web#${gh.issues[0]!.number}` });
    expect(await p.run((tx) => tx.issueExternalRef.count({ where: { issueId: issue.id } }))).toBe(1);
    expect(posts()).toHaveLength(1);
  });

  it("reconcile settles an unclear request whose GitHub issue another Orbit issue holds", async () => {
    /** An unclear create that GitHub lists only later: outcome_unknown, issue exists. */
    const unclear = async () => {
      const issue = await readyIssue();
      const requestId = await requestCreate(issue.id);
      gh.create = ["unclear"];
      gh.lagging = true;
      await expect(runJob(requestId, 1)).rejects.toBeTruthy();
      await runJob(requestId, 3);
      expect(await request(requestId)).toMatchObject({ status: "outcome_unknown" });
      gh.lagging = false;
      return { issue, requestId, number: gh.issues.at(-1)!.number };
    };
    const reconcile = (requestId: string) => call("owner", "POST", `/issues/github/requests/${requestId}/reconcile`);

    // Held by another Orbit issue: failed, not stuck in outcome_unknown.
    const a = await unclear();
    const other = await readyIssue();
    await p.run((tx) =>
      tx.issueExternalRef.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          issueId: other.id,
          system: "github",
          externalId: `o/web#${a.number}`,
          url: `https://github.com/o/web/issues/${a.number}`,
          state: "open",
          createdBy: p.owner.userId,
        },
      }),
    );
    expect((await reconcile(a.requestId)).json()).toEqual({ status: "failed" });
    expect(await request(a.requestId)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_ALREADY_LINKED" });
    expect(
      await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.failed", resourceId: a.requestId } })),
    ).toBe(1);

    // Linked to this issue by hand meanwhile: done, without a second "linked" record.
    const b = await unclear();
    gh.remote[b.number] = { state: "open" };
    const manual = await call("owner", "POST", `/issues/issues/${b.issue.id}/github/link`, { url: `https://github.com/o/web/issues/${b.number}` });
    expect(manual.statusCode).toBe(200);
    const events = () => p.run((tx) => tx.issueEvent.count({ where: { issueId: b.issue.id, type: "github" } }));
    const linkedAudits = () =>
      p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.linked", metadata: { path: ["issueId"], equals: b.issue.id } } }));
    const domain = () => p.run((tx) => tx.domainEvent.count({ where: { projectId: p.owner.projectId, type: "issues.github.linked", subjectId: b.issue.id } }));
    const before = { events: await events(), audits: await linkedAudits(), domain: await domain() };
    expect((await reconcile(b.requestId)).json()).toEqual({ status: "done" });
    expect(await request(b.requestId)).toMatchObject({ status: "done", externalId: `o/web#${b.number}` });
    expect({ events: await events(), audits: await linkedAudits(), domain: await domain() }).toEqual(before);
    expect(await p.run((tx) => tx.issueExternalRef.count({ where: { issueId: b.issue.id } }))).toBe(1);
    expect(posts()).toHaveLength(2);
  });

  it("outcome_unknown blocks a new request until reconcile settles it as not found", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["502", "502", "502"];
    await expect(runJob(requestId, 1)).rejects.toBeTruthy();
    await expect(runJob(requestId, 2)).rejects.toBeTruthy();
    await runJob(requestId, 3);
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown" });
    expect(typeof (await request(requestId)).sendingAt).toBe("string");
    const before = posts().length;
    const reconcile = () => call("owner", "POST", `/issues/github/requests/${requestId}/reconcile`);

    // While the outcome is unknown, no new request may create the issue again.
    const again = await call("owner", "POST", `/issues/issues/${issue.id}/github`, { repository: "web" });
    expect([again.statusCode, code(again)]).toEqual([409, "ISSUES_GITHUB_REQUEST_STATE"]);

    // An empty listing right after the POST settles nothing (GitHub may lag).
    expect((await reconcile()).json()).toEqual({ status: "outcome_unknown" });
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown" });
    // An incomplete or failing listing settles nothing either.
    await ageSending(requestId);
    gh.list = 503;
    expect((await reconcile()).statusCode).toBe(409);
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown" });
    gh.list = 200;

    // A complete, empty listing after 2 minutes: definitely not created.
    expect((await reconcile()).json()).toEqual({ status: "failed" });
    expect(await request(requestId)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_NOT_FOUND" });
    expect(
      await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.failed", resourceId: requestId } })),
    ).toBe(1);
    expect(posts()).toHaveLength(before);
    // Reconciling a failed request is refused; a new request is allowed now.
    expect(code(await reconcile())).toBe("ISSUES_GITHUB_REQUEST_STATE");
    const fresh = await requestCreate(issue.id);
    expect(fresh).not.toBe(requestId);
  });

  it("never posts again when the listing fails", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["unclear"];
    await expect(runJob(requestId, 1)).rejects.toBeTruthy();
    expect(posts()).toHaveLength(1);
    // GitHub fails while listing: the retry stops before any write.
    gh.list = 503;
    await expect(runJob(requestId, 2)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(await request(requestId)).toMatchObject({ status: "sending" });
    await runJob(requestId, 3);
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown", code: "GITHUB_UNAVAILABLE" });
    expect(posts()).toHaveLength(1);
    // A definite refusal of the listing gives up at once, also before the last attempt.
    const other = await readyIssue();
    const otherId = await requestCreate(other.id);
    gh.create = ["unclear"];
    await expect(runJob(otherId, 1)).rejects.toBeTruthy();
    gh.list = 401;
    await runJob(otherId, 2);
    expect(await request(otherId)).toMatchObject({ status: "outcome_unknown", code: "GITHUB_RECONNECT_REQUIRED" });
    expect(posts()).toHaveLength(2);
  });

  it("a crashed last attempt leaves the request reconcilable", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    await p.run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id: requestId } });
      await tx.entity.update({ where: { id: requestId }, data: { data: { ...data(row), status: "sending", attempts: 1 } } });
    });
    const expire = registeredJobs().get(ISSUES_GITHUB)!.onLeaseExpired!;
    await p.run((tx) => expire(tx, worker(), { resourceId: requestId, attempts: 2, maxAttempts: 3 }));
    expect(await request(requestId)).toMatchObject({ status: "sending" });
    await p.run((tx) => expire(tx, worker(), { resourceId: requestId, attempts: 3, maxAttempts: 3 }));
    expect(await request(requestId)).toMatchObject({ status: "outcome_unknown", code: "JOB_OUTCOME_UNKNOWN" });
    expect(calls).toHaveLength(0);
  });

  it("a paused project settles a blocked request: queued fails, sending becomes reconcilable", async () => {
    const block = registeredJobs().get(ISSUES_GITHUB)!.onBlockedByPause!;
    const queuedIssue = await readyIssue();
    const queued = await requestCreate(queuedIssue.id);
    await p.run((tx) => block(tx, { resourceId: queued }, worker()));
    expect(await request(queued)).toMatchObject({ status: "failed", code: "PROJECT_PAUSED" });

    const sendingIssue = await readyIssue();
    const sending = await requestCreate(sendingIssue.id);
    await p.run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id: sending } });
      await tx.entity.update({ where: { id: sending }, data: { data: { ...data(row), status: "sending", attempts: 1 } } });
    });
    await p.run((tx) => block(tx, { resourceId: sending }, worker()));
    expect(await request(sending)).toMatchObject({ status: "outcome_unknown", code: "PROJECT_PAUSED" });
    // A settled request is left alone.
    await p.run((tx) => block(tx, { resourceId: queued }, worker()));
    expect(await request(queued)).toMatchObject({ status: "failed", code: "PROJECT_PAUSED" });
    expect(calls).toHaveLength(0);
  });

  it("a definite 422 fails without retry", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    gh.create = ["422"];
    await runJob(requestId, 1);
    expect(await request(requestId)).toMatchObject({ status: "failed", code: "GITHUB_VALIDATION_FAILED" });
    await runJob(requestId, 2);
    expect(posts()).toHaveLength(1);
    expect(
      await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.failed", resourceId: requestId } })),
    ).toBe(1);
  });

  it("refuses without share review / unconfirmed / duplicate status / already linked in this repository", async () => {
    const unreviewed = await readyIssue({ reviewed: false });
    expect(code(await call("owner", "POST", `/issues/issues/${unreviewed.id}/github`, { repository: "web" }))).toBe("ISSUES_SHARE_REVIEW_REQUIRED");
    const unconfirmed = await readyIssue({ confirmed: false });
    expect(code(await call("owner", "POST", `/issues/issues/${unconfirmed.id}/github`, { repository: "web" }))).toBe("ISSUES_NOT_CONFIRMED");
    const duplicate = await readyIssue();
    await p.run((tx) => tx.issue.update({ where: { id: duplicate.id }, data: { status: "duplicate", mergedIntoIssueId: unreviewed.id, closedAt: new Date() } }));
    expect(code(await call("owner", "POST", `/issues/issues/${duplicate.id}/github`, { repository: "web" }))).toBe("ISSUES_NOT_CONFIRMED");
    const ready = await readyIssue();
    expect(code(await call("owner", "POST", `/issues/issues/${ready.id}/github`, { repository: "other" }))).toBe("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED");
    const requestId = await requestCreate(ready.id);
    // A request in flight blocks a second one.
    const twice = await call("owner", "POST", `/issues/issues/${ready.id}/github`, { repository: "web" });
    expect([twice.statusCode, code(twice)]).toEqual([409, "ISSUES_GITHUB_REQUEST_STATE"]);
    await runJob(requestId);
    const linked = await call("owner", "POST", `/issues/issues/${ready.id}/github`, { repository: "web" });
    expect([linked.statusCode, code(linked)]).toEqual([409, "ISSUES_GITHUB_ALREADY_LINKED"]);
    expect(posts()).toHaveLength(1);
  });

  it("fails in the job when the issue was edited, the grant revoked or the repo became public", async () => {
    // Edited after the request: the share review is gone.
    const edited = await readyIssue();
    const editedRequest = await requestCreate(edited.id);
    await p.run((tx) => updateIssue(tx, p.owner, edited.id, { title: "Checkout broken", expectedVersion: edited.version }, userActor(p.owner)));
    await runJob(editedRequest);
    expect(await request(editedRequest)).toMatchObject({ status: "failed", code: "ISSUES_SHARE_REVIEW_REQUIRED" });

    // The project grant revoked between request and job.
    const revoked = await readyIssue();
    const revokedRequest = await requestCreate(revoked.id);
    await revokeConnectionGrant(admin, projectGrantId);
    try {
      await runJob(revokedRequest);
      expect(await request(revokedRequest)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_NOT_CONNECTED" });
    } finally {
      projectGrantId = (
        await grantConnection(admin, connectionId, {
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          purposes: ["issues"],
          modules: ["issues"],
        })
      ).id;
    }

    // The repository became public.
    const exposed = await readyIssue();
    const exposedRequest = await requestCreate(exposed.id);
    gh.private = false;
    await runJob(exposedRequest);
    expect(await request(exposedRequest)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_REPOSITORY_PUBLIC" });

    expect(posts()).toHaveLength(0);
    expect(await p.run((tx) => tx.issueExternalRef.count({ where: { issueId: { in: [edited.id, revoked.id, exposed.id] } } }))).toBe(0);
  });

  it("preview returns the exact text and writes nothing", async () => {
    const issue = await readyIssue();
    const before = await countRows(issue.id);
    const preview = await call("owner", "POST", `/issues/issues/${issue.id}/github/preview`, { repository: "web" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      title: `[ISS-${issue.number}] Checkout button does nothing`,
      repository: "o/web",
      hits: {},
    });
    expect(preview.json().body.split("\n")[0]).toBe("<!-- orbit-ref:00000000-0000-0000-0000-000000000000 -->");
    expect(preview.json().body).toContain("Clicking checkout leaves the cart unchanged.");
    expect(await countRows(issue.id)).toEqual(before);
    expect(calls).toHaveLength(0);

    expect((await call("editor", "POST", `/issues/issues/${issue.id}/github/preview`, { repository: "web" })).statusCode).toBe(403);
    expect((await call("editor", "POST", `/issues/issues/${issue.id}/github`, { repository: "web" })).statusCode).toBe(403);
    delete process.env.ORBIT_ISSUES_GITHUB;
    for (const url of [`/issues/issues/${issue.id}/github/preview`, `/issues/issues/${issue.id}/github`]) {
      const off = await call("owner", "POST", url, { repository: "web" });
      expect([off.statusCode, code(off)]).toEqual([404, "ISSUES_GITHUB_DISABLED"]);
    }
    expect(await countRows(issue.id)).toEqual(before);
  });

  it("refuses the job while the flag is off", async () => {
    const issue = await readyIssue();
    const requestId = await requestCreate(issue.id);
    delete process.env.ORBIT_ISSUES_GITHUB;
    await runJob(requestId);
    expect(await request(requestId)).toMatchObject({ status: "failed", code: "ISSUES_GITHUB_DISABLED" });
    expect(calls).toHaveLength(0);
  });

  it("privacy canary: a ticket-linked report never reaches GitHub", async () => {
    const issue = await readyIssue();
    // A support ticket's report with a customer address, stored unredacted on purpose.
    await p.run((tx) =>
      tx.issueReport.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          issueId: issue.id,
          sourceKind: "support",
          externalSystem: "support",
          externalId: randomUUID(),
          title: `Ticket from ${CANARY}`,
          symptoms: `${CANARY} says checkout fails`,
          occurredAt: new Date(),
          reportedByKind: "integration",
        },
      }),
    );
    const preview = await call("owner", "POST", `/issues/issues/${issue.id}/github/preview`, { repository: "web" });
    expect(JSON.stringify(preview.json())).not.toContain(CANARY);
    const requestId = await requestCreate(issue.id);
    await runJob(requestId);
    expect(posts()).toHaveLength(1);
    for (const c of calls) {
      expect(c.body).not.toContain(CANARY);
      expect(c.body).not.toContain("Ticket from");
      expect(c.url).not.toContain(encodeURIComponent(CANARY));
    }
    const stored = await p.run(async (tx) =>
      JSON.stringify([
        await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: REQUEST_KIND } }),
        await tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: { startsWith: "issues.github" } } }),
        await tx.issueEvent.findMany({ where: { issueId: issue.id, type: { startsWith: "github" } } }),
      ]),
    );
    expect(stored).not.toContain(CANARY);
    expect(stored).not.toContain("ghs_fake");
    expect(stored).not.toContain("Clicking checkout");
  });

  const refsOf = (issueId: string) => p.run((tx) => tx.issueExternalRef.findMany({ where: { issueId }, orderBy: { createdAt: "asc" } }));
  const link = (issueId: string, url: string, who: "owner" | "editor" = "owner") =>
    call(who, "POST", `/issues/issues/${issueId}/github/link`, { url });
  const addRef = (issueId: string, externalId: string, syncedAt: Date | null, system = "github", state = "open") =>
    p.run((tx) =>
      tx.issueExternalRef.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          issueId,
          system,
          externalId,
          url: null,
          state,
          syncedAt,
          createdBy: "test",
        },
      }),
    );

  it("links an existing GitHub issue with a read-only token", async () => {
    const issue = await readyIssue();
    gh.remote[101] = { state: "open" };
    const linked = await link(issue.id, "https://github.com/o/web/issues/101#issuecomment-1");
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ system: "github", externalId: "o/web#101", url: "https://github.com/o/web/issues/101", state: "open" });
    const tokens = calls.filter((c) => c.url.endsWith("/access_tokens")).map((c) => JSON.parse(c.body));
    expect(tokens).toEqual([{ repositories: ["web"], permissions: { issues: "read", metadata: "read" } }]);
    expect(calls.filter((c) => c.method !== "POST").map((c) => c.url)).toEqual(["https://api.github.com/repos/o/web/issues/101"]);
    expect(calls.every((c) => c.method === "GET" || c.url.endsWith("/access_tokens"))).toBe(true);
    expect(await refsOf(issue.id)).toHaveLength(1);
    const events = await p.run((tx) => tx.issueEvent.findMany({ where: { issueId: issue.id, type: "github" } }));
    expect(events.map((e) => e.after)).toEqual([expect.objectContaining({ action: "linked", via: "manual", externalId: "o/web#101" })]);
    expect(await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.linked", resourceId: linked.json().id } }))).toBe(1);
    expect(await p.run((tx) => tx.domainEvent.count({ where: { projectId: p.owner.projectId, type: "issues.github.linked", subjectId: issue.id } }))).toBe(1);
    // The same GitHub issue cannot be linked twice, to another or to the same Orbit issue.
    const other = await readyIssue();
    const second = await link(other.id, "https://github.com/O/Web/issues/101");
    expect([second.statusCode, code(second)]).toEqual([409, "ISSUES_GITHUB_ALREADY_LINKED"]);
    const again = await link(issue.id, "https://github.com/o/web/issues/101");
    expect([again.statusCode, code(again)]).toEqual([409, "ISSUES_GITHUB_ALREADY_LINKED"]);
    expect(await refsOf(other.id)).toHaveLength(0);
    expect(await refsOf(issue.id)).toHaveLength(1);
  });

  it("refuses pull requests and unlisted or invalid URLs before any GitHub call", async () => {
    const issue = await readyIssue();
    gh.remote[102] = { state: "open", pull_request: {} };
    const pr = await link(issue.id, "https://github.com/o/web/issues/102");
    expect([pr.statusCode, code(pr)]).toEqual([400, "ISSUES_GITHUB_URL_INVALID"]);
    expect(calls.length).toBeGreaterThan(0);

    calls = [];
    const refused: Array<[string, number, string]> = [
      ["https://github.com/o/other/issues/5", 409, "ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED"],
      ["https://github.com/o/web/pull/5", 400, "ISSUES_GITHUB_URL_INVALID"],
      ["https://example.com/o/web/issues/5", 400, "ISSUES_GITHUB_URL_INVALID"],
      ["https://github.com/o/web/issues/0", 400, "ISSUES_GITHUB_URL_INVALID"],
      ["not a url", 400, "ISSUES_GITHUB_URL_INVALID"],
    ];
    for (const [url, status, expected] of refused) {
      const response = await link(issue.id, url);
      expect([url, response.statusCode, code(response)]).toEqual([url, status, expected]);
    }
    expect(calls).toHaveLength(0);
    expect(await refsOf(issue.id)).toHaveLength(0);
  });

  it("refreshes the state of linked issues and keeps going past failures", async () => {
    const issue = await readyIssue();
    const old = new Date(Date.now() - 3_600_000);
    await addRef(issue.id, "o/web#201", old);
    await addRef(issue.id, "o/web#202", old);
    await addRef(issue.id, "o/web#203", old);
    await addRef(issue.id, "o/web#204", old);
    await addRef(issue.id, "gone/repo#1", old, "github", "open");
    await addRef(issue.id, "TICKET-9", old, "jira", "open");
    gh.remote[201] = { state: "closed", state_reason: "completed" };
    gh.remote[202] = { state: "closed", state_reason: "not_planned" };
    gh.remote[203] = { state: "closed", state_reason: null };
    // 204 does not exist on GitHub any more.
    const before = await p.run((tx) => tx.issue.findUnique({ where: { id: issue.id } }));

    const refreshed = await call("owner", "POST", `/issues/issues/${issue.id}/github/refresh`);
    expect(refreshed.statusCode).toBe(200);
    const byId = Object.fromEntries(refreshed.json().refs.map((r: { externalId: string }) => [r.externalId, r]));
    expect(byId["o/web#201"]).toMatchObject({ state: "closed", stateReason: "completed", error: null });
    expect(byId["o/web#202"]).toMatchObject({ state: "closed", stateReason: "not_planned", error: null });
    expect(byId["o/web#203"]).toMatchObject({ state: "closed", stateReason: null, error: null });
    expect(byId["o/web#204"]).toMatchObject({ state: "open", error: "ISSUES_GITHUB_NOT_FOUND" });
    expect(byId["gone/repo#1"]).toMatchObject({ state: "open", error: "ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED" });
    expect(byId["TICKET-9"]).toBeUndefined();
    // Only the allow-listed repository was contacted, with a read-only token.
    expect(calls.every((c) => c.url.includes("/o/web") || c.url.endsWith("/access_tokens"))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/access_tokens")).map((c) => JSON.parse(c.body))).toEqual([
      { repositories: ["web"], permissions: { issues: "read", metadata: "read" } },
    ]);
    const stored = await refsOf(issue.id);
    expect(stored.find((r) => r.system === "jira")).toMatchObject({ state: "open", syncedAt: old });
    expect(stored.find((r) => r.externalId === "o/web#204")!.syncedAt).toEqual(old);
    expect(stored.find((r) => r.externalId === "o/web#201")!.syncedAt!.getTime()).toBeGreaterThan(old.getTime());
    // The Orbit issue itself is untouched.
    expect(await p.run((tx) => tx.issue.findUnique({ where: { id: issue.id } }))).toEqual(before);

    calls = [];
    const soon = await call("owner", "POST", `/issues/issues/${issue.id}/github/refresh`);
    expect([soon.statusCode, code(soon)]).toEqual([429, "ISSUES_GITHUB_REFRESH_TOO_SOON"]);
    expect(calls).toHaveLength(0);
  });

  it("unlinks only the github ref of that issue", async () => {
    const issue = await readyIssue();
    const other = await readyIssue();
    const gitRef = await addRef(issue.id, "o/web#301", null);
    const jira = await addRef(issue.id, "TICKET-301", null, "jira");
    const foreign = await addRef(other.id, "o/web#302", null);
    const del = (refId: string, issueId = issue.id, who: "owner" | "editor" = "owner") =>
      call(who, "DELETE", `/issues/issues/${issueId}/github/${refId}`);

    expect((await del(jira.id)).statusCode).toBe(404);
    expect((await del(foreign.id)).statusCode).toBe(404);
    expect((await del(gitRef.id, issue.id, "editor")).statusCode).toBe(403);
    expect(await refsOf(issue.id)).toHaveLength(2);

    const removed = await del(gitRef.id);
    expect(removed.statusCode).toBe(200);
    expect((await refsOf(issue.id)).map((r) => r.system)).toEqual(["jira"]);
    expect(await refsOf(other.id)).toHaveLength(1);
    expect(calls).toHaveLength(0);
    const events = await p.run((tx) => tx.issueEvent.findMany({ where: { issueId: issue.id, type: "github" } }));
    expect(events.map((e) => e.after)).toEqual([expect.objectContaining({ action: "unlinked", externalId: "o/web#301" })]);
    expect(await p.run((tx) => tx.auditEvent.count({ where: { projectId: p.owner.projectId, action: "issues.github.unlinked", resourceId: gitRef.id } }))).toBe(1);
    expect(await p.run((tx) => tx.domainEvent.count({ where: { projectId: p.owner.projectId, type: "issues.github.unlinked", subjectId: issue.id } }))).toBe(1);
  });

  it("limits link and refresh to the owner and the flag", async () => {
    const issue = await readyIssue();
    gh.remote[401] = { state: "open" };
    expect((await link(issue.id, "https://github.com/o/web/issues/401", "editor")).statusCode).toBe(403);
    expect((await call("editor", "POST", `/issues/issues/${issue.id}/github/refresh`)).statusCode).toBe(403);
    delete process.env.ORBIT_ISSUES_GITHUB;
    for (const response of [
      await link(issue.id, "https://github.com/o/web/issues/401"),
      await call("owner", "POST", `/issues/issues/${issue.id}/github/refresh`),
      await call("owner", "DELETE", `/issues/issues/${issue.id}/github/${randomUUID()}`),
    ])
      expect([response.statusCode, code(response)]).toEqual([404, "ISSUES_GITHUB_DISABLED"]);
    expect(calls).toHaveLength(0);
    expect(await refsOf(issue.id)).toHaveLength(0);
  });

  it("reports a missing GitHub issue as not found, a failing token mint as reconnect", async () => {
    const issue = await readyIssue();
    const missing = await link(issue.id, "https://github.com/o/web/issues/501");
    expect([missing.statusCode, code(missing)]).toEqual([404, "ISSUES_GITHUB_NOT_FOUND"]);
    expect(await refsOf(issue.id)).toHaveLength(0);

    gh.remote[502] = { state: "open" };
    setGithubFetchForTests(async (url) => {
      calls.push({ method: "POST", url: String(url), body: "" });
      return new Response("{}", { status: 401 });
    });
    const mint = await link(issue.id, "https://github.com/o/web/issues/502");
    expect([mint.statusCode, code(mint)]).toEqual([409, "GITHUB_RECONNECT_REQUIRED"]);
    expect(await refsOf(issue.id)).toHaveLength(0);
  });
});
