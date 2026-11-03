import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { connectionSecret } from "../src/platform/connections/central.ts";
import { socialAccountHealth } from "../src/modules/social/accounts/health.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { grantSocialApp, X_APP_SECRET } from "./support/social-apps.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";

/**
 * Connected accounts (ADR 0020, S2 Task 10): everybody in the module reads
 * the list (never a token); only owners check and disconnect; the periodic
 * check looks at no more than 20 accounts per run.
 */
describe.skipIf(!enabled)("social accounts", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let owner: Scope;
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const methods: string[] = [];
  let member: Record<string, unknown>;
  let revoke: () => Response;
  let cleanupApp: () => Promise<unknown>;

  const call = (who: keyof typeof ids, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/social${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const telegram = (chatId: string) =>
    saveConnectedAccount(owner, {
      platform: "telegram",
      externalId: chatId,
      handle: `Channel ${chatId}`,
      displayName: `Channel ${chatId}`,
      secret: JSON.stringify({ botToken: BOT }),
      config: { chatId, botId: "2222", botUsername: "orbit_pub_bot" },
    });
  const account = (id: string) => scoped(workspaceId, projectId, (tx) => tx.socialAccount.findUniqueOrThrow({ where: { id } }));

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
        name: "Synthetic social accounts",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social accounts" } })).id;
    owner = { workspaceId, projectId, userId: ids.owner, role: "owner" };
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
    cleanupApp = (await grantSocialApp({ owner } as never, "social.app.x", X_APP_SECRET)).cleanup;
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
    methods.length = 0;
    setSocialFetchForTests(async (url) => {
      const u = String(url);
      methods.push(u.startsWith("https://api.telegram.org/") ? u.split("/").pop()! : u);
      if (u.endsWith("/getChatMember"))
        return new Response(JSON.stringify({ ok: true, result: member }), { status: 200 });
      if (u === "https://api.x.com/2/oauth2/revoke") return revoke();
      return new Response("{}", { status: 404 });
    });
  });
  afterEach(() => {
    delete process.env.ORBIT_SOCIAL;
    setSocialFetchForTests(null);
  });
  afterAll(async () => {
    await authDb.connection.deleteMany({ where: { projectId } });
    await cleanupApp?.();
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lists accounts for every member without any token", async () => {
    const { accountId } = await telegram("-1001");
    const response = await call("viewer", "GET", "/accounts");
    expect(response.statusCode).toBe(200);
    const item = response.json().items.find((i: { id: string }) => i.id === accountId);
    expect(item).toMatchObject({ platform: "telegram", handle: "Channel -1001", status: "active", capability: "read_verified", version: 1 });
    expect(Object.keys(item).sort()).toEqual(
      ["capability", "connectedAt", "displayName", "handle", "id", "lastCheckCode", "lastCheckedAt", "platform", "settings", "status", "version"].sort(),
    );
    expect(item.settings).toEqual({ xLongPosts: false });
    expect(response.body).not.toContain(BOT);
    expect(response.body).not.toMatch(/token|secret|connectionId/i);
  });

  it("lets the owner allow long posts on an X account only", async () => {
    const x = await saveConnectedAccount(owner, {
      platform: "x",
      externalId: randomUUID(),
      handle: "@orbit_x",
      displayName: "Orbit X",
      secret: JSON.stringify({ accessToken: "synthetic", refreshToken: null }),
      config: {},
    });
    const update = { version: 1, settings: { xLongPosts: true } };
    expect((await call("editor", "PATCH", `/accounts/${x.accountId}`, update)).statusCode).toBe(403);
    const saved = await call("owner", "PATCH", `/accounts/${x.accountId}`, update);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id: x.accountId, settings: { xLongPosts: true }, version: 2 });
    const stale = await call("owner", "PATCH", `/accounts/${x.accountId}`, update);
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, "SOCIAL_VERSION_CONFLICT"]);
    const { accountId } = await telegram("-1009");
    const wrong = await call("owner", "PATCH", `/accounts/${accountId}`, update);
    expect([wrong.statusCode, wrong.json().error?.code]).toEqual([422, "SOCIAL_SETTING_INVALID"]);
    const unknown = await call("owner", "PATCH", `/accounts/${randomUUID()}`, update);
    expect(unknown.statusCode).toBe(404);
    const audits = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({ where: { projectId, action: "social.account.settings_changed", resourceId: x.accountId } }),
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ keys: ["xLongPosts"] }]);
    // Out of the periodic health check of the tests below.
    await scoped(workspaceId, projectId, (tx) =>
      tx.socialAccount.update({ where: { id: x.accountId }, data: { status: "disabled" } }),
    );
  });

  it("lets only owners check and disconnect", async () => {
    const { accountId } = await telegram("-1002");
    expect((await call("editor", "POST", `/accounts/${accountId}/check`)).statusCode).toBe(403);
    expect((await call("editor", "POST", `/accounts/${accountId}/disconnect`, { version: 1 })).statusCode).toBe(403);
    expect((await call("viewer", "POST", `/accounts/${accountId}/check`)).statusCode).toBe(403);
  });

  it("checks a Telegram channel and records the result", async () => {
    const { accountId } = await telegram("-1003");
    member = { status: "administrator", can_post_messages: true, user: { id: 2222, is_bot: true, first_name: "Pub" } };
    const ok = await call("owner", "POST", `/accounts/${accountId}/check`);
    expect(ok.json()).toEqual({ ok: true });
    expect(methods).toEqual(["getChatMember"]);
    const row = await account(accountId);
    expect((row.settings as { lastCheckedAt?: string }).lastCheckedAt).toBeTruthy();
    member = { status: "left", user: { id: 2222, is_bot: true, first_name: "Pub" } };
    const lost = await call("owner", "POST", `/accounts/${accountId}/check`);
    expect(lost.json()).toEqual({ ok: false, code: "SOCIAL_TELEGRAM_BOT_CANNOT_POST" });
    expect(await account(accountId)).toMatchObject({ status: "reconnect_required" });
  });

  it("restores an account on an owner's check once its cause is fixed", async () => {
    const { accountId } = await telegram("-1005");
    member = { status: "left", user: { id: 2222, is_bot: true, first_name: "Pub" } };
    await call("owner", "POST", `/accounts/${accountId}/check`);
    expect(await account(accountId)).toMatchObject({ status: "reconnect_required" });
    member = { status: "administrator", can_post_messages: true, user: { id: 2222, is_bot: true, first_name: "Pub" } };
    const restored = await call("owner", "POST", `/accounts/${accountId}/check`);
    expect(restored.json()).toEqual({ ok: true });
    expect(await account(accountId)).toMatchObject({ status: "active" });
  });

  it("disconnects with the current version only, revokes the connection and keeps the account", async () => {
    const { accountId } = await telegram("-1004");
    const stale = await call("owner", "POST", `/accounts/${accountId}/disconnect`, { version: 9 });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, "SOCIAL_VERSION_CONFLICT"]);
    const done = await call("owner", "POST", `/accounts/${accountId}/disconnect`, { version: 1 });
    expect(done.statusCode).toBe(200);
    const row = await account(accountId);
    expect(row).toMatchObject({ status: "disabled" });
    expect(row.disabledAt).not.toBeNull();
    expect(await scoped(workspaceId, projectId, (tx) => connectionSecret(tx, row.connectionId))).toBeNull();
  });

  it("revokes an X token at X on disconnect, best effort", async () => {
    revoke = () => new Response("{}", { status: 500 });
    const { accountId } = await saveConnectedAccount(owner, {
      platform: "x",
      externalId: "4242",
      handle: "@orbit",
      displayName: "Orbit",
      secret: JSON.stringify({ accessToken: "access-x", refreshToken: "refresh-x", expiresAt: null, scopes: [] }),
      config: { userId: "4242" },
    });
    const done = await call("owner", "POST", `/accounts/${accountId}/disconnect`, { version: 1 });
    expect(done.statusCode).toBe(200);
    expect(methods).toContain("https://api.x.com/2/oauth2/revoke");
    expect(await account(accountId)).toMatchObject({ status: "disabled" });
  });

  it("refuses another project's account", async () => {
    const response = await call("owner", "POST", `/accounts/${randomUUID()}/check`);
    expect(response.statusCode).toBe(404);
  });

  it("checks at most 20 accounts per periodic run, the least recently checked first", async () => {
    member = { status: "administrator", can_post_messages: true, user: { id: 2222, is_bot: true, first_name: "Pub" } };
    for (let i = 0; i < 21; i++) await telegram(`-200${i}`);
    methods.length = 0;
    expect(await scoped(workspaceId, projectId, (tx) => socialAccountHealth.nextDueAt!(tx, owner))).not.toBeNull();
    await socialAccountHealth.run(owner);
    expect(methods.filter((m) => m === "getChatMember")).toHaveLength(20);
  });
});
