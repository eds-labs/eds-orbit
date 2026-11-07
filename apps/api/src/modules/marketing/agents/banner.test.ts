import { describe, expect, it } from "vitest";
import { hash } from "../../../shared.ts";
import { visualIdentity } from "../../../../../../packages/schemas/src/index.ts";
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
  BANNER_LAYOUT_NEEDS,
  ctaButton,
  footerDomain,
  officialFooter,
  withCtaButton,
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
    expect(bannerTextProblems({ ...text, headline1: "" }, layout)).toEqual([
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

  it("builds the background art from the project's own brand kit", () => {
    // A light, family brand (FamilyPlan-like data; the code names no brand).
    const light = visualIdentity.parse({
      primaryColor: "#F97316",
      secondaryColor: "#0F766E",
      accentColor: "#FACC15",
      backgroundColor: "#FFF8F0",
      surfaceColor: "#FFFFFF",
      textColor: "#1F2937",
      designRules: ["Warm, everyday family moments."],
      imagery: {
        kind: "illustration",
        mood: "friendly, warm and optimistic",
        subjects: "families planning their week at the kitchen table",
        avoid: ["neon"],
      },
      forbiddenDesigns: ["Dark futuristic tech scenes"],
    });
    const prompt = bannerBackgroundPrompt(
      { template: "brand_landscape" },
      light,
    );
    expect(prompt.startsWith(BANNER_LAYOUT_NEEDS)).toBe(true);
    expect(prompt).toContain("No text");
    expect(prompt).toContain("no logos");
    expect(prompt).toContain("light and airy");
    expect(prompt).toContain("friendly, warm and optimistic");
    expect(prompt).toContain("families planning their week");
    expect(prompt).toContain("#F97316");
    expect(prompt).toContain("Warm, everyday family moments.");
    expect(prompt).toContain("Avoid: neon; Dark futuristic tech scenes.");
    // No other brand's look is carried in the code.
    for (const word of [
      "fintech",
      "navy",
      "cyan",
      "glass",
      "#040B1A",
      "#22D3EE",
    ])
      expect(prompt.toLowerCase()).not.toContain(word.toLowerCase());

    // A dark brand gets a dark base from its own kit.
    const dark = visualIdentity.parse({
      primaryColor: "#22D3EE",
      secondaryColor: "#0B1D3A",
      accentColor: "#22D3EE",
      backgroundColor: "#040B1A",
      surfaceColor: "#0B1D3A",
      textColor: "#FFFFFF",
    });
    const darkPrompt = bannerBackgroundPrompt(
      { template: "brand_landscape", style: "Frosted glass cards" },
      dark,
    );
    expect(darkPrompt).toContain("Overall tone: dark");
    expect(darkPrompt).toContain("polished, modern and professional");
    expect(darkPrompt.split("\n").at(-1)).toBe(
      "Owner's style notes (take precedence over the brand defaults above): Frosted glass cards",
    );
  });
});

// Production uLiquid, 2026-10-17 (run f610945b): the banner button "Explore
// Desk" competed with the mission CTA "Create your beta account".
describe("banner button from the mission CTA", () => {
  it("is the mission CTA without closing punctuation", () => {
    expect(ctaButton("Create your beta account")).toBe(
      "Create your beta account",
    );
    expect(ctaButton("Learn more.")).toBe("Learn more");
    expect(withCtaButton(text, "Create your beta account")).toEqual({
      ...text,
      button: "Create your beta account",
    });
  });

  it("is left out when the CTA does not fit, or there is none", () => {
    expect(
      ctaButton("Explore the whole trading desk right now for free today"),
    ).toBe("");
    expect(ctaButton(undefined)).toBe("");
    // No button is valid copy: the banner is composed without one.
    expect(bannerTextProblems({ ...text, button: "" }, layout)).toEqual([]);
  });

  it("checks the approved CTA on the button as campaign copy, not as a claim", () => {
    const presale = { ...text, button: "Join the presale" };
    expect(bannerTextProblems(presale, layout)).toEqual([
      BANNER_UNSUPPORTED_CLAIM,
    ]);
    expect(
      bannerTextProblems(presale, { ...layout, cta: "Join the presale." }),
    ).toEqual([]);
    // The rest of the copy is still checked.
    expect(
      bannerTextProblems(
        { ...presale, headline1: "Beta is live." },
        { ...layout, cta: "Join the presale." },
      ),
    ).toEqual([BANNER_UNSUPPORTED_CLAIM]);
  });
});
