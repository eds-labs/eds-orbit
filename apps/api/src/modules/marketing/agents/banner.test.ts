import { describe, expect, it } from "vitest";
import { hash } from "../../../shared.ts";
import { assignmentHash, assignmentInput } from "./assignments.ts";
import {
  BANNER_LINK_NOT_ALLOWED,
  BANNER_LINK_NOT_OFFICIAL,
  bannerLinkProblem,
  BANNER_BRAND_OVERFLOW,
  BANNER_TEXT_UNSAFE,
  bannerOffenses,
  BANNER_PROHIBITED_LANGUAGE,
  BANNER_TEXT_MISSING,
  BANNER_TEXT_OVERFLOW,
  BANNER_UNSUPPORTED_CLAIM,
  bannerBackgroundPrompt,
  bannerInstruction,
  bannerTextProblems,
  DEFAULT_BANNER_STYLE,
  footerDomain,
  officialFooter,
} from "./banner.ts";

// An assignment as stored before R78: no banner.
const legacy = {
  name: "Two posts a day",
  kind: "standing",
  schedule: {
    rhythm: "daily",
    weekdays: [],
    times: ["10:00", "17:00"],
    leadMinutes: 360,
  },
  contentType: "social",
  channels: ["x-int", "tg-int"],
  topicFrame: "Short updates about beta access for product teams",
  image: true,
  styleAssetIds: [],
  vetoMinutes: 180,
  monthlyBudgetMicros: 10_000_000,
};
const text = {
  headline1: "Start free.",
  headline2: "Build your workflow.",
  subline: "Markets. Paper trading. Bots.",
  button: "Explore Desk",
};
const layout = { brandName: "uLiquid Desk", footer: "desk.uliquid.vip" };

describe("assignment banner field (R78)", () => {
  it("keeps the hash of an assignment without a banner", () => {
    const before = assignmentHash(legacy);
    expect(before).toBe(hash(legacy));
    expect(assignmentHash({ ...legacy, banner: undefined })).toBe(before);
  });

  it("covers the banner and its style", () => {
    const before = assignmentHash(legacy);
    const branded = assignmentHash({
      ...legacy,
      banner: { template: "brand_landscape" },
    });
    expect(branded).not.toBe(before);
    expect(
      assignmentHash({
        ...legacy,
        banner: { template: "brand_landscape", style: "More glow" },
      }),
    ).not.toBe(branded);
  });

  it("allows a banner only on social posts with the image consent", () => {
    const banner = { template: "brand_landscape" };
    expect(assignmentInput.safeParse({ ...legacy, banner }).success).toBe(true);
    expect(
      assignmentInput.safeParse({ ...legacy, image: false, banner }).success,
    ).toBe(false);
    expect(
      assignmentInput.safeParse({
        ...legacy,
        contentType: "blog",
        channels: ["blog-int"],
        banner,
      }).success,
    ).toBe(false);
    expect(
      assignmentInput.safeParse({
        ...legacy,
        banner: { template: "poster" },
      }).success,
    ).toBe(false);
  });
});

describe("banner copy checks (R78)", () => {
  it("accepts plain copy", () => {
    expect(bannerTextProblems(text, layout)).toEqual([]);
  });

  it("blocks figures, status and promises a banner cannot back", () => {
    expect(
      bannerTextProblems({ ...text, headline1: "Earn 10% daily" }, layout),
    ).toEqual([BANNER_UNSUPPORTED_CLAIM]);
    expect(
      bannerTextProblems({ ...text, headline2: "Beta is live." }, layout),
    ).toEqual([BANNER_UNSUPPORTED_CLAIM]);
    expect(
      bannerTextProblems({ ...text, subline: "Guaranteed profit." }, layout),
    ).toEqual([BANNER_PROHIBITED_LANGUAGE]);
    expect(
      bannerTextProblems({ ...text, subline: "Risk-free trading." }, layout),
    ).toEqual([BANNER_PROHIBITED_LANGUAGE]);
    expect(
      bannerTextProblems({ ...text, button: "{{fact:abc}}" }, layout),
    ).toEqual([BANNER_UNSUPPORTED_CLAIM]);
  });

  it("asks for shorter copy when it does not fit, and names missing copy", () => {
    expect(
      bannerTextProblems(
        { ...text, headline1: "Supercalifragilistic workflows" },
        layout,
      ),
    ).toEqual([BANNER_TEXT_OVERFLOW]);
    expect(bannerTextProblems(undefined, layout)).toEqual([
      BANNER_TEXT_MISSING,
    ]);
    expect(bannerTextProblems({ ...text, button: "" }, layout)).toEqual([
      BANNER_TEXT_MISSING,
    ]);
    expect(bannerInstruction(text, [BANNER_TEXT_OVERFLOW])).toMatch(
      /^Fix the banner copy: shorten it to fit: headline1 at most 18 characters.*add no new claim, figure or link\.$/,
    );
  });

  it("catches number words, percentages, look-alike letters and invisible characters", () => {
    for (const changes of [
      { headline1: "Ten times faster." },
      { subline: "Fees cut by half." },
      { headline2: "Zehn Märkte." },
      { button: "Save 5 %" },
      // Full-width digits normalize to digits.
      { headline1: "Start ７ bots." },
    ])
      expect(bannerTextProblems({ ...text, ...changes }, layout)).toEqual([
        BANNER_UNSUPPORTED_CLAIM,
      ]);
    // A Cyrillic "е" hiding "live", and a zero-width space inside a word.
    expect(
      bannerTextProblems({ ...text, headline2: "Bеta livе." }, layout),
    ).toEqual([BANNER_TEXT_UNSAFE]);
    expect(
      bannerTextProblems({ ...text, headline2: "Beta li\u200Bve." }, layout),
    ).toEqual([BANNER_TEXT_UNSAFE]);
    // German letters are Latin.
    expect(
      bannerTextProblems(
        { ...text, subline: "Märkte. Größer denken." },
        layout,
      ),
    ).toEqual([]);
  });

  it("names the words to remove in the revision instruction", () => {
    const claimed = {
      ...text,
      headline1: "Earn 10% daily.",
      subline: "Guaranteed returns.",
    };
    expect(bannerOffenses(claimed)).toEqual(
      expect.arrayContaining(["10", "%", "Guaranteed", "returns"]),
    );
    const instruction = bannerInstruction(claimed, [
      BANNER_UNSUPPORTED_CLAIM,
      BANNER_PROHIBITED_LANGUAGE,
    ]);
    expect(instruction).toContain('"10"');
    expect(instruction).toContain('"returns"');
    expect(instruction).toContain("Edit previousBanner only for this");
  });

  it("tells a wordmark or domain that cannot fit apart from copy", () => {
    expect(
      bannerTextProblems(text, {
        brandName: "A very long product name no banner can hold",
        footer: "desk.uliquid.vip",
      }),
    ).toEqual([BANNER_BRAND_OVERFLOW]);
  });

  it("tells an unofficial link from an official one the policy does not allow", () => {
    const links = [{ url: "https://desk.example/en/register" }];
    expect(
      bannerLinkProblem("https://desk.example/en/register", links, [
        "https://desk.example",
      ]),
    ).toBeNull();
    expect(
      bannerLinkProblem("https://desk.example/en/register", links, []),
    ).toBe(BANNER_LINK_NOT_ALLOWED);
    expect(
      bannerLinkProblem("https://elsewhere.example/", links, [
        "https://elsewhere.example",
      ]),
    ).toBe(BANNER_LINK_NOT_OFFICIAL);
  });

  it("names the official link's domain, only for an official link", () => {
    expect(footerDomain("https://www.desk.example/en/register")).toBe(
      "desk.example",
    );
    const links = [{ url: "https://desk.example/en/register" }];
    expect(
      officialFooter("https://desk.example/en/register", links, [
        "https://desk.example",
      ]),
    ).toBe("desk.example");
    expect(
      officialFooter("https://desk.example/other", links, [
        "https://desk.example",
      ]),
    ).toBeNull();
    expect(
      officialFooter("https://desk.example/en/register", links, []),
    ).toBeNull();
  });

  it("generates only background art from the default or the owner's style", () => {
    expect(DEFAULT_BANNER_STYLE).toContain("no text");
    expect(DEFAULT_BANNER_STYLE).toContain("no logos");
    expect(bannerBackgroundPrompt({ template: "brand_landscape" })).toBe(
      DEFAULT_BANNER_STYLE,
    );
    expect(
      bannerBackgroundPrompt({ template: "brand_landscape", style: "Warmer" }),
    ).toBe(`${DEFAULT_BANNER_STYLE}\nOwner's style notes: Warmer`);
  });
});
