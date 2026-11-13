import { describe, expect, it } from "vitest";
import { platformOptions, TEXT_LIMITS, validateVariant, type VariantFacts } from "../src/modules/social/posts/validation.ts";
import type { MediaFacts } from "../src/modules/social/media/rules.ts";

// What a platform would refuse, checked before anything is sent (ADR 0020,
// S4): the SDK's own local checks for X and Instagram text, the library's
// media rules, and Orbit's limits for Facebook and Telegram.

const image = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  mime: "image/jpeg",
  width: 1080,
  height: 1080,
  size: 300_000,
  jpegWidth: 1080,
  jpegHeight: 1080,
  jpegSize: 300_000,
  ...over,
});
const facts = (platform: VariantFacts["account"]["platform"], over: Partial<VariantFacts> = {}): VariantFacts => ({
  account: { id: "a1", platform, externalId: "1234567890", status: "active", capability: "write_verified", settings: {} },
  body: "Hello from Orbit",
  media: [],
  options: {},
  ...over,
});
const codes = (v: VariantFacts) => validateVariant(v).map((i) => `${i.severity}:${i.code}`);

describe("validateVariant", () => {
  it("accepts an ordinary post on every platform", () => {
    expect(codes(facts("x"))).toEqual([]);
    expect(codes(facts("facebook"))).toEqual([]);
    expect(codes(facts("telegram"))).toEqual([]);
    expect(codes(facts("instagram", { media: [image()] }))).toEqual([]);
  });

  it("applies X's weighted 280 limit unless the account allows long posts", () => {
    const long = "a".repeat(281);
    expect(validateVariant(facts("x", { body: long }))).toEqual([{ code: "SOCIAL_TEXT_TOO_LONG", severity: "error", path: "body" }]);
    const premium = { ...facts("x").account, settings: { xLongPosts: true } };
    expect(codes(facts("x", { body: long, account: premium }))).toEqual([]);
    expect(codes(facts("x", { body: "a".repeat(25_001), account: premium }))).toEqual(["error:SOCIAL_TEXT_TOO_LONG"]);
    // Links count 23 characters on X, so a long URL does not use up the limit.
    const links = `${"Read more ".repeat(10)}https://example.com/${"x".repeat(200)}`;
    expect(links.length).toBeGreaterThan(280);
    expect(codes(facts("x", { body: links }))).toEqual([]);
  });

  it("refuses an AI image without a valid label on every platform (ADR 0028)", () => {
    for (const platform of ["x", "facebook", "telegram", "instagram"] as const)
      expect(validateVariant(facts(platform, { media: [image(), { ...image(), aiLabelMissing: true }] }))).toEqual([
        { code: "SOCIAL_AI_LABEL_MISSING", severity: "error", path: "media" },
      ]);
    expect(codes(facts("x", { media: [{ ...image(), aiLabelMissing: false }] }))).toEqual([]);
  });

  it("refuses more than four images on X", () => {
    expect(codes(facts("x", { media: Array.from({ length: 5 }, () => image()) }))).toEqual(["error:SOCIAL_MEDIA_TOO_MANY"]);
  });

  it("needs an image on Instagram and limits its caption", () => {
    expect(codes(facts("instagram"))).toEqual(["error:SOCIAL_MEDIA_REQUIRED"]);
    expect(codes(facts("instagram", { body: "a".repeat(2_201), media: [image()] }))).toEqual(["error:SOCIAL_TEXT_TOO_LONG"]);
    expect(codes(facts("instagram", { media: [image({ jpegWidth: 1080, jpegHeight: 2400 })] }))).toEqual([
      "error:SOCIAL_MEDIA_ASPECT_RATIO",
    ]);
  });

  it("limits a Telegram caption with images to 1,024 characters and a text to 4,096", () => {
    expect(codes(facts("telegram", { body: "a".repeat(1_025), media: [image()] }))).toEqual(["error:SOCIAL_CAPTION_TOO_LONG"]);
    expect(codes(facts("telegram", { body: "a".repeat(1_025) }))).toEqual([]);
    expect(codes(facts("telegram", { body: "a".repeat(4_097) }))).toEqual(["error:SOCIAL_TEXT_TOO_LONG"]);
  });

  it("limits a Facebook text to 63,206 characters", () => {
    expect(codes(facts("facebook", { body: "a".repeat(63_207) }))).toEqual(["error:SOCIAL_TEXT_TOO_LONG"]);
  });

  it("refuses an empty post", () => {
    expect(codes(facts("telegram", { body: "  " }))).toEqual(["error:SOCIAL_TEXT_EMPTY"]);
    expect(codes(facts("telegram", { body: "", media: [image()] }))).toEqual([]);
  });

  it("refuses an account that cannot post and warns about an unverified one", () => {
    const lost = { ...facts("telegram").account, status: "reconnect_required" };
    expect(codes(facts("telegram", { account: lost }))).toEqual(["error:SOCIAL_ACCOUNT_NOT_ACTIVE"]);
    const unverified = { ...facts("telegram").account, capability: "read_verified" };
    expect(codes(facts("telegram", { account: unverified }))).toEqual(["warning:SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED"]);
  });

  it("accepts only the known options of each platform", () => {
    expect(codes(facts("x", { options: { replySettings: "following" } }))).toEqual([]);
    expect(validateVariant(facts("x", { options: { replySettings: "nobody" } }))).toEqual([
      { code: "SOCIAL_OPTIONS_INVALID", severity: "error", path: "options" },
    ]);
    expect(codes(facts("telegram", { options: { disableLinkPreview: true, silent: true } }))).toEqual([]);
    expect(codes(facts("instagram", { media: [image()], options: { replySettings: "everyone" } }))).toEqual([
      "error:SOCIAL_OPTIONS_INVALID",
    ]);
    expect(platformOptions("facebook").safeParse({}).success).toBe(true);
  });

  it("refuses in live mode what cannot go out, and only warns in test mode", () => {
    const live = { mode: "live" as const, platformEnabled: true, publicMedia: true };
    expect(codes(facts("facebook"))).toEqual([]);
    expect(validateVariant(facts("facebook"), { ...live, platformEnabled: false })).toContainEqual({
      code: "SOCIAL_PLATFORM_NOT_AVAILABLE",
      severity: "error",
    });
    expect(validateVariant(facts("instagram", { media: [image()] }), { ...live, publicMedia: false })).toContainEqual({
      code: "SOCIAL_MEDIA_PUBLIC_REQUIRED",
      severity: "error",
      path: "media",
    });
    const unverified = { ...facts("telegram").account, capability: "read_verified" };
    expect(validateVariant(facts("telegram", { account: unverified }), live).map((i) => `${i.severity}:${i.code}`)).toEqual([
      "error:SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED",
    ]);
    const test = { mode: "test" as const, platformEnabled: false, publicMedia: false };
    expect(validateVariant(facts("instagram", { media: [image()], account: { ...facts("instagram").account, capability: "read_verified" } }), test).map((i) => `${i.severity}:${i.code}`)).toEqual([
      "warning:SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED",
    ]);
  });

  it("names its limits", () => {
    expect(TEXT_LIMITS).toEqual({ x: 280, xLong: 25_000, instagram: 2_200, facebook: 63_206, telegram: 4_096, telegramCaption: 1_024 });
  });
});
