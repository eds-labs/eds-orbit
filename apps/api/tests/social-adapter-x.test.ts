import { afterEach, describe, expect, it } from "vitest";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { resultFromSocialError, senderFor, type SendInput } from "../src/modules/social/adapters/registry.ts";

// Sending to X (ADR 0020, S5) through the SDK adapter with a fake X: the
// adapter's own publish path (no length check, so X Premium posts go out),
// and every answer mapped to "published", "failed" (nothing was posted) or
// "unknown" (maybe posted; never resent).

const scope = { workspaceId: "w", projectId: "p", userId: "worker", role: "owner" } as never;
type Call = { url: string; method: string; body: unknown };
function fakeX(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  setSocialFetchForTests(async (url, init = {}) => {
    const call = { url: String(url), method: String(init.method ?? "GET"), body: init.body };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const input = (over: Partial<SendInput> = {}): SendInput => ({
  publicationId: "pub-1",
  credentials: { platform: "x", accessToken: "x-token", externalId: "42", config: {} },
  account: { externalId: "42", handle: "@orbit_x", settings: {} },
  body: "We are live.",
  options: {},
  media: [],
  providerState: {},
  ...over,
});
const image = (n: number) => ({
  fileId: `f${n}`,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, n]),
  mime: "image/jpeg" as const,
  width: 800,
  height: 600,
  publicUrl: null,
});
const x = senderFor("x")!;

afterEach(() => setSocialFetchForTests(null));

describe("X sender", () => {
  it("publishes a text once and links the post", async () => {
    const calls = fakeX(() => json(201, { data: { id: "111", text: "We are live." } }));
    expect(await x.send(scope, input())).toEqual({
      kind: "published",
      externalPostId: "111",
      permalink: "https://x.com/orbit_x/status/111",
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /2/tweets"]);
  });

  it("uploads images first and sends long texts unchanged", async () => {
    let media = 0;
    const calls = fakeX((call) =>
      call.url.includes("/2/media/upload") ? json(200, { data: { id: `m${++media}` } }) : json(201, { data: { id: "112" } }),
    );
    const long = "a".repeat(600);
    await x.send(scope, input({ body: long, media: [image(1), image(2)], options: { replySettings: "following" } }));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/2/media/upload", "/2/media/upload", "/2/tweets"]);
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ text: long, media: { media_ids: ["m1", "m2"] }, reply_settings: "following" });
  });

  it("waits after a rate limit and asks for a reconnect after a refused token", async () => {
    fakeX(() => json(429, { title: "Too Many Requests" }, { "retry-after": "30" }));
    expect(await x.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 30_000 });
    fakeX(() => json(401, {}));
    expect(await x.send(scope, input())).toMatchObject({ kind: "failed", retry: "after-reconnect" });
    fakeX(() => json(403, {}));
    expect(await x.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_PROVIDER_MISSING_PERMISSION", retry: "never" });
  });

  it("calls an outage after sending unknown, and a failed image upload a failure", async () => {
    fakeX(() => json(503, {}));
    expect(await x.send(scope, input())).toMatchObject({ kind: "unknown" });
    fakeX(() => {
      throw new TypeError("socket hang up");
    });
    expect(await x.send(scope, input())).toMatchObject({ kind: "unknown" });
    const calls = fakeX((call) => (call.url.includes("/2/media/upload") ? json(500, {}) : json(201, { data: { id: "1" } })));
    expect(await x.send(scope, input({ media: [image(1)] }))).toMatchObject({ kind: "failed", retry: "never" });
    expect(calls.some((c) => c.url.endsWith("/2/tweets"))).toBe(false);
  });

  it("finds a post after an unknown outcome by its text, from shortly before the send", async () => {
    const since = new Date("2026-11-03T10:00:00Z");
    fakeX(() =>
      json(200, {
        data: [
          { id: "201", text: "Something else", author_id: "42", created_at: "2026-11-03T10:01:00Z" },
          { id: "202", text: "Read  https://t.co/abc  now", author_id: "42", created_at: "2026-11-03T10:00:30Z" },
          { id: "203", text: "Read https://orbit.example now", author_id: "42", created_at: "2026-11-03T09:40:00Z" },
        ],
      }),
    );
    expect(await x.reconcile!(scope, { ...input({ body: "Read https://orbit.example now" }), since })).toEqual({
      kind: "published",
      externalPostId: "202",
      permalink: "https://x.com/orbit_x/status/202",
    });
    fakeX(() => json(200, { data: [{ id: "203", text: "Read https://orbit.example now", author_id: "42", created_at: "2026-11-03T09:40:00Z" }] }));
    expect(await x.reconcile!(scope, { ...input({ body: "Read https://orbit.example now" }), since })).toEqual({ kind: "not_found" });
  });

  it("maps anything that is not an SDK error to unknown", () => {
    expect(resultFromSocialError(new Error("boom"))).toMatchObject({ kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" });
  });
});
