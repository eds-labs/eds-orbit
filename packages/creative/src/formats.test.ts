import { describe, expect, it } from "vitest";
import { CREATIVE_FORMATS, formatsForChannel } from "./formats.ts";
import { CREATIVE_FORMAT_IDS } from "./ids.ts";

describe("creative format registry", () => {
  it("defines every format id with its exact size and safe insets", () => {
    expect(Object.keys(CREATIVE_FORMATS).sort()).toEqual(
      [...CREATIVE_FORMAT_IDS].sort(),
    );
    const all = (n: number) => ({ top: n, right: n, bottom: n, left: n });
    expect(CREATIVE_FORMATS.feed_portrait).toEqual({
      id: "feed_portrait",
      width: 1080,
      height: 1350,
      safe: all(72),
    });
    expect(CREATIVE_FORMATS.square).toEqual({
      id: "square",
      width: 1080,
      height: 1080,
      safe: all(72),
    });
    expect(CREATIVE_FORMATS.story).toEqual({
      id: "story",
      width: 1080,
      height: 1920,
      safe: { top: 250, right: 72, bottom: 340, left: 72 },
    });
    expect(CREATIVE_FORMATS.landscape).toEqual({
      id: "landscape",
      width: 1200,
      height: 630,
      safe: all(48),
    });
  });

  it.each([
    ["instagram", ["feed_portrait"]],
    ["instagram-standalone", ["feed_portrait"]],
    ["facebook", ["feed_portrait"]],
    ["linkedin", ["landscape"]],
    ["x", ["landscape"]],
    ["telegram", ["landscape"]],
  ])("maps %s to its default format", (identifier, expected) => {
    expect(formatsForChannel(identifier)).toEqual(expected);
  });

  it("falls back to square for unknown or missing channels", () => {
    expect(formatsForChannel("mastodon")).toEqual(["square"]);
    expect(formatsForChannel(null)).toEqual(["square"]);
  });

  it("lets an override replace the default for its identifier only", () => {
    const overrides = { instagram: ["square", "story"] } as const;
    expect(formatsForChannel("instagram", overrides)).toEqual([
      "square",
      "story",
    ]);
    expect(formatsForChannel("x", overrides)).toEqual(["landscape"]);
  });

  it("returns a copy so callers cannot mutate the defaults", () => {
    formatsForChannel("instagram").push("story");
    expect(formatsForChannel("instagram")).toEqual(["feed_portrait"]);
  });
});
