import { randomBytes, randomUUID } from "node:crypto";
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
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import {
  linkedTelegramConnection,
  stopCallbackData,
} from "../src/modules/telegram.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Synthetic token in Telegram's shape; the fake transport below is the only "Telegram".
const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0123456";
const OWNER_CHAT = 1001;
const FOREIGN_CHAT = 2002;
const ORIGIN = "https://orbit.example";

type TelegramCall = { method: string; body: Record<string, any> };

describe.skipIf(!enabled)("Orbit Telegram bot", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;
  let projectId: string;
  let owner: Scope;
  let ownerCookie: string;
  let editorCookie: string;
  const users: string[] = [];
  const calls: TelegramCall[] = [];
  let previousOrigin: string | undefined;
  let updateId = 1;

  /** Stands in for api.telegram.org: records every call and answers ok. */
  const telegramFetch = async (url: string | URL, init: RequestInit = {}) => {
    const method = String(url).split("/").pop()!;
    const body =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    return new Response(
      JSON.stringify({
        ok: true,
        result: method.startsWith("send") ? { message_id: calls.length } : true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(workspaceId, projectId, fn);
  const rows = (kind: string) => run((tx) => list(tx, owner, kind));
  const audits = (action: string) =>
    run((tx) => tx.auditEvent.findMany({ where: { projectId, action } }));
  const sent = (method: string) => calls.filter((c) => c.method === method);

  const connect = async (cookie = ownerCookie) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/telegram/connect`,
      headers: { origin: ORIGIN, cookie },
      payload: { token: TOKEN },
    });
    const hook = sent("setWebhook").at(-1);
    return {
      response: r,
      body: r.json() as { linkCode: string; expiresAt: string },
      secret: hook?.body.secret_token as string,
      connectionId: String(hook?.body.url).split("/").pop()!,
    };
  };
  const post = (
    connectionId: string,
    secret: string | undefined,
    payload: unknown,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/telegram/${connectionId}`,
      headers: {
        "content-type": "application/json",
        ...(secret === undefined
          ? {}
          : { "x-telegram-bot-api-secret-token": secret }),
      },
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  const message = (text: string, chat = OWNER_CHAT) => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: "private" },
      from: { id: chat, is_bot: false, first_name: "Synthetic" },
      text,
    },
  });
  const click = (callbackData: string, chat = OWNER_CHAT) => ({
    update_id: updateId++,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: chat, is_bot: false, first_name: "Synthetic" },
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chat, type: "private" },
      },
      chat_instance: "synthetic",
      data: callbackData,
    },
  });
  /** A connected bot whose chat is bound by `/start <code>`. */
  const linked = async () => {
    const c = await connect();
    expect(c.response.statusCode).toBe(200);
    const r = await post(
      c.connectionId,
      c.secret,
      message(`/start ${c.body.linkCode}`),
    );
    expect(r.statusCode).toBe(200);
    return c;
  };
  /** An assignment post with a veto window, as scheduleApproved creates it. */
  const publication = (status = "intent_created", extra = {}) =>
    run((tx) =>
      create(tx, owner, "publications", {
        status,
        contentId: randomUUID(),
        channel: "synthetic-x",
        scheduledAt: new Date(Date.now() + 4 * 3600000).toISOString(),
        vetoDeadline: new Date(Date.now() + 3600000).toISOString(),
        ...extra,
      }),
    );
  const lastAnswer = () => sent("answerCallbackQuery").at(-1)?.body.text;
  const paused = async () =>
    (await authDb.project.findUniqueOrThrow({ where: { id: projectId } }))
      .paused;

  beforeAll(async () => {
    previousOrigin = process.env.APP_ORIGIN;
    // Telegram only accepts https webhooks.
    process.env.APP_ORIGIN = ORIGIN;
    process.env.ORBIT_AGENTS = "true";
    app = await buildServer(undefined, { telegramFetch });
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const signUp = async (name: string) => {
      const r = await auth.api.signUpEmail({
        body: { email: randomUUID() + "@example.invalid", name, password },
      });
      users.push(r.user.id);
      return r.user;
    };
    const ownerUser = await signUp("Synthetic bot owner");
    const editorUser = await signUp("Synthetic bot editor");
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic Telegram bot",
          members: {
            create: [
              { userId: ownerUser.id, role: "owner" },
              { userId: editorUser.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    const signIn = async (email: string) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: ORIGIN },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const cookies = r.headers["set-cookie"];
      return (Array.isArray(cookies) ? cookies : [cookies])
        .map((c) => c!.split(";")[0])
        .join("; ");
    };
    ownerCookie = await signIn(ownerUser.email);
    editorCookie = await signIn(editorUser.email);
    owner = {
      workspaceId,
      projectId: "",
      userId: ownerUser.id,
      role: "owner",
    };
    (owner as any).editorId = editorUser.id;
  });
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    calls.length = 0;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic bot project",
          members: {
            create: { userId: (owner as any).editorId, role: "editor" },
          },
        },
      })
    ).id;
    owner = { ...owner, projectId };
  });
  afterEach(async () => {
    await authDb.project.delete({ where: { id: projectId } });
  });
  afterAll(async () => {
    process.env.APP_ORIGIN = previousOrigin;
    delete process.env.ORBIT_AGENTS;
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("links the chat with a valid code only once and within 10 minutes", async () => {
    // Only the owner connects the bot.
    const denied = await connect(editorCookie);
    expect(denied.response.statusCode).toBe(403);
    expect(sent("setWebhook")).toHaveLength(0);

    const before = Date.now();
    const c = await connect();
    expect(c.response.statusCode).toBe(200);
    expect(Object.keys(c.body).sort()).toEqual(["expiresAt", "linkCode"]);
    const ttl = Date.parse(c.body.expiresAt) - before;
    expect(ttl).toBeGreaterThan(9.9 * 60000);
    expect(ttl).toBeLessThanOrEqual(10 * 60000 + 5000);
    expect(sent("setWebhook")[0]!.body.url).toBe(
      `${ORIGIN}/api/telegram/${c.connectionId}`,
    );

    // A wrong code links nothing.
    await post(c.connectionId, c.secret, message("/start WRONGCODE123"));
    expect(await run((tx) => linkedTelegramConnection(tx, owner))).toBeNull();
    expect(sent("sendMessage").at(-1)!.body.text).toMatch(/ungültig/i);

    // An expired code links nothing either.
    await run(async (tx) => {
      const row = await entity(
        tx,
        owner,
        "telegram_connections",
        c.connectionId,
      );
      await update(tx, owner, row, {
        ...data(row),
        linkCodeExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
    });
    await post(c.connectionId, c.secret, message(`/start ${c.body.linkCode}`));
    expect(await run((tx) => linkedTelegramConnection(tx, owner))).toBeNull();

    // A fresh connection replaces the first one; its code links within the window.
    const fresh = await connect();
    expect(fresh.connectionId).not.toBe(c.connectionId);
    const start = await post(
      fresh.connectionId,
      fresh.secret,
      message(`/start ${fresh.body.linkCode}`),
    );
    expect(start.statusCode).toBe(200);
    const connection = await run((tx) => linkedTelegramConnection(tx, owner));
    expect(connection!.id).toBe(fresh.connectionId);
    expect(data(connection)).toMatchObject({
      status: "linked",
      chatId: String(OWNER_CHAT),
      linkedUserId: owner.userId,
      linkCodeHash: null,
      linkCodeExpiresAt: null,
    });
    expect(Date.parse(data(connection).linkedAt)).toBeGreaterThanOrEqual(
      before,
    );
    expect(sent("sendMessage").at(-1)!.body.chat_id).toBe(String(OWNER_CHAT));
    // At most one active connection per project.
    const all = await rows("telegram_connections");
    expect(all.filter((row) => data(row).status !== "disabled")).toHaveLength(
      1,
    );
    expect(data(all.find((row) => row.id === c.connectionId))).toMatchObject({
      status: "disabled",
    });

    const status = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/telegram`,
      headers: { cookie: ownerCookie },
    });
    expect(status.json()).toEqual({
      status: "linked",
      linkedAt: data(connection).linkedAt,
    });
    const editorStatus = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/telegram`,
      headers: { cookie: editorCookie },
    });
    expect(editorStatus.statusCode).toBe(403);
    expect(
      await audits("telegram.linked").then((events) => events.length),
    ).toBe(1);
  });

  it("does not accept a link code twice", async () => {
    const c = await linked();
    const first = await run((tx) => linkedTelegramConnection(tx, owner));
    // The same code again, from the bound chat and from another chat.
    await post(c.connectionId, c.secret, message(`/start ${c.body.linkCode}`));
    await post(
      c.connectionId,
      c.secret,
      message(`/start ${c.body.linkCode}`, FOREIGN_CHAT),
    );
    const after = await run((tx) => linkedTelegramConnection(tx, owner));
    expect(after!.version).toBe(first!.version);
    expect(data(after).chatId).toBe(String(OWNER_CHAT));
    expect(data(after).linkedAt).toBe(data(first).linkedAt);
    expect(
      sent("sendMessage").every(
        (call) => call.body.chat_id !== String(FOREIGN_CHAT),
      ),
    ).toBe(true);
  });

  it("ignores updates with a wrong secret", async () => {
    const c = await connect();
    const before = calls.length;
    const wrong = await post(
      c.connectionId,
      "wrong-secret",
      message(`/start ${c.body.linkCode}`),
    );
    expect(wrong.statusCode).toBe(401);
    const missing = await post(
      c.connectionId,
      undefined,
      message(`/start ${c.body.linkCode}`),
    );
    expect(missing.statusCode).toBe(401);
    // An unknown connection gets the same answer and reveals nothing.
    const unknown = await post(randomUUID(), c.secret, message("/pause"));
    expect(unknown.statusCode).toBe(401);
    expect(calls.length).toBe(before);
    expect(await run((tx) => linkedTelegramConnection(tx, owner))).toBeNull();
    const rejected = await audits("telegram.webhook_rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.resourceId).toBe(c.connectionId);
    expect(JSON.stringify(rejected)).not.toContain("wrong-secret");

    // Malformed bodies never fail the webhook.
    for (const body of ["{not json", JSON.stringify({ nothing: true }), "[]"]) {
      const r = await post(c.connectionId, c.secret, body);
      expect(r.statusCode).toBeLessThan(500);
    }
    expect(calls.length).toBe(before);
  });

  it("ignores a foreign chat", async () => {
    const c = await linked();
    const pub = await publication();
    const before = calls.length;
    for (const update of [
      message("/pause", FOREIGN_CHAT),
      click(stopCallbackData(pub.id, pub.version), FOREIGN_CHAT),
    ]) {
      const r = await post(c.connectionId, c.secret, update);
      expect(r.statusCode).toBe(200);
    }
    expect(calls.length).toBe(before);
    const [row] = await rows("publications");
    expect(data(row).status).toBe("intent_created");
    expect(await paused()).toBe(false);
    expect(await audits("telegram.foreign_chat_ignored")).toHaveLength(2);
  });

  it("stops the shown post on Stop, idempotently", async () => {
    const c = await linked();
    const pub = await publication();
    const token = stopCallbackData(pub.id, pub.version);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);

    // A forged token stops nothing.
    const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    await post(c.connectionId, c.secret, click(forged));
    expect(data((await rows("publications"))[0]).status).toBe("intent_created");
    expect(lastAnswer()).toMatch(/ungültig/i);

    await post(c.connectionId, c.secret, click(token));
    const [stopped] = await rows("publications");
    expect(data(stopped)).toMatchObject({
      status: "canceled",
      reason: "VETOED",
      vetoSource: "telegram",
      vetoedBy: owner.userId,
    });
    expect(lastAnswer()).toMatch(/gestoppt/i);

    // A second click changes nothing and gives the same answer.
    await post(c.connectionId, c.secret, click(token));
    const [again] = await rows("publications");
    expect(again!.version).toBe(stopped!.version);
    expect(lastAnswer()).toMatch(/gestoppt/i);
    expect(await audits("publication.vetoed")).toHaveLength(1);
  });

  it("answers honestly when the post was already handed over", async () => {
    const c = await linked();
    const pub = await publication("scheduled_remote", {
      remoteId: "synthetic-remote",
      handoffAt: new Date().toISOString(),
    });
    await post(
      c.connectionId,
      c.secret,
      click(stopCallbackData(pub.id, pub.version)),
    );
    expect(lastAnswer()).toMatch(/Postiz/);
    const [row] = await rows("publications");
    expect(data(row).status).toBe("scheduled_remote");
    expect(row!.version).toBe(pub.version);
  });

  it("pauses the project only after confirmation", async () => {
    const c = await linked();
    await post(c.connectionId, c.secret, message("/pause"));
    expect(await paused()).toBe(false);
    const confirm = sent("sendMessage").at(-1)!;
    expect(confirm.body.chat_id).toBe(String(OWNER_CHAT));
    const button = confirm.body.reply_markup.inline_keyboard[0][0];
    expect(button.callback_data).toMatch(/^pause:/);
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);

    // A tampered confirmation pauses nothing.
    const tampered =
      button.callback_data.slice(0, -1) +
      (button.callback_data.endsWith("A") ? "B" : "A");
    await post(c.connectionId, c.secret, click(tampered));
    expect(await paused()).toBe(false);

    await post(c.connectionId, c.secret, click(button.callback_data));
    expect(await paused()).toBe(true);
    expect(lastAnswer()).toMatch(/pausiert/i);
    // Repeated clicks are idempotent.
    await post(c.connectionId, c.secret, click(button.callback_data));
    expect(await paused()).toBe(true);
    expect(await audits("project.pause")).toHaveLength(1);
    expect(lastAnswer()).toMatch(/pausiert/i);
  });

  it("never returns the token", async () => {
    const c = await linked();
    const responses = [
      c.response.body,
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/telegram`,
          headers: { cookie: ownerCookie },
        })
      ).body,
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/export`,
          headers: { cookie: ownerCookie },
        })
      ).body,
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/dashboard`,
          headers: { cookie: ownerCookie },
        })
      ).body,
    ];
    const generic = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/telegram_connections`,
      headers: { cookie: ownerCookie },
    });
    expect(generic.statusCode).toBe(400);
    // Nor can a generic write forge a linked connection.
    const forged = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/telegram_connections`,
      headers: { origin: ORIGIN, cookie: ownerCookie },
      payload: { status: "linked", linkedAt: new Date().toISOString() },
    });
    expect(forged.statusCode).toBe(403);
    responses.push(generic.body);
    const [row] = await rows("telegram_connections");
    for (const body of responses) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(c.secret);
      expect(body).not.toContain(data(row).encryptedToken);
      expect(body).not.toContain(data(row).webhookSecretHash);
    }
    // Stored encrypted, only the secret's hash, no plain link code.
    const stored = JSON.stringify(
      await run((tx) =>
        tx.entityVersion.findMany({ where: { entityId: row!.id } }),
      ),
    );
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(c.secret);
    expect(stored).not.toContain(c.body.linkCode);
    const events = JSON.stringify(
      await run((tx) => tx.auditEvent.findMany({ where: { projectId } })),
    );
    expect(events).not.toContain(TOKEN);
    expect(events).not.toContain(c.secret);
    expect(events).not.toContain(c.body.linkCode);

    // Disconnect is owner-only and leaves no active connection.
    const editor = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/telegram/disconnect`,
      headers: { origin: ORIGIN, cookie: editorCookie },
    });
    expect(editor.statusCode).toBe(403);
    const off = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/telegram/disconnect`,
      headers: { origin: ORIGIN, cookie: ownerCookie },
    });
    expect(off.statusCode).toBe(200);
    expect(off.body).not.toContain(TOKEN);
    expect(await run((tx) => linkedTelegramConnection(tx, owner))).toBeNull();
    expect(sent("deleteWebhook")).toHaveLength(1);
    // A disabled connection acts on nothing.
    await post(c.connectionId, c.secret, message("/pause"));
    expect(sent("sendMessage").at(-1)!.body.text).not.toMatch(/pausieren\?/i);
  });

  it("answers 404 on every bot route while Orbit Agents is off", async () => {
    const c = await linked();
    process.env.ORBIT_AGENTS = "false";
    const before = calls.length;
    const routes = [
      { method: "GET" as const, url: `/api/projects/${projectId}/telegram` },
      {
        method: "POST" as const,
        url: `/api/projects/${projectId}/telegram/connect`,
        payload: { token: TOKEN },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${projectId}/telegram/disconnect`,
      },
    ];
    for (const route of routes) {
      const r = await app.inject({
        ...route,
        headers: { origin: ORIGIN, cookie: ownerCookie },
      });
      expect(r.statusCode).toBe(404);
    }
    const hook = await post(c.connectionId, c.secret, message("/pause"));
    expect(hook.statusCode).toBe(404);
    expect(calls.length).toBe(before);
    expect(
      await run((tx) => linkedTelegramConnection(tx, owner)),
    ).not.toBeNull();
  });
});
