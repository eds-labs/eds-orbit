import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { readMetrics } from "../src/modules/social/analytics/readers.ts";

// The public figures of published posts (ADR 0020, S8), read with the
// account's own token from a fake Graph and X API: one call per Facebook or
// Instagram post, one per 100 X posts. A failed read is null, never thrown.

type Call = { url: URL; auth: string | null };
function fake(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  setSocialFetchForTests(async (url, init = {}) => {
    const call = { url: new URL(String(url)), auth: new Headers(init.headers).get("authorization") };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = (platform: "x" | "facebook" | "instagram" | "telegram") => ({ platform, accessToken: "token" });

afterEach(() => setSocialFetchForTests(null));

describe("metric readers", () => {
  it("reads reactions, comments and shares of Facebook posts", async () => {
    const calls = fake((call) =>
      call.url.pathname.endsWith("/900_1")
        ? json(200, { id: "900_1", shares: { count: 4 }, reactions: { data: [], summary: { total_count: 12 } }, comments: { data: [], summary: { total_count: 3 } } })
        : json(200, { id: "900_2", reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 1 } } }),
    );
    const { values, calls: count } = await readMetrics(credentials("facebook"), ["900_1", "900_2"]);
    expect(values.get("900_1")).toEqual([
      { metric: "reactions", value: 12 },
      { metric: "comments", value: 3 },
      { metric: "shares", value: 4 },
    ]);
    expect(values.get("900_2")).toEqual([
      { metric: "reactions", value: 0 },
      { metric: "comments", value: 1 },
      { metric: "shares", value: 0 },
    ]);
    expect(count).toBe(2);
    expect(calls[0]!.url.pathname).toBe("/v26.0/900_1");
    expect(calls[0]!.url.searchParams.get("fields")).toBe("shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)");
    expect(calls[0]!.auth).toBe("Bearer token");
  });

  it("reads likes and comments of Instagram media", async () => {
    const calls = fake(() => json(200, { id: "17890", like_count: 40, comments_count: 2 }));
    const { values } = await readMetrics(credentials("instagram"), ["17890"]);
    expect(values.get("17890")).toEqual([
      { metric: "likes", value: 40 },
      { metric: "comments", value: 2 },
    ]);
    expect(calls[0]!.url.searchParams.get("fields")).toBe("like_count,comments_count");
  });

  it("reads X posts in batches of 100 and maps their public metrics", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const calls = fake((call) => {
      const asked = call.url.searchParams.get("ids")!.split(",");
      return json(200, {
        data: asked
          .filter((id) => id !== "1001")
          .map((id) => ({ id, public_metrics: { like_count: 5, retweet_count: 1, reply_count: 2, quote_count: 0, impression_count: 300, bookmark_count: 1 } })),
        errors: [{ resource_id: "1001", title: "Not Found Error" }],
      });
    });
    const { values, calls: count } = await readMetrics(credentials("x"), ids);
    expect(count).toBe(2);
    expect(calls.map((c) => c.url.searchParams.get("ids")!.split(",").length)).toEqual([100, 50]);
    expect(calls[0]!.url.pathname).toBe("/2/tweets");
    expect(calls[0]!.url.searchParams.get("tweet.fields")).toBe("public_metrics");
    expect(values.get("1000")).toEqual([
      { metric: "likes", value: 5 },
      { metric: "reposts", value: 1 },
      { metric: "replies", value: 2 },
      { metric: "quotes", value: 0 },
      { metric: "impressions", value: 300 },
      { metric: "bookmarks", value: 1 },
    ]);
    // A deleted post is not read, not zero.
    expect(values.get("1001")).toBeNull();
  });

  it("never throws: an outage or a refusal leaves the post unread", async () => {
    fake((call) => {
      if (call.url.pathname.endsWith("/a")) throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
      if (call.url.pathname.endsWith("/b")) return json(500, {});
      return json(400, { error: { code: 190, message: "expired" } });
    });
    const { values, calls } = await readMetrics(credentials("facebook"), ["a", "b", "c"]);
    expect([values.get("a"), values.get("b"), values.get("c")]).toEqual([null, null, null]);
    expect(calls).toBe(3);
    fake(() => json(429, {}));
    expect((await readMetrics(credentials("x"), ["1"])).values.get("1")).toBeNull();
  });

  it("has nothing to read for Telegram channels", async () => {
    const calls = fake(() => json(200, {}));
    expect(await readMetrics(credentials("telegram"), ["5"])).toEqual({ values: new Map(), calls: 0 });
    expect(calls).toHaveLength(0);
  });
});
