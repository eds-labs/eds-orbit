import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { setConnectHandlerForTests, type ConnectHandler } from "../src/modules/social/accounts/connect.ts";
import { beginOAuthState } from "../src/modules/social/accounts/oauth-state.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Connecting accounts over OAuth (ADR 0020, S2 Task 5): only owners start
 * a connection; the callback needs the same signed-in owner, uses the state
 * once and answers with a redirect back into the module.
 */
describe.skipIf(!enabled)("social OAuth routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const finished: Array<{ state: string; callbackUrl: string; codeVerifier: string }> = [];
  const stub: ConnectHandler = {
    async begin(tx, scope) {
      const started = await beginOAuthState(tx, scope, {
        platform: "x",
        appConnectionId: randomUUID(),
        redirectAfter: `/p/${scope.projectId}/social/accounts`,
      });
      return { authorizeUrl: `https://x.example/authorize?state=${encodeURIComponent(started.state)}` };
    },
    async finish(_scope, input) {
      finished.push({ state: input.state, callbackUrl: input.callbackUrl, codeVerifier: input.attempt.codeVerifier });
      return { accounts: 1 };
    },
  };
  const request = (who: keyof typeof ids | null, method: "GET" | "POST", url: string) =>
    app.inject({
      method,
      url,
      headers: { origin, ...(who ? { cookie: cookies[who] } : {}), [CLIENT_IP_HEADER]: ip() },
    });
  const start = async (who: keyof typeof ids = "owner") => {
    const response = await request(who, "POST", `/api/projects/${projectId}/social/accounts/connect/x`);
    return { response, state: response.statusCode === 200 ? new URL(response.json().authorizeUrl).searchParams.get("state")! : "" };
  };
  const callback = (who: keyof typeof ids | null, query: string) =>
    request(who, "GET", `/api/social/oauth/callback/x?${query}`);

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
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
        name: "Synthetic social OAuth",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social OAuth" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
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
    setConnectHandlerForTests("x", stub);
  });
  afterEach(() => {
    delete process.env.ORBIT_SOCIAL;
    setConnectHandlerForTests("x", null);
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets only the owner start a connection", async () => {
    expect((await start("editor")).response.statusCode).toBe(403);
    expect((await start("viewer")).response.statusCode).toBe(403);
    const { response, state } = await start("owner");
    expect(response.statusCode).toBe(200);
    expect(state.startsWith(`${projectId}.`)).toBe(true);
  });

  it("tells only the owner which developer apps are ready", async () => {
    const url = `/api/projects/${projectId}/social/accounts/apps`;
    expect((await request("editor", "GET", url)).statusCode).toBe(403);
    expect((await request("viewer", "GET", url)).statusCode).toBe(403);
    const response = await request("owner", "GET", url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ x: "not_granted", meta: "not_granted" });
  });

  it("refuses an unknown app", async () => {
    const response = await request("owner", "POST", `/api/projects/${projectId}/social/accounts/connect/myspace`);
    expect(response.statusCode).toBe(400);
  });

  it("finishes the owner's own flow once and redirects back into the module", async () => {
    const { state } = await start();
    const done = await callback("owner", `code=abc&state=${encodeURIComponent(state)}`);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe(`/p/${projectId}/social/accounts?connected=1`);
    const last = finished.at(-1)!;
    expect(last.state).toBe(state);
    expect(last.callbackUrl).toBe(
      `${new URL(origin).origin}/api/social/oauth/callback/x?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(last.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await callback("owner", `code=abc&state=${encodeURIComponent(state)}`);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe(`/p/${projectId}/social/accounts?error=SOCIAL_OAUTH_STATE_INVALID`);
  });

  it("needs a session and the owner role for the callback", async () => {
    const { state } = await start();
    expect((await callback(null, `code=abc&state=${encodeURIComponent(state)}`)).statusCode).toBe(401);
    expect((await callback("editor", `code=abc&state=${encodeURIComponent(state)}`)).statusCode).toBe(403);
  });

  it("consumes the state when the user cancels", async () => {
    const { state } = await start();
    const cancelled = await callback("owner", `error=access_denied&error_reason=user_denied&state=${encodeURIComponent(state)}`);
    expect(cancelled.headers.location).toBe(`/p/${projectId}/social/accounts?error=SOCIAL_OAUTH_CANCELLED`);
    const after = await callback("owner", `code=abc&state=${encodeURIComponent(state)}`);
    expect(after.headers.location).toBe(`/p/${projectId}/social/accounts?error=SOCIAL_OAUTH_STATE_INVALID`);
  });

  it("redirects a failing finish with its error code only", async () => {
    setConnectHandlerForTests("x", {
      ...stub,
      async finish() {
        throw Object.assign(new Error("token endpoint said secret-detail"), { code: "SOCIAL_PROVIDER_REJECTED" });
      },
    });
    const { state } = await start();
    const failed = await callback("owner", `code=abc&state=${encodeURIComponent(state)}`);
    expect(failed.headers.location).toBe(`/p/${projectId}/social/accounts?error=SOCIAL_PROVIDER_REJECTED`);
    expect(failed.body).not.toContain("secret-detail");
  });

  it("answers 404 SOCIAL_DISABLED while ORBIT_SOCIAL is off", async () => {
    const { state } = await start();
    delete process.env.ORBIT_SOCIAL;
    const response = await callback("owner", `code=abc&state=${encodeURIComponent(state)}`);
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "SOCIAL_DISABLED"]);
  });

  it("refuses a malformed state before touching the project", async () => {
    const response = await callback("owner", "code=abc&state=not-a-state");
    expect(response.statusCode).toBe(400);
  });
});
