/**
 * The vision eval set (`vision-v1.json`): its schema, shared by the offline
 * replay, the planner and the live harness. Every case is a creative
 * composed for free from the offline fixtures (`fixtureArt`, the demo brands
 * Lumora Home and Kestrel Analytics) in the set's one format. `brand` is the
 * project's brand at review time (the brief the model reads); `kitBrand` is
 * the brand kit (palette, fonts, logo) the creative is composed with, and the
 * art is drawn for `brand`. The recorded answers are hand-written replays of
 * the expected verdict, decided by production's `visionVerdict`.
 */
import { z } from "zod";
import {
  CREATIVE_TEMPLATE_IDS,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
} from "../../packages/creative/src/index.ts";
import type {
  DemoBrandName,
  FixtureArtKind,
} from "../../packages/creative/fixtures/demo-brands.ts";
import {
  visionAnswer,
  visionVerdict,
} from "../../apps/api/src/modules/marketing/creative/vision-review.ts";

export const VISION_BRANDS = [
  "lumora",
  "kestrel",
] as const satisfies readonly DemoBrandName[];
export const FIXTURE_ART_KINDS = [
  "good",
  "tiny_subject",
  "flat",
  "bright",
] as const satisfies readonly FixtureArtKind[];
/** Good and bad cases the set must hold. */
const GOOD_CASES = 4;
const BAD_CASES = 4;

/** The model's answer as the vision review parses it. */
export type VisionAnswer = z.infer<typeof visionAnswer>;

const color = z.string().regex(/^#[0-9A-F]{6}$/);
const font = z.enum(["Inter", "DejaVu Sans", "Arial", "system-ui"]);
const line = (max: number) => z.string().trim().min(1).max(max);

/** A demo brand as the project shows it: name, brand kit identity, the post and its image copy. */
const visionBrand = z
  .object({
    productName: line(120),
    visualIdentity: z
      .object({
        primaryColor: color,
        secondaryColor: color,
        accentColor: color,
        backgroundColor: color,
        surfaceColor: color,
        textColor: color,
        headingFont: font,
        bodyFont: font,
        imagery: z
          .object({
            kind: z.enum(["photo", "illustration", "3d", "flat", "mixed"]),
            mood: line(300),
            subjects: line(500),
            avoid: z.array(line(200)).max(20),
          })
          .strict(),
      })
      .strict(),
    // The post the creative belongs to; its title is the creative's key message.
    post: z.object({ title: line(200), body: line(2_200) }).strict(),
    // The image copy, the same for every template the brand's cases use.
    copy: z
      .object({
        eyebrow: line(80),
        headline: line(80),
        subline: line(200),
        cta: line(40),
      })
      .strict(),
  })
  .strict();
export type VisionBrand = z.infer<typeof visionBrand>;

export const visionCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/),
    label: z.enum(["good", "bad"]),
    brand: z.enum(VISION_BRANDS),
    art: z.enum(FIXTURE_ART_KINDS),
    kitBrand: z.enum(VISION_BRANDS),
    template: z.enum(CREATIVE_TEMPLATE_IDS),
    expected: z.enum(["pass", "needs_correction"]),
    recorded: visionAnswer,
  })
  .strict();
export type VisionCase = z.infer<typeof visionCase>;

const visionSetSchema = z
  .object({
    datasetVersion: z.literal("creative-vision-v1"),
    description: z.string().min(1),
    // Every case is composed in this one format (4:5 portrait).
    format: z.literal("feed_portrait"),
    brands: z.object({ lumora: visionBrand, kestrel: visionBrand }).strict(),
    cases: z.array(visionCase).length(GOOD_CASES + BAD_CASES),
  })
  .strict()
  .superRefine((set, context) => {
    const issue = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", message, path });
    const seen = new Set<string>();
    for (const [index, c] of set.cases.entries()) {
      if (seen.has(c.id)) issue("VISION_CASE_DUPLICATE", ["cases", index]);
      seen.add(c.id);
      // A good image passes, a bad one needs correction.
      if ((c.label === "good") !== (c.expected === "pass"))
        issue("VISION_LABEL_MISMATCH", ["cases", index, "expected"]);
      // A good case is its brand's good art in its own brand kit.
      if (c.label === "good" && (c.art !== "good" || c.kitBrand !== c.brand))
        issue("VISION_GOOD_CASE_INVALID", ["cases", index]);
      // The replay must decide as the set expects (production's rule).
      if (visionVerdict(c.recorded).verdict !== c.expected)
        issue("VISION_RECORDED_MISMATCH", ["cases", index, "recorded"]);
      // The layout draws the art and needs no product image.
      const needs = TEMPLATE_NEEDS[c.template];
      if (needs.art === "none" || needs.product === "required")
        issue("VISION_TEMPLATE_UNUSABLE", ["cases", index, "template"]);
      // The brand's image copy must fit the template without being cut.
      const copy = set.brands[c.brand].copy;
      const limits = TEMPLATE_COPY_LIMITS[c.template];
      if (
        copy.eyebrow.length > limits.eyebrow ||
        copy.headline.length > limits.headline ||
        copy.subline.length > limits.subline ||
        copy.cta.length > limits.cta
      )
        issue("VISION_COPY_TOO_LONG", ["cases", index, "template"]);
    }
    const good = set.cases.filter((c) => c.label === "good").length;
    if (good !== GOOD_CASES || set.cases.length - good !== BAD_CASES)
      issue("VISION_CASE_COUNTS", ["cases"]);
  });
export type VisionSet = z.infer<typeof visionSetSchema>;

export function parseVisionSet(raw: unknown): VisionSet {
  return visionSetSchema.parse(raw);
}
