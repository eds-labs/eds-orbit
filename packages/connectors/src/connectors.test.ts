import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createPostizClient,
  normalizePostizBaseUrl,
  createMatomoClient,
  verifySlackInteraction,
  verifySlackRequest,
  importAdsCsv,
  exportBlogArticle,
  endpoint,
  boundedFetch,
} from "./index.ts";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const options = {
  baseUrl: "https://postiz.example/api/public/v1",
  token: "synthetic-test-token",
};
const input = {
  type: "draft" as const,
  date: "2027-01-02T09:00:00Z",
  posts: [
    {
      integration: { id: "channel-one" },
      value: [{ content: "A sourced draft.", image: [] }],
      settings: { __type: "bluesky" },
    },
  ],
};

describe("Postiz documented contract", () => {
  it("reads integrations and drops unneeded upstream attributes", async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json([
        {
          id: "channel-one",
          name: "Sample",
          identifier: "bluesky",
          disabled: false,
          credential: "must-not-return",
        },
      ]),
    );
    const result = await createPostizClient({
      ...options,
      fetch,
    }).listIntegrations();
    expect(result).toEqual([
      {
        id: "channel-one",
        name: "Sample",
        identifier: "bluesky",
        disabled: false,
      },
    ]);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://postiz.example/api/public/v1/integrations",
    );
  });
  it("uses the exact Postiz integrations route without a trailing slash", async () => {
    const fetch = vi.fn(async (url: string | URL) =>
      new URL(url).pathname.endsWith("/integrations")
        ? json([])
        : json({ message: "Not Found" }, 404),
    );
    await expect(
      createPostizClient({ ...options, fetch }).healthcheck(),
    ).resolves.toMatchObject({ status: "read_verified" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://postiz.example/api/public/v1/integrations",
    );
  });
  it("normalizes host and legacy prefixes to one canonical API URL", () => {
    expect(normalizePostizBaseUrl("https://postiz.example")).toBe(
      "https://postiz.example/api/public/v1",
    );
    expect(normalizePostizBaseUrl("https://postiz.example/public/v1")).toBe(
      "https://postiz.example/api/public/v1",
    );
    expect(
      normalizePostizBaseUrl("https://postiz.example/api/public/v1/public/v1"),
    ).toBe("https://postiz.example/api/public/v1");
  });
  it("reads groups, provider settings, and normalized analytics", async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/groups"))
        return json([{ id: "group-one", name: "Company" }]);
      if (path.includes("/integration-settings/"))
        return json({
          output: {
            rules: "Attach media",
            maxLength: 2200,
            settings: { type: "object" },
            tools: [],
          },
        });
      return json([
        {
          label: "Impressions",
          data: [{ total: "12", date: "2026-09-19" }],
          percentageChange: 2,
        },
      ]);
    });
    const client = createPostizClient({ ...options, fetch });
    expect(await client.listGroups()).toEqual([
      { id: "group-one", name: "Company" },
    ]);
    expect(await client.getIntegrationSettings("channel-one")).toMatchObject({
      maxLength: 2200,
    });
    expect(await client.getIntegrationAnalytics("channel-one")).toMatchObject([
      { label: "Impressions" },
    ]);
    expect(await client.getPostAnalytics("post-one")).toMatchObject([
      { label: "Impressions" },
    ]);
  });
  it("serializes provider tools, status, settings, and release-id reconciliation", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes("/integration-trigger/")) return json({ items: [] });
      if (path.endsWith("/status"))
        return json({ id: "post-one", state: "DRAFT" });
      if (path.endsWith("/settings"))
        return json({ id: "post-one", settings: { title: "Updated" } });
      if (path.endsWith("/missing"))
        return json([
          { id: "release-one", url: "https://cdn.example/preview.jpg" },
        ]);
      if (path.endsWith("/release-id"))
        return json({ id: "post-one", releaseId: "release-one" });
      throw new Error(`unexpected ${path} ${init?.method}`);
    });
    const client = createPostizClient({ ...options, fetch });
    await client.triggerIntegrationTool("channel-one", {
      methodName: "audioSearch",
      data: { q: "test" },
    });
    expect(await client.changePostStatus("post-one", "draft")).toMatchObject({
      state: "DRAFT",
    });
    await client.updatePostSettings("post-one", { title: "Updated" });
    expect(await client.getMissingPostContent("post-one")).toHaveLength(1);
    expect(
      await client.connectMissingReleaseId("post-one", "release-one"),
    ).toMatchObject({ releaseId: "release-one" });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it.each(["draft", "schedule", "now"] as const)(
    "encodes %s in one request and treats receipt as accepted only",
    async (type) => {
      const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).type).toBe(type);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          options.token,
        );
        return json([{ postId: "post-one", integration: "channel-one" }]);
      });
      const result = await createPostizClient({ ...options, fetch }).createPost(
        { ...input, type },
      );
      expect(result.state).toBe("accepted");
      expect(result.remotePosts[0]?.postId).toBe("post-one");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("holds timeout and 5xx writes unknown without retry or secret propagation", async () => {
    const timeout = vi.fn(async () => {
      throw new Error("secret URL/token must not escape");
    });
    await expect(
      createPostizClient({ ...options, fetch: timeout }).createPost(input),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      outcome: "unknown",
      retryable: false,
    });
    expect(timeout).toHaveBeenCalledTimes(1);
    await expect(
      createPostizClient({
        ...options,
        fetch: async () => json({ error: "provider secret" }, 500),
      }).createPost(input),
    ).rejects.toMatchObject({ outcome: "unknown", status: 500 });
  });
  it("does not lose an accepted write on malformed receipt", async () => {
    await expect(
      createPostizClient({
        ...options,
        fetch: async () => json({ success: true }),
      }).createPost(input),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      outcome: "unknown",
    });
  });
  it("rejects invalid integration IDs before sending", async () => {
    const fetch = vi.fn();
    await expect(
      createPostizClient({ ...options, fetch }).createPost({
        ...input,
        posts: [{ ...input.posts[0]!, integration: { id: "../secrets" } }],
      }),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("handles read range and absent persisted ID without claiming canceled", async () => {
    const client = createPostizClient({
      ...options,
      fetch: async () =>
        json({
          posts: [
            {
              id: "p1",
              state: "QUEUE",
              publishDate: input.date,
              integration: { id: "channel-one" },
              releaseURL: null,
            },
          ],
        }),
    });
    expect(
      await client.findPostStatus("missing", {
        startDate: "2027-01-01T00:00:00Z",
        endDate: "2027-01-03T00:00:00Z",
      }),
    ).toEqual({ found: false, state: "outcome_unknown" });
  });
  it("requires group-wide delete acknowledgement", async () => {
    const fetch = vi.fn(async () => json({ id: "post-one" }));
    const client = createPostizClient({ ...options, fetch });
    await expect(
      client.deletePost("post-one", { allowGroupDelete: false } as never),
    ).rejects.toMatchObject({ code: "GROUP_DELETE_ACK_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await client.deletePost("post-one", { allowGroupDelete: true }),
    ).toMatchObject({ scope: "whole_group" });
  });
  it("uploads verified binary with multipart, refusing SVG and spoofed PNG", async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return json({ id: "media-one", path: "https://cdn.example/image.png" });
    });
    const client = createPostizClient({ ...options, fetch });
    await expect(
      client.uploadMedia({
        bytes: Buffer.from("<svg/>"),
        mime: "image/png",
        filename: "x.png",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_TYPE_MISMATCH" });
    expect(
      await client.uploadMedia({
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=",
          "base64",
        ),
        mime: "image/png",
        filename: "x.png",
      }),
    ).toMatchObject({ id: "media-one" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Matomo read scope", () => {
  it("keeps token in body, fixed methods, exact date and site timezone; missing goals stay missing", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).not.toContain("token");
      const b = new URLSearchParams(String(init?.body));
      expect(b.get("method")).toBe("Goals.getGoals");
      expect(b.get("token_auth")).toBe("synthetic-test-token");
      return json([]);
    });
    const result = await createMatomoClient({
      ...options,
      baseUrl: "https://matomo.example",
      allowedSiteIds: [3],
      fetch,
    }).report({
      siteId: 3,
      method: "Goals.getGoals",
      period: "day",
      date: "2026-09-17",
      siteTimezone: "Europe/Berlin",
    });
    expect(result.goalsConfigured).toBe(false);
    expect(result.siteTimezone).toBe("Europe/Berlin");
  });
  it("blocks other sites and write methods without network", async () => {
    const fetch = vi.fn();
    const client = createMatomoClient({
      ...options,
      allowedSiteIds: [3],
      fetch,
    });
    await expect(
      client.report({
        siteId: 4,
        method: "VisitsSummary.get",
        period: "day",
        date: "2026-09-17",
        siteTimezone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "SITE_NOT_ALLOWED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not turn HTTP200 API errors into zero-valued metrics", async () => {
    const client = createMatomoClient({
      ...options,
      allowedSiteIds: [3],
      fetch: async () => json({ result: "error", message: "private details" }),
    });
    await expect(
      client.report({
        siteId: 3,
        method: "Goals.get",
        period: "day",
        date: "2026-09-17",
        siteTimezone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "REPORT_UNAVAILABLE" });
  });
});

const slackPayload = {
  type: "block_actions",
  team: { id: "TEAM1" },
  user: { id: "USER1" },
  actions: [{ action_id: "approve", value: "approval-reference" }],
};
function signed(payload = slackPayload) {
  const rawBody = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString(),
    timestamp = "1789642800",
    signingSecret = "synthetic-signing-secret";
  return {
    rawBody,
    timestamp,
    signingSecret,
    now: Number(timestamp) * 1000,
    signature:
      "v0=" +
      createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest("hex"),
  };
}
describe("Slack request verification and durable replay contract", () => {
  it("verifies raw-body HMAC and rejects tampering/stale/future replay", () => {
    const input = signed();
    expect(verifySlackRequest(input).fingerprint).toHaveLength(64);
    expect(() =>
      verifySlackRequest({ ...input, rawBody: input.rawBody + " " }),
    ).toThrow("SLACK_SIGNATURE_INVALID");
    expect(() =>
      verifySlackRequest({ ...input, now: input.now + 301_000 }),
    ).toThrow("SLACK_SIGNATURE_INVALID");
    expect(() =>
      verifySlackRequest({ ...input, now: input.now - 301_000 }),
    ).toThrow("SLACK_SIGNATURE_INVALID");
  });
  it("requires mapped actor/resource authorization and atomically claims replay once", async () => {
    const inbox = new Set<string>();
    const controls = {
      expectedTeamId: "TEAM1",
      authorize: async () => true,
      claimReplay: async (key: string) => {
        if (inbox.has(key)) return false;
        inbox.add(key);
        return true;
      },
    };
    expect(await verifySlackInteraction(signed(), controls)).toMatchObject({
      slackUserId: "USER1",
      value: "approval-reference",
    });
    await expect(
      verifySlackInteraction(signed(), controls),
    ).rejects.toMatchObject({ code: "SLACK_REPLAY" });
    await expect(
      verifySlackInteraction(signed(), {
        ...controls,
        authorize: async () => false,
      }),
    ).rejects.toMatchObject({ code: "SLACK_ACTOR_UNAUTHORIZED" });
    await expect(
      verifySlackInteraction(signed(), {
        ...controls,
        expectedTeamId: "OTHER",
      }),
    ).rejects.toMatchObject({ code: "SLACK_PAYLOAD_INVALID" });
  });
});

const csvConfig = {
  projectId: "project-one",
  source: "adsgram",
  accountId: "account-one",
  currency: "EUR",
  timezone: "Europe/Berlin",
  columns: {
    date: "day",
    campaignId: "campaign",
    impressions: "views",
    clicks: "clicks",
    spend: "cost",
  },
};
describe("CSV stats and export safety", () => {
  it("maps quoted BOM CSV and uses exact money/dedup without cross-project collisions", () => {
    const csv =
      '\ufeffday,campaign,views,clicks,cost\n2026-09-17,"launch, A",100,4,0.29\n2026-09-17,"launch, A",100,4,0.29\n';
    const result = importAdsCsv(csv, csvConfig);
    expect(result.rows).toHaveLength(1);
    expect(result.duplicates).toEqual([3]);
    expect(result.totals).toMatchObject({
      spendMinor: "29",
      clickThroughRate: 0.04,
      conversions: null,
    });
    const other = importAdsCsv(csv, { ...csvConfig, projectId: "project-two" });
    expect(other.rows[0]?.key).not.toBe(result.rows[0]?.key);
    const again = importAdsCsv(csv, {
      ...csvConfig,
      existing: new Map(result.rows.map((r) => [r.key, r.contentHash])),
    });
    expect(again.rows).toHaveLength(0);
  });
  it("reports correction conflicts and per-row failures without raw sensitive cells", () => {
    const result = importAdsCsv(
      "day,campaign,views,clicks,cost\n2026-09-17,A,100,4,1.23\n2026-09-17,A,200,4,2.34\n2026-02-31,private name,=1+2,4,3.0\n",
      csvConfig,
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.errors).toEqual([{ row: 4, code: "INVALID_DATE" }]);
  });
  it("keeps missing metrics null and rejects duplicate/missing headers", () => {
    expect(
      importAdsCsv(
        "day,campaign,views,clicks,cost\n2026-09-17,A,,0,\n",
        csvConfig,
      ).totals,
    ).toMatchObject({
      impressions: null,
      clicks: 0,
      spendMinor: null,
      clickThroughRate: null,
    });
    expect(() => importAdsCsv("day,day,campaign\n", csvConfig)).toThrow(
      "CSV_SCHEMA_OR_SYNTAX_INVALID",
    );
  });
  it("exports a real article bundle and escapes executable preview content", () => {
    const result = exportBlogArticle({
      title: "<script>no</script>",
      slug: "safe-article",
      language: "en",
      description: "Draft",
      bodyMarkdown: "<img src=x onerror=alert(1)>",
      updatedAt: "2026-09-17T12:00:00Z",
      sourceUrls: ["https://example.com/source"],
    });
    expect(result.files.map((f) => f.path)).toEqual([
      "article.md",
      "metadata.json",
      "preview.html",
    ]);
    expect(result.liveAdapter).toBe("not_configured");
    expect(result.files[2]?.content).not.toContain("<script>");
    expect(result.files[2]?.content).toContain("&lt;img");
    expect(() =>
      exportBlogArticle({
        title: "Invalid",
        language: "en",
        description: "Draft",
        updatedAt: "2026-09-17T12:00:00Z",
        sourceUrls: [],
        bodyMarkdown: "",
        slug: "../../outside",
      }),
    ).toThrow("INVALID_ARTICLE");
  });
});

describe("endpoint boundaries", () => {
  it("rejects userinfo, HTTP and query credentials", () => {
    for (const url of [
      "http://localhost/",
      "https://user:pass@example.com/",
      "https://example.com/?token=secret",
    ])
      expect(() => endpoint(url)).toThrow("INVALID_ENDPOINT");
  });
  it("blocks loopback and IPv4-mapped loopback without connecting", async () => {
    await expect(boundedFetch("https://127.0.0.1/")).rejects.toMatchObject({
      code: "PRIVATE_ENDPOINT",
    });
    await expect(
      boundedFetch("https://[::ffff:127.0.0.1]/"),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT" });
  });
});
