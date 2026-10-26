import { describe, expect, it } from "vitest";
import {
  copyCraftInstruction,
  copyCraftProblems,
  CORE_MESSAGE_MISSING,
  creativeCopyInstruction,
  creativeCopyProblems,
  creativeCta,
  CREATIVE_LINK_NOT_ALLOWED,
  CREATIVE_PROHIBITED_LANGUAGE,
  CREATIVE_TEXT_MISSING,
  CREATIVE_TEXT_UNSAFE,
  CREATIVE_UNSUPPORTED_CLAIM,
  FACT_TOO_LONG_FOR_SOCIAL,
  parsedCreativeCopy,
  storedCreativeCopy,
} from "./copy-checks.ts";

const limits = { eyebrow: 32, headline: 60, subline: 120, cta: 24 };
const copy = {
  eyebrow: "Home office",
  headline: "Calm light for long days",
  subline: "A desk lamp that adapts to your evening.",
  cta: "Shop the lamp",
};
const cta = "Shop the lamp.";
const check = (changes: Partial<typeof copy>) =>
  creativeCopyProblems({ ...copy, ...changes }, limits, { cta });

// A 300-character description: a knowledge-base text, not a social fact.
const LONG_FACT = `Lumora Home lamps ${"adapt their colour temperature to the time of day and ".repeat(5)}stay calm.`;
const crafted = (changes: Record<string, unknown> = {}) => ({
  type: "social",
  copyCraft: true,
  coreMessage: "Good light makes long days easier.",
  hook: "Ever squinted at your screen at 6 pm?",
  body: "Ever squinted at your screen at 6 pm? Shop the lamp.",
  claims: [
    { text: "Shop the lamp.", kind: "style" },
    { text: "dims in three steps", kind: "fact", factId: "f1" },
  ],
  ...changes,
});

describe("creative copy checks", () => {
  it("accepts plain image copy with the mission CTA", () => {
    expect(creativeCopyProblems(copy, limits, { cta })).toEqual([]);
    // Empty optional layers are absent, not missing.
    expect(check({ eyebrow: "", subline: "", cta: "" })).toEqual([]);
    // As stored (R37): only the layers with copy.
    expect(
      creativeCopyProblems({ headline: copy.headline }, limits, { cta }),
    ).toEqual([]);
    expect(
      creativeCopyProblems({ headline: "Save 30%" }, limits, { cta }),
    ).toEqual([CREATIVE_UNSUPPORTED_CLAIM]);
  });

  it("blocks a figure, number word or status the image cannot back", () => {
    expect(check({ headline: "Save 30%" })).toEqual([
      CREATIVE_UNSUPPORTED_CLAIM,
    ]);
    expect(check({ eyebrow: "Three new colours" })).toEqual([
      CREATIVE_UNSUPPORTED_CLAIM,
    ]);
    expect(check({ subline: "Available now in every shop" })).toEqual([
      CREATIVE_UNSUPPORTED_CLAIM,
    ]);
    expect(check({ headline: "{{fact:f1}}" })).toEqual([
      CREATIVE_UNSUPPORTED_CLAIM,
    ]);
  });

  it("blocks promises and prohibited wording", () => {
    expect(check({ subline: "Try it risk-free" })).toEqual([
      CREATIVE_PROHIBITED_LANGUAGE,
    ]);
    expect(check({ headline: "Guaranteed calm evenings" })).toEqual([
      CREATIVE_PROHIBITED_LANGUAGE,
    ]);
  });

  it("refuses invisible characters and look-alike letters", () => {
    expect(check({ headline: "Calm​light for long days" })).toEqual([
      CREATIVE_TEXT_UNSAFE,
    ]);
    // Cyrillic "а" in "Calm".
    expect(check({ headline: "Cаlm light for long days" })).toEqual([
      CREATIVE_TEXT_UNSAFE,
    ]);
  });

  it("names missing, malformed or too long copy", () => {
    expect(check({ headline: "" })).toEqual([CREATIVE_TEXT_MISSING]);
    expect(check({ headline: "   " })).toEqual([CREATIVE_TEXT_MISSING]);
    expect(creativeCopyProblems(undefined, limits, { cta })).toEqual([
      CREATIVE_TEXT_MISSING,
    ]);
    expect(
      creativeCopyProblems({ eyebrow: "Home office" }, limits, { cta }),
    ).toEqual([CREATIVE_TEXT_MISSING]);
    expect(
      creativeCopyProblems({ ...copy, footer: "lumora" }, limits, { cta }),
    ).toEqual([CREATIVE_TEXT_MISSING]);
    expect(check({ headline: "x".repeat(61) })).toEqual([
      CREATIVE_TEXT_MISSING,
    ]);
    // A line break the template cannot draw.
    expect(check({ subline: "Calm light.\nLong days." })).toEqual([
      CREATIVE_TEXT_MISSING,
    ]);
  });

  it("refuses links on the image", () => {
    expect(check({ subline: "More at https://lumora.example/lamp" })).toEqual([
      CREATIVE_LINK_NOT_ALLOWED,
    ]);
    expect(check({ subline: "More at www.lumora.example" })).toEqual([
      CREATIVE_LINK_NOT_ALLOWED,
    ]);
    // A bare host may be a name (R49): left for the owner, as in the body.
    expect(check({ subline: "Order at lumora.example" })).toEqual([
      "LINK_UNVERIFIED",
    ]);
  });

  it("checks a CTA that is not the mission's like any other copy", () => {
    expect(check({ cta: "Save 30% today" })).toEqual([
      CREATIVE_UNSUPPORTED_CLAIM,
    ]);
    expect(
      creativeCopyProblems({ ...copy, cta: "Join 3 teams" }, limits, {
        cta: "Join 3 teams",
      }),
    ).toEqual([]);
  });

  it("sets the CTA from the mission without closing punctuation, empty when too long", () => {
    expect(creativeCta("Shop the lamp.", 24)).toBe("Shop the lamp");
    expect(creativeCta("Find the right light for your home office", 24)).toBe(
      "",
    );
    expect(creativeCta(undefined, 24)).toBe("");
  });

  it("stores only the layers with copy, the headline always (R37)", () => {
    expect(storedCreativeCopy(copy)).toEqual(copy);
    const sparse = storedCreativeCopy({
      eyebrow: "",
      headline: "Calm light for long days",
      subline: "",
      cta: "",
    });
    expect(sparse).toEqual({ headline: "Calm light for long days" });
    expect(Object.keys(sparse)).toEqual(["headline"]);
    expect(
      storedCreativeCopy({ ...copy, eyebrow: "", headline: "", cta: "" }),
    ).toEqual({ headline: "", subline: copy.subline });
  });

  it("reads stored copy only when every layer it has is text", () => {
    expect(parsedCreativeCopy(copy)).toEqual(copy);
    expect(parsedCreativeCopy({ headline: "Calm light" })).toEqual({
      headline: "Calm light",
    });
    expect(parsedCreativeCopy({ ...copy, headline: 3 })).toBeNull();
    expect(parsedCreativeCopy({ subline: "Calm" })).toBeNull();
    expect(parsedCreativeCopy(null)).toBeNull();
  });

  it("names the words to remove and the limits in the revision instruction", () => {
    const instruction = creativeCopyInstruction(
      { ...copy, headline: "Save 30% on calm light" },
      [CREATIVE_UNSUPPORTED_CLAIM],
      limits,
      cta,
    );
    expect(instruction).toContain('"30"');
    expect(instruction).toContain('"%"');
    expect(instruction).toContain("previousCreative");
    expect(
      creativeCopyInstruction(
        { ...copy, headline: "" },
        [CREATIVE_TEXT_MISSING],
        limits,
        cta,
      ),
    ).toContain("headline of at most 60 characters");
  });
});

describe("copy craft checks", () => {
  it("accepts a crafted social post", () => {
    expect(copyCraftProblems(crafted())).toEqual([]);
  });

  it("finds a long fact in a social body", () => {
    expect(LONG_FACT.length).toBeGreaterThan(220);
    const content = crafted({
      body: `${LONG_FACT} Shop the lamp.`,
      claims: [{ text: LONG_FACT, kind: "fact", factId: "f2" }],
    });
    expect(copyCraftProblems(content)).toEqual([FACT_TOO_LONG_FOR_SOCIAL]);
    const instruction = copyCraftInstruction(content, [
      FACT_TOO_LONG_FOR_SOCIAL,
    ]);
    expect(instruction).toContain(LONG_FACT.slice(0, 40));
    expect(instruction).toContain(`${LONG_FACT.length} characters`);
  });

  it("names a missing core message", () => {
    expect(copyCraftProblems(crafted({ coreMessage: undefined }))).toEqual([
      CORE_MESSAGE_MISSING,
    ]);
    expect(copyCraftProblems(crafted({ coreMessage: "  " }))).toEqual([
      CORE_MESSAGE_MISSING,
    ]);
    expect(copyCraftInstruction(crafted(), [CORE_MESSAGE_MISSING])).toContain(
      "coreMessage",
    );
  });

  it("checks nothing without copy craft", () => {
    expect(
      copyCraftProblems(
        crafted({
          copyCraft: undefined,
          coreMessage: undefined,
          claims: [{ text: LONG_FACT, kind: "fact", factId: "f2" }],
        }),
      ),
    ).toEqual([]);
    // A long fact is fine outside social posts.
    expect(
      copyCraftProblems(
        crafted({
          type: "blog",
          claims: [{ text: LONG_FACT, kind: "fact", factId: "f2" }],
        }),
      ),
    ).toEqual([]);
  });
});
