import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Post routes (ADR 0020, S4): everybody in the module reads posts; owners
 * and editors write them and ask for a schedule; another project's members
 * see nothing; error details reach the client.
 */
describe.skipIf(!enabled)("social post routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  let x = "";
  let telegram = "";
  const call = (who: keyof typeof ids, method: "GET" | "POST" | "PATCH", url: string, payload?: object, project = projectId) =>
    app.inject({
      method,
      url: `/api/projects/${project}/social${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic social ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic social media",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social media" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social media B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
    const account = (platform: string) =>
      scoped(workspaceId, projectId, (tx) =>
        tx.socialAccount.create({
          data: {
            id: randomUUID(),
            workspaceId,
            projectId,
            connectionId: randomUUID(),
            platform,
            externalId: randomUUID(),
            handle: `@${platform}_orbit`,
            displayName: platform,
            capability: "write_verified",
            createdBy: ids.owner,
          },
        }),
      );
    x = (await account("x")).id;
    telegram = (await account("telegram")).id;
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_SOCIAL = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_SOCIAL;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  const newPost = async (text = "We are live on X.") => {
    const response = await call("editor", "POST", "/posts", {
      baseText: "We are live.",
      baseMedia: [],
      variants: [{ accountId: telegram }, { accountId: x, text }],
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; version: number };
  };
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 11) + "10:00";

  it("lets an editor write and ask for a schedule, and a viewer read", async () => {
    const post = await newPost();
    const list = await call("viewer", "GET", "/posts");
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(post.id);
    expect((await call("viewer", "GET", `/posts/${post.id}`)).json()).toMatchObject({ id: post.id, status: "draft" });
    const edited = await call("editor", "PATCH", `/posts/${post.id}`, {
      version: 1,
      baseText: "We are live!",
      baseMedia: [],
      variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X." }],
    });
    expect(edited.json()).toMatchObject({ version: 2, baseText: "We are live!" });
    const checked = await call("editor", "POST", `/posts/${post.id}/validate`, {});
    expect(checked.json().variants).toHaveLength(2);
    const scheduled = await call("editor", "POST", `/posts/${post.id}/schedule`, { version: 2, local: inDays(3) });
    expect(scheduled.json()).toMatchObject({ status: "needs_approval", approval: { state: "pending" } });
    const moved = await call("editor", "POST", `/posts/${post.id}/reschedule`, { version: scheduled.json().version, local: inDays(4) });
    expect(moved.json()).toMatchObject({ status: "needs_approval", schedule: { local: inDays(4) } });
    const canceled = await call("editor", "POST", `/posts/${post.id}/cancel`, { version: moved.json().version });
    expect(canceled.json().status).toBe("draft");
    const archived = await call("editor", "POST", `/posts/${post.id}/archive`, { version: canceled.json().version });
    expect(archived.json().status).toBe("archived");
    const now = await newPost();
    expect((await call("editor", "POST", `/posts/${now.id}/publish-now`, { version: 1 })).json().status).toBe("needs_approval");
  });

  it("refuses every write to a viewer", async () => {
    const post = await newPost();
    const writes: Array<[method: "POST" | "PATCH", url: string, body: object]> = [
      ["POST", "/posts", { baseText: "x", baseMedia: [], variants: [{ accountId: x }] }],
      ["PATCH", `/posts/${post.id}`, { version: 1, baseText: "x", baseMedia: [], variants: [{ accountId: x }] }],
      ["POST", `/posts/${post.id}/validate`, {}],
      ["POST", `/posts/${post.id}/schedule`, { version: 1, local: inDays(3) }],
      ["POST", `/posts/${post.id}/publish-now`, { version: 1 }],
      ["POST", `/posts/${post.id}/reschedule`, { version: 1, local: inDays(3) }],
      ["POST", `/posts/${post.id}/cancel`, { version: 1 }],
      ["POST", `/posts/${post.id}/archive`, { version: 1 }],
    ];
    for (const [method, url, body] of writes) expect((await call("viewer", method, url, body)).statusCode, url).toBe(403);
  });

  it("sends the issues and the suggested time as error detail", async () => {
    const tooLong = await newPost("x".repeat(281));
    const refused = await call("owner", "POST", `/posts/${tooLong.id}/schedule`, { version: 1, local: inDays(3) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "SOCIAL_VALIDATION_FAILED", detail: { variants: [{ accountId: x }] } });
    const post = await newPost();
    const year = new Date().getUTCFullYear();
    const spring = [year, year + 1]
      .map((y) => {
        const last = new Date(Date.UTC(y, 3, 0));
        return `${y}-03-${String(last.getUTCDate() - last.getUTCDay()).padStart(2, "0")}T02:30`;
      })
      .find((l) => Date.parse(l + "Z") > Date.now() + 86_400_000)!;
    const gap = await call("owner", "POST", `/posts/${post.id}/schedule`, { version: 1, local: spring, timeZone: "Europe/Berlin" });
    expect([gap.statusCode, gap.json().error.code, gap.json().error.detail.suggestedLocal]).toEqual([
      422,
      "SOCIAL_SCHEDULE_TIME_GAP",
      spring.replace("02:30", "03:00"),
    ]);
  });

  it("lets a viewer read the calendar and hides it from another project's members (S6)", async () => {
    const range = "from=2026-12-01T00:00:00Z&to=2027-01-01T00:00:00Z";
    const read = await call("viewer", "GET", `/calendar?${range}`);
    expect([read.statusCode, Array.isArray(read.json().items)]).toEqual([200, true]);
    expect((await call("editor", "GET", `/calendar?${range}`, undefined, otherProjectId)).statusCode).toBe(404);
    const tooLong = await call("viewer", "GET", "/calendar?from=2026-12-01T00:00:00Z&to=2027-03-01T00:00:00Z");
    expect([tooLong.statusCode, tooLong.json().error?.code]).toEqual([422, "SOCIAL_RANGE_TOO_LARGE"]);
  });

  it("hides the project from members of another project and unknown posts", async () => {
    expect((await call("editor", "GET", "/posts", undefined, otherProjectId)).statusCode).toBe(404);
    expect((await call("viewer", "GET", `/posts/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call("viewer", "GET", "/posts/not-a-uuid")).statusCode).toBe(404);
  });

  it("answers 404 SOCIAL_DISABLED while the module is off", async () => {
    delete process.env.ORBIT_SOCIAL;
    const response = await call("viewer", "GET", "/posts");
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "SOCIAL_DISABLED"]);
  });
});
