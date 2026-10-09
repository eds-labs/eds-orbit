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
});
