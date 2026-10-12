import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { FetchLike } from "../../../packages/connectors/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, encrypt, entity, list } from "../src/shared.ts";
import {
  listPublishedArticles,
  loadBlogTarget,
  markTokenInvalid,
  verifyBlogTarget,
} from "../src/modules/blog-target.ts";
import { readiness } from "../src/modules/readiness.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Synthetic token; the fake GitHub below is the only "GitHub" these tests reach.
const TOKEN = "github_pat_synthetic_0123456789_ABCDEFGHIJ";
const OWNER = "eds-labs";
const REPO = "uliquid-desk-website-v2";
const HEAD = "1".repeat(40);
const FIXTURES = new URL(
  "../../../packages/connectors/src/blog-targets/fixtures/",
  import.meta.url,
);
const fixture = (name: string) =>
  readFileSync(new URL(`${name}.json`, FIXTURES), "utf8");
const FIXTURE_POSTS = {
  "market-intelligence-context-not-signal.json": fixture(
    "market-intelligence-context-not-signal",
  ),
  "ai-assisted-trading-keeps-decisions-with-the-user.json": fixture(
    "ai-assisted-trading-keeps-decisions-with-the-user",
  ),
};

/** An in-memory GitHub for one repository; it records every call. */
function fakeGithub(
  options: {
    posts?: Record<string, string>;
    createStatus?: number;
    deleteStatus?: number;
    authFail?: boolean;
    // Every call answers with this status (e.g. 502), as a GitHub outage would.
    outage?: number;
    // The only token this GitHub accepts; anything else is a 401.
    token?: string;
  } = {},
) {
  const posts: Record<string, string> = options.posts ?? FIXTURE_POSTS;
  const created: string[] = [];
  const deleted: string[] = [];
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const root = `/repos/${OWNER}/${REPO}`;
  const dir = `${root}/contents/content/blog/posts`;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const bearer = new Headers(init.headers).get("authorization");
    if (options.authFail || bearer !== `Bearer ${options.token ?? TOKEN}`)
      return json(401, { message: "Bad credentials" });
    if (options.outage) return json(options.outage, { message: "Bad gateway" });
    if (method === "GET" && url.pathname === root)
      return json(200, { default_branch: "main", private: true });
    if (method === "GET" && url.pathname === `${root}/git/ref/heads/main`)
      return json(200, { object: { sha: HEAD } });
    if (method === "GET" && url.pathname === dir)
      return json(
        200,
        Object.keys(posts).map((name) => ({
          name,
          path: `content/blog/posts/${name}`,
          sha: "a".repeat(40),
          type: "file",
        })),
      );
    if (method === "GET" && url.pathname.startsWith(`${dir}/`)) {
      const name = decodeURIComponent(url.pathname.slice(dir.length + 1));
      if (!(name in posts)) return json(404, { message: "Not Found" });
      return json(200, {
        sha: "b".repeat(40),
        content: Buffer.from(posts[name]!, "utf8").toString("base64"),
      });
    }
    if (method === "POST" && url.pathname === `${root}/git/refs`) {
      const body = JSON.parse(String(init.body));
      if (options.createStatus)
        return json(options.createStatus, {
          message: "Resource not accessible by personal access token",
        });
      created.push(body.ref);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === "DELETE" && url.pathname.startsWith(`${root}/git/refs/`)) {
      if (options.deleteStatus)
        return json(options.deleteStatus, { message: "Server Error" });
      deleted.push(url.pathname.slice(`${root}/git/refs/`.length));
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, created, deleted, calls };
}

describe.skipIf(!enabled)("GitHub blog target (R81)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope, workspaceId: string;
  let github = fakeGithub();
  const people = {} as Record<
    "owner" | "editor",
    { id: string; cookie: string }
  >;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const request = (who: keyof typeof people, path: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${owner.projectId}/${path}`,
      headers: { origin: process.env.APP_ORIGIN!, cookie: people[who].cookie },
      payload: payload as any,
    });
  const githubInput = (extra: Record<string, unknown> = {}) => ({
    provider: "github",
    owner: OWNER,
    repo: REPO,
    siteUrl: "https://uliquid.vip",
    profile: "uliquid-blog-json-v1",
    tokenExpiresAt: "2027-01-31",
    credential: TOKEN,
    ...extra,
  });
  /** A stored github connector as the connector action writes it. */
  const addConnector = (extra: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, owner, "connectors", {
        provider: "github",
        owner: OWNER,
        repo: REPO,
        baseBranch: "main",
        postsPath: "content/blog/posts",
        siteUrl: "https://uliquid.vip",
        blogPathPrefix: "/blog/",
        profile: "uliquid-blog-json-v1",
        tokenExpiresAt: "2027-01-31",
        encryptedCredential: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
        status: "configured",
        capabilities: [],
        ...extra,
      }),
    );
  const connector = (id: string) =>
    run(async (tx) => data(await entity(tx, owner, "connectors", id)));
  const linkBot = () =>
    run((tx) =>
      create(tx, owner, "telegram_connections", {
        status: "linked",
        chatId: "4711",
        linkedUserId: owner.userId,
        linkedAt: new Date().toISOString(),
      }),
    );
  const jobsOf = (kind: string) =>
    run(async (tx) =>
      (await list(tx, owner, "jobs"))
        .map(data)
        .filter((job) =>
          String(job.idempotencyKey).startsWith(`notify:${kind}:`),
        ),
    );

  beforeAll(async () => {
    app = await buildServer(undefined, {
      githubFetch: (...args) => github.fetch(...args),
    });
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    for (const role of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: `Synthetic blog ${role}`, password },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: process.env.APP_ORIGIN! },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const cookies = r.headers["set-cookie"];
      people[role] = {
        id: signedUp.user.id,
        cookie: (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; "),
      };
    }
  });
  beforeEach(async () => {
    process.env.ORBIT_BLOG_GITHUB = "true";
    process.env.ORBIT_AGENTS = "true";
    github = fakeGithub();
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Isolated blog target",
          members: { create: { userId: people.owner.id, role: "owner" } },
        },
      })
    ).id;
    const project = await authDb.project.create({
      data: {
        workspaceId,
        name: "Blog target fixture",
        timezone: "Europe/Berlin",
      },
    });
    owner = {
      workspaceId,
      projectId: project.id,
      userId: people.owner.id,
      role: "owner",
    };
    for (const role of ["owner", "editor"] as const) {
      if (role !== "owner")
        await authDb.workspaceMember.create({
          data: { workspaceId, userId: people[role].id, role: "viewer" },
        });
      await authDb.projectMember.create({
        data: {
          workspaceId,
          projectId: project.id,
          userId: people[role].id,
          role,
        },
      });
    }
  });
  afterEach(async () => {
    delete process.env.ORBIT_BLOG_GITHUB;
    delete process.env.ORBIT_AGENTS;
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
  });
  afterAll(async () => {
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((p) => p.id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  describe("connector", () => {
    it("stores the token encrypted, never returns it and starts as configured", async () => {
      const r = await request("owner", "actions/connector", githubInput());
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(TOKEN);
      const body = r.json();
      expect(body.data).toMatchObject({
        provider: "github",
        owner: OWNER,
        repo: REPO,
        baseBranch: "main",
        postsPath: "content/blog/posts",
        siteUrl: "https://uliquid.vip",
        blogPathPrefix: "/blog/",
        profile: "uliquid-blog-json-v1",
        tokenExpiresAt: "2027-01-31",
        status: "configured",
      });
      expect(body.data.encryptedCredential).toBeUndefined();
      expect(body.data.credential).toBeUndefined();
      const stored = await connector(body.id);
      expect(stored.encryptedCredential).toEqual(expect.any(String));
      expect(stored.encryptedCredential).not.toContain(TOKEN);
      const { target, token } = await run((tx) =>
        loadBlogTarget(tx, owner, body.id),
      );
      expect(token).toBe(TOKEN);
      expect(target).toMatchObject({
        connectorId: body.id,
        owner: OWNER,
        repo: REPO,
        status: "configured",
      });
    });

    it("refuses github while the flag is off, editors and unsafe input", async () => {
      process.env.ORBIT_BLOG_GITHUB = "false";
      const off = await request("owner", "actions/connector", githubInput());
      expect(off.statusCode).toBe(409);
      expect(off.json().code ?? off.body).toContain("BLOG_GITHUB_DISABLED");
      process.env.ORBIT_BLOG_GITHUB = "true";
      const editor = await request(
        "editor",
        "actions/connector",
        githubInput(),
      );
      expect(editor.statusCode).toBe(403);
      for (const bad of [
        { siteUrl: "http://uliquid.vip" },
        { owner: "eds labs" },
        { repo: "../x" },
        { profile: "other" },
        { postsPath: "../secrets" },
      ]) {
        const r = await request("owner", "actions/connector", githubInput(bad));
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        expect(r.statusCode).toBeLessThan(500);
      }
      expect(await run((tx) => list(tx, owner, "connectors"))).toEqual([]);
    });

    it("loadBlogTarget refuses a missing or non-github connector", async () => {
      const postiz = await run((tx) =>
        create(tx, owner, "connectors", {
          provider: "postiz",
          status: "configured",
        }),
      );
      for (const id of [postiz.id, randomUUID()])
        await expect(
          run((tx) => loadBlogTarget(tx, owner, id)),
        ).rejects.toMatchObject({ code: "BLOG_TARGET_NOT_CONFIGURED" });
    });
  });

  describe("verification", () => {
    it("reads, validates both posts, creates and deletes a verify branch: write_verified", async () => {
      const row = await addConnector();
      const result = await verifyBlogTarget(owner, row.id, {
        fetch: github.fetch,
      });
      expect(result).toEqual({ status: "write_verified", problems: [] });
      expect(github.created).toHaveLength(1);
      expect(github.created[0]).toMatch(
        /^refs\/heads\/orbit\/verify-[0-9a-f]{8}$/,
      );
      expect(github.deleted).toEqual([
        github.created[0]!.slice("refs/".length),
      ]);
      // main is never written.
      expect(
        github.calls.filter((c) => !c.startsWith("GET") && c.includes("/main")),
      ).toEqual([]);
      expect((await connector(row.id)).status).toBe("write_verified");
    });

    it("keeps configured and names the file when a post is invalid", async () => {
      const broken = JSON.parse(
        FIXTURE_POSTS["market-intelligence-context-not-signal.json"],
      );
      broken.title = "";
      github = fakeGithub({
        posts: {
          ...FIXTURE_POSTS,
          "market-intelligence-context-not-signal.json": JSON.stringify(broken),
        },
      });
      const row = await addConnector();
      const result = await verifyBlogTarget(owner, row.id, {
        fetch: github.fetch,
      });
      expect(result.status).not.toBe("write_verified");
      expect(result.problems.join("\n")).toContain(
        "market-intelligence-context-not-signal.json",
      );
      expect(github.created).toEqual([]);
      expect((await connector(row.id)).status).toBe("configured");
    });

    it("stops at read_verified when the branch create is refused", async () => {
      github = fakeGithub({ createStatus: 403 });
      const row = await addConnector();
      const result = await verifyBlogTarget(owner, row.id, {
        fetch: github.fetch,
      });
      expect(result).toEqual({
        status: "read_verified",
        problems: ["GITHUB_AUTH"],
      });
      expect((await connector(row.id)).status).toBe("read_verified");
    });

    it("reports a verify branch it could not delete and stays write_verified", async () => {
      github = fakeGithub({ deleteStatus: 500 });
      const row = await addConnector();
      const result = await verifyBlogTarget(owner, row.id, {
        fetch: github.fetch,
      });
      expect(result).toEqual({
        status: "write_verified",
        problems: ["VERIFY_BRANCH_NOT_DELETED"],
      });
      expect(github.created).toHaveLength(1);
      // The next verification deletes the leftover branch first.
      const leftover = github.created[0]!.slice("refs/heads/".length);
      const retry = fakeGithub();
      await verifyBlogTarget(owner, row.id, { fetch: retry.fetch });
      expect(retry.deleted).toContain(`heads/${leftover}`);
      expect((await connector(row.id)).pendingVerifyBranches ?? []).toEqual([]);
    });

    it("keeps a verified connector's status when GitHub answers 502 or 429", async () => {
      const row = await addConnector({ status: "write_verified" });
      for (const outage of [502, 429]) {
        github = fakeGithub({ outage });
        const result = await verifyBlogTarget(owner, row.id, {
          fetch: github.fetch,
        });
        expect(result.status).toBe("write_verified");
        expect(result.problems).toEqual([
          outage === 502 ? "GITHUB_UNAVAILABLE" : "RATE_LIMITED",
        ]);
        expect((await connector(row.id)).status).toBe("write_verified");
      }
      // A definitive refusal still downgrades.
      github = fakeGithub({ authFail: true });
      expect(
        await verifyBlogTarget(owner, row.id, { fetch: github.fetch }),
      ).toEqual({ status: "configured", problems: ["GITHUB_AUTH"] });
    });

    it("is reachable for the owner only through the verify route", async () => {
      const row = await addConnector();
      const editor = await request(
        "editor",
        `connectors/${row.id}/verify-github`,
        {},
      );
      expect(editor.statusCode).toBe(403);
      const r = await request(
        "owner",
        `connectors/${row.id}/verify-github`,
        {},
      );
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: "write_verified", problems: [] });
      process.env.ORBIT_BLOG_GITHUB = "false";
      const off = await request(
        "owner",
        `connectors/${row.id}/verify-github`,
        {},
      );
      expect(off.statusCode).toBe(409);
    });
  });

  describe("token renewal", () => {
    const NEW_TOKEN = "github_pat_synthetic_renewed_9876543210_ZYX";
    const renew = (who: "owner" | "editor", id: string, extra = {}) =>
      request(who, `connectors/${id}/github-credential`, {
        credential: NEW_TOKEN,
        tokenExpiresAt: "2027-06-30",
        ...extra,
      });

    it("replaces the token of the same connector and requires a new verification", async () => {
      await linkBot();
      const row = await addConnector({
        status: "write_verified",
        tokenExpiresAt: "2027-01-20",
      });
      await run((tx) => markTokenInvalid(tx, owner, row.id));
      const r = await renew("owner", row.id);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(NEW_TOKEN);
      expect(r.json().data.encryptedCredential).toBeUndefined();
      expect(r.json().data).toMatchObject({
        status: "configured",
        tokenExpiresAt: "2027-06-30",
        tokenInvalidAt: null,
        credentialGeneration: 2,
      });
      expect(await run((tx) => list(tx, owner, "connectors"))).toHaveLength(1);
      // The old token is refused by GitHub now; verification uses the new one.
      github = fakeGithub({ token: NEW_TOKEN });
      expect(
        await verifyBlogTarget(owner, row.id, { fetch: github.fetch }),
      ).toEqual({ status: "write_verified", problems: [] });
      // A later expiry of the new token notices again, even on the same date.
      await run((tx) =>
        sweepProject(tx, owner, new Date("2027-06-20T12:00:00.000Z")),
      );
      expect(
        (await jobsOf("github_token_expiring")).map((j) => j.idempotencyKey),
      ).toEqual([`notify:github_token_expiring:${row.id}:2027-06-30:2`]);
    });

    it("refuses editors, the flag off and connectors that are not github", async () => {
      const row = await addConnector();
      expect((await renew("editor", row.id)).statusCode).toBe(403);
      process.env.ORBIT_BLOG_GITHUB = "false";
      const off = await renew("owner", row.id);
      expect(off.statusCode).toBe(409);
      expect(off.body).toContain("BLOG_GITHUB_DISABLED");
      process.env.ORBIT_BLOG_GITHUB = "true";
      const postiz = await run((tx) =>
        create(tx, owner, "connectors", {
          provider: "postiz",
          status: "configured",
        }),
      );
      const wrong = await renew("owner", postiz.id);
      expect(wrong.statusCode).toBe(409);
      expect(wrong.body).toContain("BLOG_TARGET_NOT_CONFIGURED");
      expect((await renew("owner", randomUUID())).statusCode).toBe(404);
      expect(
        (await renew("owner", row.id, { tokenExpiresAt: "soon" })).statusCode,
      ).toBe(400);
      // Nothing changed on the github connector.
      expect((await connector(row.id)).tokenExpiresAt).toBe("2027-01-31");
    });
  });

  it("loadBlogTarget maps only not-found to BLOG_TARGET_NOT_CONFIGURED", async () => {
    // A database error (an id the uuid column refuses) is not "not configured".
    const error = await run((tx) =>
      loadBlogTarget(tx, owner, "not-a-uuid"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).not.toBe("BLOG_TARGET_NOT_CONFIGURED");
    // So is a stored credential that cannot be decrypted.
    const row = await addConnector({ encryptedCredential: "not.a.cipher" });
    await expect(
      run((tx) => loadBlogTarget(tx, owner, row.id)),
    ).rejects.toMatchObject({ code: "INVALID_ENCRYPTED_CREDENTIAL" });
  });

  it("lists the published articles newest first", async () => {
    const row = await addConnector({ status: "write_verified" });
    const articles = await listPublishedArticles(owner, row.id, {
      fetch: github.fetch,
    });
    const market = JSON.parse(
      FIXTURE_POSTS["market-intelligence-context-not-signal.json"],
    );
    const trading = JSON.parse(
      FIXTURE_POSTS["ai-assisted-trading-keeps-decisions-with-the-user.json"],
    );
    expect(articles).toEqual(
      [market, trading].map((p) => ({
        slug: p.slug,
        title: p.title,
        category: p.category,
        keywords: p.keywords,
        publishedAt: p.publishedAt,
      })),
    );
    expect(articles[0]!.publishedAt > articles[1]!.publishedAt).toBe(true);
  });

  describe("readiness blog_live", () => {
    const blogLive = async () =>
      (await run((tx) => readiness(tx, owner))).actions.blog_live;

    it("names the missing piece and is ready once write verified", async () => {
      process.env.ORBIT_BLOG_GITHUB = "false";
      expect(await blogLive()).toMatchObject({
        state: "not_configured",
        blockers: ["BLOG_GITHUB_DISABLED"],
      });
      process.env.ORBIT_BLOG_GITHUB = "true";
      expect(await blogLive()).toMatchObject({
        state: "not_configured",
        blockers: ["BLOG_TARGET_NOT_CONFIGURED"],
      });
      const row = await addConnector({ status: "read_verified" });
      expect(await blogLive()).toMatchObject({
        state: "blocked",
        blockers: ["GITHUB_WRITE_VERIFICATION_REQUIRED"],
      });
      await run(async (tx) => {
        const current = await entity(tx, owner, "connectors", row.id);
        await tx.entity.update({
          where: { id: row.id },
          data: { data: { ...data(current), status: "write_verified" } },
        });
      });
      expect(await blogLive()).toEqual({
        state: "ready",
        effect: "external",
        blockers: [],
      });
    });
  });

  describe("notices", () => {
    it("markTokenInvalid downgrades the connector and raises one notice", async () => {
      await linkBot();
      const row = await addConnector({ status: "write_verified" });
      await run((tx) => markTokenInvalid(tx, owner, row.id));
      await run((tx) => markTokenInvalid(tx, owner, row.id));
      expect((await connector(row.id)).status).toBe("configured");
      expect(await jobsOf("github_token_invalid")).toHaveLength(1);
    });

    it("a 401 while listing articles marks the token invalid", async () => {
      await linkBot();
      github = fakeGithub({ authFail: true });
      const row = await addConnector({ status: "write_verified" });
      await expect(
        listPublishedArticles(owner, row.id, { fetch: github.fetch }),
      ).rejects.toMatchObject({ code: "GITHUB_AUTH" });
      expect((await connector(row.id)).status).toBe("configured");
      expect(await jobsOf("github_token_invalid")).toHaveLength(1);
    });

    it("the daily sweep raises github_token_expiring 14 days ahead, once per connector", async () => {
      await linkBot();
      const at = new Date("2027-01-10T12:00:00.000Z");
      const soon = await addConnector({ tokenExpiresAt: "2027-01-20" });
      await addConnector({ tokenExpiresAt: "2027-03-01" });
      await run((tx) => sweepProject(tx, owner, at));
      await run((tx) =>
        sweepProject(tx, owner, new Date("2027-01-11T12:00:00.000Z")),
      );
      const jobs = await jobsOf("github_token_expiring");
      expect(jobs.map((job) => job.idempotencyKey)).toEqual([
        `notify:github_token_expiring:${soon.id}:2027-01-20:1`,
      ]);
    });
  });
});
