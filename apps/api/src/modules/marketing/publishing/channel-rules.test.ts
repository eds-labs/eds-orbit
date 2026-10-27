import { describe, expect, it } from "vitest";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  channelLimitExceeded,
  finalPostText,
  resolveChannelRules,
} from "./channel-rules.ts";

const url = "https://desk.uliquid.vip/en/register";

describe("final post text", () => {
  it("appends the target URL to a body without hashtags", () => {
    expect(finalPostText("Create your beta account", url)).toBe(
      `Create your beta account\n${url}`,
    );
  });

  it("puts the target URL before a closing hashtag line", () => {
    // Production uLiquid, 2026-10-15: the link came after the hashtags;
    // the reference posts lead with the call to action and its link.
    const body =
      "Beta access is open.\n\nCreate your beta account\n\n#BetaAccess #CryptoTrading";
    const text = finalPostText(body, url);
    expect(text).toBe(
      `Beta access is open.\n\nCreate your beta account\n${url}\n\n#BetaAccess #CryptoTrading`,
    );
    expect(text.length).toBe(body.length + 1 + url.length);
  });

  it("leaves a body alone that already contains the URL", () => {
    const body = `Join us\n${url}\n\n#uLiquid`;
    expect(finalPostText(body, url)).toBe(body);
  });

  it("keeps a body that is only hashtags and adds the URL after it", () => {
    expect(finalPostText("#uLiquid", url)).toBe(`#uLiquid\n${url}`);
  });
});

/** The channel rules of an assigned Postiz channel with this provider identifier. */
async function rulesFor(identifier: string, hasAsset = false) {
  const rows = [
    {
      id: "connector-1",
      version: 3,
      data: {
        provider: "postiz",
        status: "read_verified",
        channels: [{ id: "channel-1", name: "Display name", identifier }],
        assignedIntegrationIds: ["channel-1"],
      },
    },
  ];
  const tx = { entity: { findMany: async () => rows } } as unknown as DbTx;
  const scope = { workspaceId: "w", projectId: "p" } as Scope;
  return resolveChannelRules(tx, scope, "channel-1", "social", hasAsset);
}

describe("channel rules", () => {
  it.each([
    ["instagram", 2200, true],
    ["instagram-standalone", 2200, true],
    ["facebook", 50_000, false],
  ] as const)(
    "%s: character limit, UTF-16 counting, known capability",
    async (identifier, characterLimit, mediaRequired) => {
      expect(await rulesFor(identifier)).toMatchObject({
        providerIdentifier: identifier,
        characterLimit,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
        mediaRequired,
      });
    },
  );

  it("keeps Telegram, X and LinkedIn as they were, without a media requirement", async () => {
    expect(await rulesFor("telegram")).toMatchObject({
      characterLimit: 4096,
      countingMethod: "utf16_units",
      liveCapabilityKnown: true,
      mediaRequired: false,
    });
    expect((await rulesFor("telegram", true)).characterLimit).toBe(1024);
    expect(await rulesFor("x")).toMatchObject({
      characterLimit: 280,
      countingMethod: "conservative_x_weighted",
      liveCapabilityKnown: true,
      mediaRequired: false,
    });
    expect(await rulesFor("linkedin")).toMatchObject({
      characterLimit: 3000,
      countingMethod: "utf16_units",
      liveCapabilityKnown: true,
      mediaRequired: false,
    });
  });

  it("knows nothing about other providers and requires no media of them", async () => {
    expect(await rulesFor("mastodon")).toMatchObject({
      providerIdentifier: "mastodon",
      characterLimit: null,
      countingMethod: null,
      liveCapabilityKnown: false,
      mediaRequired: false,
    });
  });

  it("counts an Instagram caption in UTF-16 units, URL included", async () => {
    const rules = await rulesFor("instagram");
    const link = "https://example.org/a";
    expect(channelLimitExceeded("a".repeat(2200), null, rules)).toBe(false);
    expect(channelLimitExceeded("a".repeat(2201), null, rules)).toBe(true);
    // The appended link counts at its full length (plus its line break).
    expect(
      channelLimitExceeded("a".repeat(2200 - link.length - 1), link, rules),
    ).toBe(false);
    expect(
      channelLimitExceeded("a".repeat(2200 - link.length), link, rules),
    ).toBe(true);
    // An emoji is two UTF-16 units.
    expect(channelLimitExceeded("\u{1F600}".repeat(1101), null, rules)).toBe(
      true,
    );
  });

  it("limits a Facebook post to what the Postiz client sends (50,000)", async () => {
    const rules = await rulesFor("facebook");
    expect(channelLimitExceeded("a".repeat(50_000), null, rules)).toBe(false);
    expect(channelLimitExceeded("a".repeat(50_001), null, rules)).toBe(true);
  });

  it("knows no rules for a channel that is not a social post", async () => {
    const tx = { entity: { findMany: async () => [] } } as unknown as DbTx;
    const scope = { workspaceId: "w", projectId: "p" } as Scope;
    expect(
      await resolveChannelRules(tx, scope, "channel-1", "email", true),
    ).toMatchObject({ liveCapabilityKnown: false, mediaRequired: false });
  });
});
