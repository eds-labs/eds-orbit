/**
 * The review eval set (`review-v3.json`; `review-v2.json` and
 * `review-v1.json` stay as the records of earlier live runs): its schema,
 * shared by the offline replay and the live runner. No database, no
 * provider: the image copy check is the production parser.
 */
import { z } from "zod";
import { TEMPLATE_COPY_LIMITS } from "../../packages/creative/src/index.ts";
import { parsedCreativeCopy } from "../../apps/api/src/modules/marketing/creative/copy-checks.ts";

export const CATEGORIES = [
  "wrong_number",
  "profit_promise",
  "investment_advice",
  "disallowed_link",
  "off_brand_tone",
  "repeated_post",
  "unbacked_claim",
  // v3: image copy (Creative Studio) that breaks a rule, with or without the body.
  "image_copy_wrong_number",
  "image_copy_profit_promise",
  "image_copy_contradiction",
  "image_copy_unbacked_claim",
  "image_copy_off_brand_tone",
] as const;

/** The creative categories of v3: every one is rejected or blocked, never approved. */
export const IMAGE_COPY_CATEGORIES = CATEGORIES.filter((category) =>
  category.startsWith("image_copy_"),
);

/**
 * The creative template the eval composes every creative in (its brand kit
 * enables only this one); a case's image copy must fit its limits.
 */
export const CREATIVE_TEMPLATE = "lifestyle" as const;

// Instagram's caption limit, the longest post the set carries.
const BODY_MAX = 2_200;

export const reviewCase = z
  .object({
    id: z.string().min(1),
    label: z.enum(["good", "bad"]),
    category: z.enum(["good", ...CATEGORIES]),
    // One of the set's brands; absent: its first brand.
    brand: z.string().min(1).optional(),
    body: z.string().min(1).max(BODY_MAX),
    // The image copy as a content stores it (`creativeCopy`): the case gets a
    // creative composed from it, which the review judges with the body.
    creativeCopy: z
      .unknown()
      .optional()
      .refine(
        (value) => {
          if (value === undefined) return true;
          const copy = parsedCreativeCopy(value);
          const limits = TEMPLATE_COPY_LIMITS[CREATIVE_TEMPLATE];
          return (
            copy !== null &&
            copy.headline.trim().length > 0 &&
            copy.headline.length <= limits.headline &&
            (copy.eyebrow ?? "").length <= limits.eyebrow &&
            (copy.subline ?? "").length <= limits.subline &&
            (copy.cta ?? "").length <= limits.cta
          );
        },
        { message: "CREATIVE_COPY_INVALID" },
      ),
    channelHistory: z.array(z.string().min(1)).optional(),
    recorded: z
      .object({
        verdict: z.enum(["approve", "revise", "reject"]),
        reasons: z.array(z.string()),
      })
      .strict(),
    expected: z
      .object({
        // `owner`: never approved, left unjudged for the owner (needs_review).
        verdict: z.enum(["approve", "reject", "owner"]),
        deterministic: z.array(z.string()),
        modelSees: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ReviewCase = z.infer<typeof reviewCase>;

/**
 * The strategy brief every case's draft answers. It must match the drafts:
 * the review checks that a draft follows its brief, so a brief the drafts
 * do not follow makes every case fail for that reason alone. `topic`
 * replaces the harness's default topic (v3, for a brand in another
 * language); absent, the topic names the slot as in v2.
 */
export const reviewBrief = z
  .object({
    topic: z.string().min(1).optional(),
    angle: z.string().min(1),
    cta: z.string().min(1),
    notARepeatBecause: z.string().min(1),
  })
  .strict();
export type ReviewBrief = z.infer<typeof reviewBrief>;

/** The fields of a brand's marketing profile the review sees; the rest stays the synthetic project's. */
export const brandProfile = z
  .object({
    productName: z.string().min(1),
    contentLanguage: z.string().min(2),
    audience: z.string().min(1),
    positioning: z.string().min(1),
    voice: z.array(z.string().min(1)).min(1),
    guardrails: z.array(z.string().min(1)).min(1),
    primaryCtas: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type BrandProfile = z.infer<typeof brandProfile>;

/** A verified text fact of a brand, in its content language. */
export const brandFact = z
  .object({ key: z.string().min(1), value: z.string().min(1) })
  .strict();
export type BrandFact = z.infer<typeof brandFact>;

/**
 * The assignment fields the review sees (`assignment` in its input). Absent:
 * the harness's synthetic assignment, as in v2.
 */
export const brandAssignment = z
  .object({
    name: z.string().min(1),
    topicFrame: z.string().min(1),
    tone: z.string().min(1),
  })
  .strict();

/** One synthetic brand: its own project, profile, facts, assignment and brief. */
export const reviewBrand = z
  .object({
    profile: brandProfile,
    facts: z.array(brandFact).min(1),
    assignment: brandAssignment.optional(),
    brief: reviewBrief,
  })
  .strict();
export type ReviewBrand = z.infer<typeof reviewBrand>;
export type ReviewBrands = Record<string, ReviewBrand>;

/**
 * The synthetic brand of v2: the profile and the fact the synthetic package
 * project creates (`createPackageProject`). v2 names only its brief.
 */
export const V2_BRAND: Omit<ReviewBrand, "brief"> = {
  profile: {
    productName: "Synthetic Orbit",
    contentLanguage: "en",
    audience: "Product teams",
    positioning: "Test only",
    voice: ["clear"],
    guardrails: ["No unsupported claims"],
    primaryCtas: ["Learn more."],
  },
  facts: [{ key: "beta.access", value: "open for product teams" }],
};

const uniqueIds = (cases: ReviewCase[]) =>
  new Set(cases.map((c) => c.id)).size === cases.length;

const v2Set = z
  .object({
    datasetVersion: z.literal("agents-review-v2"),
    description: z.string().min(1),
    brief: reviewBrief,
    cases: z.array(reviewCase).min(20),
  })
  .strict();

const v3Set = z
  .object({
    datasetVersion: z.literal("agents-review-v3"),
    description: z.string().min(1),
    brands: z
      .record(z.string().min(1), reviewBrand)
      .refine((brands) => Object.keys(brands).length > 0),
    cases: z.array(reviewCase).min(20),
  })
  .strict();

const reviewSet = z
  .discriminatedUnion("datasetVersion", [v2Set, v3Set])
  .refine((set) => uniqueIds(set.cases), { message: "DUPLICATE_CASE_ID" })
  .refine(
    (set) =>
      set.datasetVersion === "agents-review-v2" ||
      set.cases.every((c) => !c.brand || Object.hasOwn(set.brands, c.brand)),
    { message: "UNKNOWN_BRAND" },
  );

/** A parsed set: v2 is read as one brand, `en`, with its brief. */
export type ReviewSet = {
  datasetVersion: "agents-review-v2" | "agents-review-v3";
  description: string;
  brands: ReviewBrands;
  cases: ReviewCase[];
};

export function parseReviewSet(raw: unknown): ReviewSet {
  const set = reviewSet.parse(raw);
  if (set.datasetVersion === "agents-review-v2")
    return {
      datasetVersion: set.datasetVersion,
      description: set.description,
      brands: { en: { ...V2_BRAND, brief: set.brief } },
      cases: set.cases,
    };
  return set;
}

/** The brand a case belongs to: its own, else the set's first. */
export function caseBrand(
  set: Pick<ReviewSet, "brands">,
  c: Pick<ReviewCase, "brand">,
): string {
  return c.brand ?? Object.keys(set.brands)[0]!;
}

/** A bad case the set expects to be left for the owner: the bare host. */
export const isBareHost = (c: Pick<ReviewCase, "label" | "expected">) =>
  c.label === "bad" && c.expected.verdict === "owner";
