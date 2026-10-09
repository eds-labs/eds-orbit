/**
 * The review eval set (`review-v1.json`): its schema, shared by the offline
 * replay and the live runner. Pure: no database, no provider.
 */
import { z } from "zod";

export const CATEGORIES = [
  "wrong_number",
  "profit_promise",
  "investment_advice",
  "disallowed_link",
  "off_brand_tone",
  "repeated_post",
] as const;

export const reviewCase = z
  .object({
    id: z.string().min(1),
    label: z.enum(["good", "bad"]),
    category: z.enum(["good", ...CATEGORIES]),
    body: z.string().min(1).max(280),
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

const reviewSet = z
  .object({
    datasetVersion: z.literal("agents-review-v1"),
    description: z.string().min(1),
    cases: z.array(reviewCase).min(20),
  })
  .strict()
  .refine(
    (set) => new Set(set.cases.map((c) => c.id)).size === set.cases.length,
    { message: "DUPLICATE_CASE_ID" },
  );
export type ReviewSet = z.infer<typeof reviewSet>;

export function parseReviewSet(raw: unknown): ReviewSet {
  return reviewSet.parse(raw);
}

/** A bad case the set expects to be left for the owner: the bare host. */
export const isBareHost = (c: Pick<ReviewCase, "label" | "expected">) =>
  c.label === "bad" && c.expected.verdict === "owner";
