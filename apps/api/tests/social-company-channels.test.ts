import { afterEach, describe, expect, it, vi } from "vitest";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import {
  readChannel,
  refreshChannelToken,
} from "../src/modules/social/accounts/channel-oauth.ts";
import { tiktokPostUrl } from "../src/modules/social/accounts/tiktok.ts";
import {
  senderFor,
  type SendInput,
} from "../src/modules/social/adapters/registry.ts";
import { socialVideoFacts } from "../src/modules/social/media/video.ts";
import { validateVariant } from "../src/modules/social/posts/validation.ts";
import { videoFixture } from "./support/social-video.ts";

const scope = {
  workspaceId: "test",
  projectId: "test",
  userId: "test",
} as never;
const input = (platform: SendInput["credentials"]["platform"]): SendInput => ({
  publicationId: "test",
  credentials: {
    platform,
    accessToken: "synthetic-token",
    externalId: "1234",
    config: { inbox: true },
  },
  account: { externalId: "1234", handle: "@eds", settings: {} },
  body: "See the new release.",
  options: {},
  media: [],
  providerState: {},
});
const video = {
  fileId: "file",
  bytes: videoFixture(),
  mime: "video/mp4" as const,
  width: 540,
  height: 960,
  publicUrl: null,
};

afterEach(() => setSocialFetchForTests(null));

describe("company social channels", () => {
  it("validates vertical H.264 metadata and rejects landscape, long, alternate-codec and truncated files", () => {
    expect(socialVideoFacts(video.bytes)).toEqual({
      width: 540,
      height: 960,
      durationMs: 1200,
    });
    for (const bytes of [
      videoFixture({ width: 960, height: 540 }),
      videoFixture({ duration: 60_001 }),
      videoFixture({ codec: "hvc1" }),
      video.bytes.subarray(0, -1),
    ])
      expect(() => socialVideoFacts(bytes)).toThrow("SOCIAL_VIDEO_INVALID");
  });

  it("binds manual links to the exact TikTok account and canonical platform", () => {
    expect(
      tiktokPostUrl(
        "https://www.tiktok.com/@eds/video/1234567890123?source=share",
        "@eds",
      ),
    ).toEqual({
      id: "1234567890123",
      permalink: "https://www.tiktok.com/@eds/video/1234567890123",
    });
    for (const path of [
      "https://www.tiktok.com/@other/video/1234567890123",
      "https://tiktok.com.invalid/@eds/video/1234567890123",
      "http://www.tiktok.com/@eds/video/1234567890123",
    ])
      expect(tiktokPostUrl(path, "@eds")).toBeNull();
  });

  it("requires YouTube metadata at approval and one video", () => {
    const account = {
      id: "1",
      platform: "youtube" as const,
      externalId: "x",
      status: "active",
      capability: "write_verified",
      settings: {},
    };
    expect(
      validateVariant({
        account,
        body: "Description",
        media: [],
        options: {},
      }).map((issue) => issue.code),
    ).toEqual(["SOCIAL_VIDEO_REQUIRED", "SOCIAL_OPTIONS_INVALID"]);
  });

  it("only connects a LinkedIn organization the current administrator may manage", async () => {
    const transport = vi.fn(async (url: string | URL) =>
      String(url).includes("organizationAcls?")
        ? Response.json({
            elements: [
              {
                organization: "urn:li:organization:1234",
                role: "ADMINISTRATOR",
                state: "APPROVED",
              },
            ],
          })
        : Response.json({
            id: 1234,
            vanityName: "eds",
            localizedName: "EDS Labs",
          }),
    );
    setSocialFetchForTests(transport);
    await expect(
      readChannel("linkedin", "synthetic-token", "1234"),
    ).resolves.toMatchObject({ id: "1234", handle: "eds" });
    await expect(
      readChannel("linkedin", "synthetic-token", "9999"),
    ).rejects.toMatchObject({ code: "SOCIAL_PROVIDER_REJECTED" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("sends a LinkedIn Company Page post once and treats a server timeout as unknown", async () => {
    const transport = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:9000" },
        }),
    );
    setSocialFetchForTests(transport);
    const sender = senderFor("linkedin")!;
    await expect(sender.send(scope, input("linkedin"))).resolves.toMatchObject({
      kind: "published",
      externalPostId: "urn:li:share:9000",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(transport.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      author: "urn:li:organization:1234",
      commentary: "See the new release.",
    });
    transport.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(sender.send(scope, input("linkedin"))).resolves.toMatchObject({
      kind: "unknown",
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("checks the LinkedIn image URL and confirms the image before creating the post", async () => {
    const transport = vi.fn(async (raw: string | URL, init?: RequestInit) => {
      const url = new URL(raw);
      if (url.searchParams.has("action"))
        return Response.json({
          value: {
            image: "urn:li:image:fixture",
            uploadUrl:
              "https://www.linkedin.com/dms-uploads/fixture?token=test",
          },
        });
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      if (url.pathname.includes("/images/"))
        return Response.json({ status: "AVAILABLE" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        content: { media: { id: "urn:li:image:fixture" } },
      });
      return new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:ugcPost:1234" },
      });
    });
    setSocialFetchForTests(transport);
    const sender = senderFor("linkedin")!;
    const p = {
      ...input("linkedin"),
      media: [{ ...video, mime: "image/jpeg" as const }],
    };
    await expect(sender.send(scope, p)).resolves.toMatchObject({
      kind: "published",
      externalPostId: "urn:li:ugcPost:1234",
    });
    expect(transport).toHaveBeenCalledTimes(4);
    transport.mockReset();
    transport.mockResolvedValue(
      Response.json({
        value: {
          image: "urn:li:image:fixture",
          uploadUrl: "https://www.linkedin.com.invalid/dms-uploads/fixture",
        },
      }),
    );
    await expect(sender.send(scope, p)).resolves.toMatchObject({
      kind: "failed",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("resumes a processing LinkedIn image without uploading the file twice", async () => {
    const transport = vi.fn(async (raw: string | URL) => {
      const url = new URL(raw);
      if (url.searchParams.has("action"))
        return Response.json({
          value: {
            image: "urn:li:image:processing",
            uploadUrl: "https://www.linkedin.com/dms-uploads/processing",
          },
        });
      if (url.hostname === "www.linkedin.com")
        return new Response(null, { status: 201 });
      if (url.pathname.includes("/images/"))
        return Response.json({
          status:
            transport.mock.calls.length === 3 ? "PROCESSING" : "AVAILABLE",
        });
      return new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:2345" },
      });
    });
    setSocialFetchForTests(transport);
    const sender = senderFor("linkedin")!;
    const post = {
      ...input("linkedin"),
      media: [{ ...video, mime: "image/jpeg" as const }],
    };
    const first = await sender.send(scope, post);
    expect(first).toMatchObject({
      kind: "failed",
      retry: "after-delay",
      providerState: { linkedinImage: "urn:li:image:processing" },
    });
    await expect(
      sender.send(scope, {
        ...post,
        providerState: ("providerState" in first && first.providerState) || {},
      }),
    ).resolves.toMatchObject({ kind: "published" });
    expect(
      transport.mock.calls.filter(([url]) =>
        String(url).includes("dms-uploads"),
      ),
    ).toHaveLength(1);
  });

  it("preserves a Google refresh grant and requires reconnect when a LinkedIn account has none", async () => {
    const old = {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const app = {
      clientId: "synthetic",
      clientSecret: "synthetic",
      targetId: "synthetic",
    };
    setSocialFetchForTests(async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
        "refresh-token",
      );
      return Response.json({ access_token: "new-token", expires_in: 3600 });
    });
    await expect(
      refreshChannelToken("youtube", app, old),
    ).resolves.toMatchObject({
      accessToken: "new-token",
      refreshToken: "refresh-token",
    });
    await expect(
      refreshChannelToken("linkedin", app, { ...old, refreshToken: null }),
    ).rejects.toMatchObject({ code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED" });
  });

  it("uploads a TikTok inbox draft and waits for manual publication", async () => {
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/inbox/video/init/"))
        return Response.json({
          error: { code: "ok" },
          data: {
            publish_id: "v_inbox_file.abc",
            upload_url:
              "https://open-upload.tiktokapis.com/video/?upload_id=synthetic",
          },
        });
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      return Response.json({
        error: { code: "ok" },
        data: { status: "SEND_TO_USER_INBOX" },
      });
    });
    setSocialFetchForTests(transport);
    const sender = senderFor("tiktok")!;
    const post = { ...input("tiktok"), media: [video] };
    const sent = await sender.send(scope, post);
    expect(sent).toEqual({
      kind: "processing",
      providerState: { tiktokInboxId: "v_inbox_file.abc" },
    });
    await expect(
      sender.reconcile!(scope, {
        ...post,
        since: new Date(),
        providerState: { tiktokInboxId: "v_inbox_file.abc" },
      }),
    ).resolves.toEqual({
      kind: "manual",
      providerState: { tiktokInboxReady: true },
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
      new Headers(transport.mock.calls[1]?.[1]?.headers).has("authorization"),
    ).toBe(false);
    expect(
      transport.mock.calls.every(
        ([url]) =>
          !String(url).includes("/video/init/") ||
          String(url).includes("/inbox/"),
      ),
    ).toBe(true);
  });
});
