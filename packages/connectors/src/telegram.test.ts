import { describe, expect, it } from "vitest";
import { ConnectorError, createTelegramClient } from "./index.ts";

// Synthetic token in Telegram's shape; nothing here reaches Telegram.
const TOKEN = "123456789:AAsyntheticTokenForTestsOnly_0123456789";
const ok = (result: unknown = true) =>
  new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit };
function recorder(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetch };
}

describe("Telegram bot client", () => {
  it("sends text and photo with inline buttons", async () => {
    const { calls, fetch } = recorder(() => ok({ message_id: 42 }));
    const client = createTelegramClient({ token: TOKEN, fetch });
    const buttons = [
      { text: "Stop", callbackData: "stop:abc" },
      { text: "In Orbit öffnen", url: "https://orbit.example/approvals" },
    ];

    expect(await client.sendMessage(1001, "Vorschau", buttons)).toEqual({
      messageId: 42,
    });
    expect(calls[0]!.url).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      chat_id: 1001,
      text: "Vorschau",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Stop", callback_data: "stop:abc" },
            { text: "In Orbit öffnen", url: "https://orbit.example/approvals" },
          ],
        ],
      },
    });

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(
      await client.sendPhoto(1001, bytes, "Bildunterschrift", buttons),
    ).toEqual({ messageId: 42 });
    expect(calls[1]!.url).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendPhoto`,
    );
    const form = calls[1]!.init.body as FormData;
    expect(form.get("chat_id")).toBe("1001");
    expect(form.get("caption")).toBe("Bildunterschrift");
    const photo = form.get("photo") as Blob;
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(bytes);
    expect(JSON.parse(String(form.get("reply_markup")))).toEqual({
      inline_keyboard: [
        [
          { text: "Stop", callback_data: "stop:abc" },
          { text: "In Orbit öffnen", url: "https://orbit.example/approvals" },
        ],
      ],
    });
    // The token travels only in the fixed URL, never as a header.
    for (const call of calls)
      expect(JSON.stringify(call.init.headers ?? {})).not.toContain(TOKEN);
  });

  it("registers the webhook with its secret and answers callbacks", async () => {
    const { calls, fetch } = recorder(() => ok(true));
    const client = createTelegramClient({ token: TOKEN, fetch });
    await client.setWebhook(
      "https://orbit.example/api/telegram/0b6f2f8e-8f43-4b7d-9a39-1b2c3d4e5f60",
      "secret_value-1",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: "https://orbit.example/api/telegram/0b6f2f8e-8f43-4b7d-9a39-1b2c3d4e5f60",
      secret_token: "secret_value-1",
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await client.answerCallbackQuery("cbq-1", "Gestoppt.");
    expect(calls[1]!.url).toMatch(/\/answerCallbackQuery$/);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      callback_query_id: "cbq-1",
      text: "Gestoppt.",
    });
    await client.deleteWebhook();
    expect(calls[2]!.url).toMatch(/\/deleteWebhook$/);
  });

  it("refuses bad input before any request", async () => {
    const { calls, fetch } = recorder(() => ok());
    expect(() => createTelegramClient({ token: "not-a-token", fetch })).toThrow(
      ConnectorError,
    );
    const client = createTelegramClient({ token: TOKEN, fetch });
    await expect(
      client.sendMessage(1, "x", [
        { text: "Stop", callbackData: "s".repeat(65) },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_TELEGRAM_BUTTON" });
    await expect(client.sendMessage(1, "")).rejects.toMatchObject({
      code: "INVALID_TELEGRAM_MESSAGE",
    });
    await expect(
      client.setWebhook("http://orbit.example/api/telegram/x", "secret"),
    ).rejects.toMatchObject({ code: "INVALID_TELEGRAM_WEBHOOK" });
    await expect(
      client.setWebhook("https://orbit.example/api/telegram/x", "bad secret!"),
    ).rejects.toMatchObject({ code: "INVALID_TELEGRAM_WEBHOOK" });
    expect(calls).toHaveLength(0);
  });

  it("maps Telegram errors to connector errors without the token", async () => {
    const rejected = createTelegramClient({
      token: TOKEN,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          }),
          { status: 401 },
        ),
    });
    const error = await rejected
      .setWebhook("https://o.example/w", "s")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "PROVIDER_AUTH", outcome: "rejected" });
    expect(
      JSON.stringify(error) + String((error as Error).message),
    ).not.toContain(TOKEN);

    const offline = createTelegramClient({
      token: TOKEN,
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${String(url)}`);
      },
    });
    const sent = await offline.sendMessage(1, "Hallo").catch((e: unknown) => e);
    expect(sent).toMatchObject({ code: "NETWORK_ERROR", outcome: "unknown" });
    expect(String((sent as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);

    const hanging = createTelegramClient({
      token: TOKEN,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    });
    await expect(hanging.answerCallbackQuery("q", "x")).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      outcome: "not_sent",
    });
  });

  it("reports Telegram's retry_after on a rate limit", async () => {
    const limited = (body: unknown) =>
      createTelegramClient({
        token: TOKEN,
        fetch: async () =>
          new Response(JSON.stringify(body), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      });
    expect(
      await limited({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 7",
        parameters: { retry_after: 7 },
      })
        .sendMessage(1, "Hallo")
        .catch((e: unknown) => e),
    ).toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterMs: 7000 });
    // Anything else is not trusted as a wait.
    for (const body of [
      { ok: false },
      { ok: false, parameters: { retry_after: "soon" } },
      { ok: false, parameters: { retry_after: -3 } },
    ])
      expect(
        (await limited(body)
          .sendMessage(1, "Hallo")
          .catch((e: unknown) => e)) as {
          retryAfterMs?: number;
        },
      ).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: undefined });
  });
});

describe("Telegram bot client: channel checks for publishing (ADR 0020)", () => {
  it("getMe parses the bot", async () => {
    const { calls, fetch } = recorder(() =>
      ok({ id: 42, is_bot: true, first_name: "Orbit", username: "orbit_pub_bot" }),
    );
    const client = createTelegramClient({ token: TOKEN, fetch });
    expect(await client.getMe()).toEqual({ id: 42, username: "orbit_pub_bot", isBot: true });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("getMe refuses a result that is not a bot", async () => {
    const { fetch } = recorder(() => ok({ id: 7, is_bot: false, first_name: "Ada" }));
    const client = createTelegramClient({ token: TOKEN, fetch });
    await expect(client.getMe()).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("getChat resolves @username to the numeric channel id", async () => {
    const { calls, fetch } = recorder(() =>
      ok({ id: -1001234567890, type: "channel", title: "Orbit News", username: "orbit_news" }),
    );
    const client = createTelegramClient({ token: TOKEN, fetch });
    expect(await client.getChat("@orbit_news")).toEqual({
      id: -1001234567890,
      type: "channel",
      title: "Orbit News",
      username: "orbit_news",
    });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getChat`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: "@orbit_news" });
  });

  it("getChat accepts a numeric id and fills missing names with null", async () => {
    const { calls, fetch } = recorder(() => ok({ id: -1009, type: "channel", title: "Private" }));
    const client = createTelegramClient({ token: TOKEN, fetch });
    expect(await client.getChat(-1009)).toEqual({ id: -1009, type: "channel", title: "Private", username: null });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: -1009 });
  });

  it("getChat refuses malformed usernames before any request", async () => {
    const { calls, fetch } = recorder(() => ok({}));
    const client = createTelegramClient({ token: TOKEN, fetch });
    for (const bad of ["@a", "orbit", "@bad-name", "@1starts_with_digit"])
      await expect(client.getChat(bad as `@${string}`)).rejects.toMatchObject({ code: "INVALID_TELEGRAM_CHAT" });
    expect(calls).toHaveLength(0);
  });

  it("getChatMember reports whether an administrator may post", async () => {
    const replies = [
      ok({ status: "administrator", can_post_messages: true, user: { id: 42, is_bot: true, first_name: "Orbit" } }),
      ok({ status: "member", user: { id: 42, is_bot: true, first_name: "Orbit" } }),
    ];
    const { calls, fetch } = recorder(() => replies.shift()!);
    const client = createTelegramClient({ token: TOKEN, fetch });
    expect(await client.getChatMember(-1001234567890, 42)).toEqual({ status: "administrator", canPostMessages: true });
    expect(await client.getChatMember(-1001234567890, 42)).toEqual({ status: "member", canPostMessages: false });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: -1001234567890, user_id: 42 });
  });

  it("getChatMember lets the channel creator post", async () => {
    const { fetch } = recorder(() => ok({ status: "creator", user: { id: 42, is_bot: true, first_name: "Orbit" } }));
    const client = createTelegramClient({ token: TOKEN, fetch });
    expect(await client.getChatMember(-1001, 42)).toEqual({ status: "creator", canPostMessages: true });
  });

  it("the channel checks never leak the token", async () => {
    const { fetch } = recorder(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`);
    });
    const client = createTelegramClient({ token: TOKEN, fetch });
    for (const run of [() => client.getMe(), () => client.getChat("@orbit_news"), () => client.getChatMember(-1001, 42)]) {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e as Error & { cause?: unknown },
      );
      expect(error).toBeInstanceOf(ConnectorError);
      expect(`${error!.message} ${String(error!.cause ?? "")}`).not.toContain(TOKEN);
    }
  });
});
