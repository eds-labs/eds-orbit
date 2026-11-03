import { describe, expect, it } from "vitest";
import { carouselIssues, mediaIssues, renditionFor, type MediaFacts } from "../src/modules/social/media/rules.ts";

const MiB = 1024 * 1024;
const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  mime: "image/png",
  width: 1600,
  height: 1200,
  size: 2 * MiB,
  jpegWidth: 1440,
  jpegHeight: 1080,
  jpegSize: 400_000,
  ...over,
});
// A rendition of the given ratio, 1440 wide.
const ratio = (r: number) => facts({ jpegWidth: 1440, jpegHeight: Math.round(1440 / r), width: 1440, height: Math.round(1440 / r) });

// Which rendition each platform gets and what it refuses (ADR 0020, S3).
describe("social media rules", () => {
  it("gives Instagram the JPEG rendition and checks its ratio, width and size", () => {
    expect(renditionFor(facts(), "instagram")).toBe("jpeg");
    expect(mediaIssues(ratio(0.8), "instagram")).toEqual([]);
    expect(mediaIssues(ratio(1.91), "instagram")).toEqual([]);
    expect(mediaIssues(ratio(0.79), "instagram")).toEqual(["SOCIAL_MEDIA_ASPECT_RATIO"]);
    expect(mediaIssues(ratio(1.92), "instagram")).toEqual(["SOCIAL_MEDIA_ASPECT_RATIO"]);
    expect(mediaIssues(facts({ jpegWidth: 300, jpegHeight: 300 }), "instagram")).toEqual(["SOCIAL_MEDIA_TOO_SMALL"]);
    expect(mediaIssues(facts({ jpegSize: 8_000_001 }), "instagram")).toEqual(["SOCIAL_MEDIA_TOO_LARGE"]);
  });

  it("gives X the original up to 5 MiB, else the JPEG rendition", () => {
    expect(renditionFor(facts({ size: 5 * MiB }), "x")).toBe("original");
    expect(renditionFor(facts({ size: 5 * MiB + 1 }), "x")).toBe("jpeg");
    expect(mediaIssues(facts({ size: 5 * MiB + 1 }), "x")).toEqual([]);
    expect(mediaIssues(facts({ size: 6 * MiB, jpegSize: 5 * MiB + 1 }), "x")).toEqual(["SOCIAL_MEDIA_TOO_LARGE"]);
  });

  it("gives Facebook the original up to 4 MB (Page photo limit), else the JPEG rendition", () => {
    expect(renditionFor(facts({ size: 3_900_000 }), "facebook")).toBe("original");
    expect(renditionFor(facts({ size: 4_100_000 }), "facebook")).toBe("jpeg");
    expect(mediaIssues(facts({ size: 6_000_000, jpegSize: 3_000_000 }), "facebook")).toEqual([]);
    expect(mediaIssues(facts({ size: 6_000_000, jpegSize: 4_200_000 }), "facebook")).toEqual(["SOCIAL_MEDIA_TOO_LARGE"]);
  });

  it("gives Telegram the original up to 10 MB", () => {
    expect(renditionFor(facts({ size: 10 * MiB }), "telegram")).toBe("original");
    expect(renditionFor(facts({ size: 10 * MiB + 1 }), "telegram")).toBe("jpeg");
  });

  it("checks Telegram's dimension and ratio limits", () => {
    expect(mediaIssues(facts({ width: 4096, height: 4096 }), "telegram")).toEqual([]);
    expect(mediaIssues(facts({ width: 6000, height: 4001 }), "telegram")).toEqual(["SOCIAL_MEDIA_DIMENSIONS"]);
    expect(mediaIssues(facts({ width: 4000, height: 199 }), "telegram")).toEqual(["SOCIAL_MEDIA_ASPECT_RATIO"]);
    expect(mediaIssues(facts({ width: 4000, height: 200 }), "telegram")).toEqual([]);
  });

  it("limits carousels and albums per platform", () => {
    expect(carouselIssues([facts(), facts(), facts(), facts()], "x")).toEqual([]);
    expect(carouselIssues(Array.from({ length: 5 }, () => facts()), "x")).toEqual(["SOCIAL_MEDIA_TOO_MANY"]);
    expect(carouselIssues(Array.from({ length: 10 }, () => facts()), "instagram")).toEqual([]);
    expect(carouselIssues(Array.from({ length: 11 }, () => facts()), "instagram")).toEqual(["SOCIAL_MEDIA_TOO_MANY"]);
    expect(carouselIssues(Array.from({ length: 11 }, () => facts()), "telegram")).toEqual(["SOCIAL_MEDIA_TOO_MANY"]);
  });

  it("needs equal ratios in an Instagram carousel", () => {
    expect(carouselIssues([ratio(1), ratio(1)], "instagram")).toEqual([]);
    expect(carouselIssues([ratio(1), ratio(1.25)], "instagram")).toEqual(["SOCIAL_MEDIA_CAROUSEL_RATIO"]);
    expect(carouselIssues([ratio(1), ratio(1.25)], "facebook")).toEqual([]);
  });

  it("reports each item's own issues once in a carousel", () => {
    expect(carouselIssues([ratio(1), ratio(3)], "instagram")).toEqual(["SOCIAL_MEDIA_ASPECT_RATIO", "SOCIAL_MEDIA_CAROUSEL_RATIO"]);
  });
});
