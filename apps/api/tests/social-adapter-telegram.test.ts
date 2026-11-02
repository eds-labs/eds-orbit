import { afterEach, describe, expect, it } from "vitest";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { senderFor, type SendInput } from "../src/modules/social/adapters/registry.ts";

// Sending to a Telegram channel (ADR 0020, S5) with the account's own
// publishing bot through Orbit's connector; a fake Bot API answers.

const scope = { workspaceId: "w", projectId: "p", userId: "worker", role: "owner" } as never;
const BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";
type Call = { method: string; body: unknown };
function fakeBot(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  setSocialFetchForTests(async (url, init = {}) => {
    const call = { method: String(url).split("/").pop()!, body: init.body };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const input = (over: Partial<SendInput> = {}): SendInput => ({
  publicationId: "pub-1",
  credentials: { platform: "telegram", accessToken: BOT, externalId: "-1001234", config: { chatId: "-1001234" } },
  account: { externalId: "-1001234", handle: "@orbit_news", settings: {} },
  body: "We are live.",
  options: {},
  media: [],
  providerState: {},
  ...over,
});
const photo = (n: number) => ({ fileId: `f${n}`, bytes: new Uint8Array([0xff, 0xd8, 0xff, n]), mime: "image/jpeg" as const, width: 800, height: 600, publicUrl: null });
const tg = senderFor("telegram")!;

afterEach(() => setSocialFetchForTests(null));

describe("Telegram sender", () => {
  it("posts a text once and links it for a public channel", async () => {
    const calls = fakeBot(() => ok({ message_id: 42 }));
    expect(await tg.send(scope, input({ options: { disableLinkPreview: false, silent: true } }))).toEqual({
      kind: "published",
      externalPostId: "42",
      permalink: "https://t.me/orbit_news/42",
      providerState: { messageIds: [42] },
    });
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({
      chat_id: "-1001234",
      link_preview_options: { is_disabled: false },
      disable_notification: true,
    });
  });

  it("sends one photo with its caption, several as an album", async () => {
    let calls = fakeBot(() => ok({ message_id: 43 }));
    expect(await tg.send(scope, input({ media: [photo(1)] }))).toMatchObject({ kind: "published", externalPostId: "43" });
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    calls = fakeBot(() => ok([{ message_id: 51 }, { message_id: 52 }, { message_id: 53 }]));
    expect(await tg.send(scope, input({ media: [photo(1), photo(2), photo(3)] }))).toMatchObject({
      kind: "published",
      externalPostId: "51",
      providerState: { messageIds: [51, 52, 53] },
    });
    expect(calls.map((c) => c.method)).toEqual(["sendMediaGroup"]);
  });

  it("links nothing for a private channel", async () => {
    fakeBot(() => ok({ message_id: 44 }));
    const result = await tg.send(scope, input({ account: { externalId: "-1001234", handle: "Orbit internal", settings: {} } }));
    expect(result).toMatchObject({ kind: "published", permalink: null });
  });

  it("waits after a rate limit, asks for a reconnect when the bot lost the channel, and calls an outage unknown", async () => {
    fakeBot(() => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 5 } }), { status: 429 }));
    expect(await tg.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 5000 });
    fakeBot(() => new Response(JSON.stringify({ ok: false, error_code: 403, description: "bot was kicked" }), { status: 403 }));
    expect(await tg.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED", retry: "after-reconnect" });
    fakeBot(() => new Response("bad gateway", { status: 502 }));
    expect(await tg.send(scope, input())).toMatchObject({ kind: "unknown" });
    fakeBot(() => new Response(JSON.stringify({ ok: false, error_code: 400, description: "message is too long" }), { status: 400 }));
    expect(await tg.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" });
  });

  it("cannot read a channel back", () => {
    expect(tg.reconcile).toBeUndefined();
  });
});
