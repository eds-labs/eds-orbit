import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { senderFor, type SendInput } from "../src/modules/social/adapters/registry.ts";

// Sending to a Facebook Page (ADR 0020, S5b) with a fake Graph API: images go
// up unpublished, then exactly one /feed call creates the visible post. Only
// that call can publish, so only its unclear answers are "unknown".

const scope = { workspaceId: "w", projectId: "p", userId: "worker", role: "owner" } as never;
type Call = { url: URL; method: string; body: unknown; auth: string | null };
function fakeGraph(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  setSocialFetchForTests(async (url, init = {}) => {
    const call = {
      url: new URL(String(url)),
      method: String(init.method ?? "GET"),
      body: init.body,
      auth: new Headers(init.headers).get("authorization"),
    };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (status: number, code: number, extra: Record<string, unknown> = {}) =>
  json(status, { error: { message: "refused", type: "OAuthException", code, ...extra } });
const input = (over: Partial<SendInput> = {}): SendInput => ({
  publicationId: "pub-1",
  credentials: { platform: "facebook", accessToken: "page-token", externalId: "900", pageId: "900", config: { pageId: "900" } },
  account: { externalId: "900", handle: "Orbit Page", settings: {} },
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
const path = (c: Call) => `${c.method} ${c.url.pathname}`;
const facebook = senderFor("facebook")!;

afterEach(() => setSocialFetchForTests(null));

describe("Facebook sender", () => {
  it("publishes a text with the Page token in one /feed call and links the post", async () => {
    const calls = fakeGraph(() => json(200, { id: "900_1", permalink_url: "https://www.facebook.com/900/posts/1" }));
    expect(await facebook.send(scope, input())).toEqual({
      kind: "published",
      externalPostId: "900_1",
      permalink: "https://www.facebook.com/900/posts/1",
    });
    expect(calls.map(path)).toEqual(["POST /v26.0/900/feed"]);
    expect(calls[0]!.auth).toBe("Bearer page-token");
    expect(calls[0]!.url.searchParams.get("fields")).toBe("id,permalink_url");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ message: "We are live.", published: true });
  });

  it("uploads images unpublished, then attaches them to one post", async () => {
    let photo = 0;
    const calls = fakeGraph((call) => (call.url.pathname.endsWith("/photos") ? json(200, { id: `ph${++photo}` }) : json(200, { id: "900_2" })));
    const result = await facebook.send(scope, input({ media: [image(1), image(2)] }));
    expect(result).toEqual({ kind: "published", externalPostId: "900_2", permalink: "https://www.facebook.com/900_2" });
    expect(calls.map(path)).toEqual(["POST /v26.0/900/photos", "POST /v26.0/900/photos", "POST /v26.0/900/feed"]);
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("published")).toBe("false");
    expect(form.get("source")).toBeInstanceOf(Blob);
    expect((form.get("source") as Blob).type).toBe("image/jpeg");
    expect(JSON.parse(String(calls[2]!.body))).toEqual({
      message: "We are live.",
      attached_media: [{ media_fbid: "ph1" }, { media_fbid: "ph2" }],
      published: true,
    });
  });

  it("asks for a reconnect when the token or the permission is gone", async () => {
    fakeGraph(() => graphError(400, 190));
    expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_META_TOKEN_INVALID", retry: "after-reconnect" });
    fakeGraph(() => graphError(403, 200));
    expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_META_PERMISSION_MISSING", retry: "after-reconnect" });
    fakeGraph(() => graphError(400, 10));
    expect(await facebook.send(scope, input())).toMatchObject({ kind: "failed", retry: "after-reconnect" });
  });

  it("waits after a throttle, and an hour after a temporary block", async () => {
    for (const code of [4, 17, 32, 613, 80001]) {
      fakeGraph(() => graphError(400, code));
      expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 60_000 });
    }
    fakeGraph(() => graphError(400, 368, { error_subcode: 1390008 }));
    expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 3_600_000 });
  });

  it("calls an unclear /feed answer unknown, and never posts twice", async () => {
    fakeGraph(() => json(503, {}));
    expect(await facebook.send(scope, input())).toEqual({ kind: "unknown", code: "SOCIAL_PROVIDER_UNAVAILABLE" });
    fakeGraph(() => graphError(500, 2, { is_transient: true }));
    expect(await facebook.send(scope, input())).toMatchObject({ kind: "unknown" });
    fakeGraph(() => json(200, {}));
    expect(await facebook.send(scope, input())).toMatchObject({ kind: "unknown" });
    fakeGraph(() => {
      throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
    });
    expect(await facebook.send(scope, input())).toEqual({ kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" });
  });

  it("calls an unclear /feed answer unknown after the photos went up, and uploads nothing again", async () => {
    for (const unclear of [
      () => {
        throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
      },
      () => json(503, {}),
    ]) {
      let photo = 0;
      const calls = fakeGraph((call) => (call.url.pathname.endsWith("/photos") ? json(200, { id: `ph${++photo}` }) : unclear()));
      expect(await facebook.send(scope, input({ media: [image(1), image(2)] }))).toMatchObject({ kind: "unknown" });
      expect(calls.map(path)).toEqual(["POST /v26.0/900/photos", "POST /v26.0/900/photos", "POST /v26.0/900/feed"]);
    }
  });

  it("stops before /feed when the uploads took so long that the delivery lease could run out", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let photo = 0;
      const calls = fakeGraph(() => {
        now += 55_000;
        return json(200, { id: `ph${++photo}` });
      });
      expect(await facebook.send(scope, input({ media: [image(1), image(2), image(3)] }))).toEqual({
        kind: "failed",
        code: "SOCIAL_PROVIDER_UNAVAILABLE",
        retry: "after-delay",
        delayMs: 300_000,
      });
      // Two uploads took 110 s: no third upload, and never the visible /feed call.
      expect(calls.map(path)).toEqual(["POST /v26.0/900/photos", "POST /v26.0/900/photos"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("treats a request that never left as a failure that may wait", async () => {
    fakeGraph(() => {
      throw new ConnectorError("DNS_FAILED", "not_sent", true);
    });
    expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_PROVIDER_UNAVAILABLE", retry: "after-delay", delayMs: 300_000 });
  });

  it("treats any failed image upload as a failure: nothing visible exists yet", async () => {
    const calls = fakeGraph(() => {
      throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
    });
    expect(await facebook.send(scope, input({ media: [image(1)] }))).toEqual({
      kind: "failed",
      code: "SOCIAL_PROVIDER_UNAVAILABLE",
      retry: "after-delay",
      delayMs: 300_000,
    });
    expect(calls.map(path)).toEqual(["POST /v26.0/900/photos"]);
    fakeGraph((call) => (call.url.pathname.endsWith("/photos") ? json(503, {}) : json(200, { id: "never" })));
    expect(await facebook.send(scope, input({ media: [image(1)] }))).toMatchObject({ kind: "failed", retry: "after-delay" });
    fakeGraph(() => graphError(400, 324));
    expect(await facebook.send(scope, input({ media: [image(1)] }))).toEqual({ kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" });
  });

  it("calls a /feed answer that is no Graph error unclear, and waits after such an upload answer", async () => {
    for (const status of [404, 408, 302]) {
      fakeGraph(() => new Response("<html>gateway</html>", { status, headers: { "content-type": "text/html" } }));
      expect(await facebook.send(scope, input()), String(status)).toEqual({ kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" });
    }
    fakeGraph(() => new Response("<html>gateway</html>", { status: 404, headers: { "content-type": "text/html" } }));
    expect(await facebook.send(scope, input({ media: [image(1)] }))).toMatchObject({ kind: "failed", retry: "after-delay" });
  });

  it("names uploaded images without Orbit's file ids", async () => {
    let photo = 0;
    const calls = fakeGraph((call) => (call.url.pathname.endsWith("/photos") ? json(200, { id: `ph${++photo}` }) : json(200, { id: "900_9" })));
    await facebook.send(scope, input({ media: [image(1), image(2)] }));
    const names = calls.filter((c) => c.url.pathname.endsWith("/photos")).map((c) => ((c.body as FormData).get("source") as File).name);
    expect(names).toEqual(["image-1.jpg", "image-2.jpg"]);
  });

  it("refuses an invalid post for good", async () => {
    fakeGraph(() => graphError(400, 100));
    expect(await facebook.send(scope, input())).toEqual({ kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" });
  });
});

describe("Facebook read-back", () => {
  const since = new Date("2026-11-03T10:00:00Z");
  const posts = (data: unknown[]) => json(200, { data });

  it("finds the post by its text and time", async () => {
    const calls = fakeGraph(() =>
      posts([
        { id: "900_old", message: "We are live.", created_time: "2026-11-03T09:40:00+0000" },
        { id: "900_other", message: "Something else", created_time: "2026-11-03T10:00:05+0000" },
        { id: "900_3", message: "We  are\nlive.", created_time: "2026-11-03T10:00:04+0000", permalink_url: "https://www.facebook.com/900/posts/3" },
      ]),
    );
    expect(await facebook.reconcile!(scope, { ...input(), since })).toEqual({
      kind: "published",
      externalPostId: "900_3",
      permalink: "https://www.facebook.com/900/posts/3",
    });
    expect(path(calls[0]!)).toBe("GET /v26.0/900/posts");
    expect(calls[0]!.url.searchParams.get("fields")).toBe("id,message,created_time,permalink_url");
  });

  it("finds nothing for another text, an older post or a post without text", async () => {
    fakeGraph(() => posts([{ id: "900_old", message: "We are live.", created_time: "2026-11-03T09:40:00+0000" }]));
    expect(await facebook.reconcile!(scope, { ...input(), since })).toEqual({ kind: "not_found" });
    const calls = fakeGraph(() => posts([{ id: "900_4", created_time: "2026-11-03T10:00:01+0000" }]));
    expect(await facebook.reconcile!(scope, { ...input({ body: "" }), since })).toEqual({ kind: "not_found" });
    expect(calls).toHaveLength(0);
  });
});
