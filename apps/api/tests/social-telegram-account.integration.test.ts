import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { openSecret } from "../src/platform/connections/secrets.ts";
import { credentialKey, encrypt } from "../src/platform/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { connectTelegramChannel } from "../src/modules/social/accounts/telegram.ts";
import { removeProjectConnections } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// Synthetic tokens in Telegram's shape; nothing here reaches Telegram.
const PUBLISHING_BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";
const OWNER_BOT = "111111111:AAsyntheticOwnerBotTokenForTests_0123456";

/**
 * Telegram publishing channels (ADR 0020, S-D3, S2 Task 9): a separate bot
 * that is an administrator allowed to post in a channel. The owner's
 * private Orbit bot is refused and never touched.
 */
describe.skipIf(!enabled)("connecting Telegram channels", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  const methods: string[] = [];
  let chat: Record<string, unknown>;
  let member: Record<string, unknown>;

  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fakeTelegram = () =>
    setSocialFetchForTests(async (url) => {
      const method = String(url).split("/").pop()!;
      methods.push(method);
      if (method === "getMe") return ok({ id: 2222, is_bot: true, first_name: "Pub", username: "orbit_pub_bot" });
      if (method === "getChat") return ok(chat);
      if (method === "getChatMember") return ok(member);
      return ok(true);
    });

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    // The owner's private bot, stored the way platform/connections/telegram.ts stores it.
    await p.run((tx) =>
      tx.entity.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          kind: "telegram_connections",
          data: { status: "linked", encryptedToken: encrypt(OWNER_BOT, credentialKey()), linkedUserId: p.owner.userId },
        },
      }),
    );
  });
  afterEach(() => {
    setSocialFetchForTests(null);
    methods.length = 0;
  });
  afterAll(async () => {
    await removeProjectConnections(p);
    await p?.cleanup();
    await closeDatabase();
  });

  it("connects a channel whose bot may post and stores the token sealed", async () => {
    chat = { id: -1001234567890, type: "channel", title: "Orbit News", username: "orbit_news" };
    member = { status: "administrator", can_post_messages: true, user: { id: 2222, is_bot: true, first_name: "Pub" } };
    fakeTelegram();
    const { accountId } = await connectTelegramChannel(p.owner, { botToken: PUBLISHING_BOT, chat: "@orbit_news" });
    const account = await p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id: accountId } }));
    expect(account).toMatchObject({
      platform: "telegram",
      externalId: "-1001234567890",
      handle: "@orbit_news",
      displayName: "Orbit News",
      capability: "read_verified",
      status: "active",
    });
    const active = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId: account.connectionId, state: "active" } });
    expect(JSON.parse(openSecret(active))).toEqual({ botToken: PUBLISHING_BOT });
    const connection = await authDb.connection.findUniqueOrThrow({ where: { id: account.connectionId } });
    expect(connection.config).toMatchObject({ chatId: "-1001234567890", botId: "2222", botUsername: "orbit_pub_bot" });
    expect(methods).toEqual(["getMe", "getChat", "getChatMember"]);
  });

  it("refuses the owner's private bot before any request", async () => {
    fakeTelegram();
    await expect(connectTelegramChannel(p.owner, { botToken: OWNER_BOT, chat: "@orbit_news" })).rejects.toMatchObject({
      code: "SOCIAL_TELEGRAM_OWNER_BOT",
      status: 409,
    });
    expect(methods).toEqual([]);
  });

  it("refuses a group", async () => {
    chat = { id: -100777, type: "supergroup", title: "A group" };
    fakeTelegram();
    await expect(connectTelegramChannel(p.owner, { botToken: PUBLISHING_BOT, chat: "-100777" })).rejects.toMatchObject({
      code: "SOCIAL_TELEGRAM_NOT_A_CHANNEL",
    });
  });

  it("refuses a bot without the right to post", async () => {
    chat = { id: -100888, type: "channel", title: "Read only" };
    member = { status: "administrator", can_post_messages: false, user: { id: 2222, is_bot: true, first_name: "Pub" } };
    fakeTelegram();
    await expect(connectTelegramChannel(p.owner, { botToken: PUBLISHING_BOT, chat: "-100888" })).rejects.toMatchObject({
      code: "SOCIAL_TELEGRAM_BOT_CANNOT_POST",
    });
  });

  it("refuses a malformed token or chat before any request", async () => {
    fakeTelegram();
    await expect(connectTelegramChannel(p.owner, { botToken: "not-a-token", chat: "@orbit_news" })).rejects.toMatchObject({
      code: "SOCIAL_TELEGRAM_TOKEN_INVALID",
      status: 400,
    });
    await expect(connectTelegramChannel(p.owner, { botToken: PUBLISHING_BOT, chat: "orbit news" })).rejects.toMatchObject({
      code: "SOCIAL_TELEGRAM_CHAT_INVALID",
      status: 400,
    });
    expect(methods).toEqual([]);
  });

  it("never calls a Telegram update or webhook method and leaves the owner bot untouched", async () => {
    const before = await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "telegram_connections" } }));
    chat = { id: -100999, type: "channel", title: "Another" };
    member = { status: "creator", user: { id: 2222, is_bot: true, first_name: "Pub" } };
    fakeTelegram();
    await connectTelegramChannel(p.owner, { botToken: PUBLISHING_BOT, chat: "-100999" });
    for (const forbidden of ["setWebhook", "deleteWebhook", "getUpdates", "logOut", "close"])
      expect(methods).not.toContain(forbidden);
    const after = await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "telegram_connections" } }));
    expect(after).toEqual(before);
  });
});
