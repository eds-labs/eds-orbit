import { z } from "zod";
const ref = z
  .object({ id: z.uuid(), version: z.number().int().positive() })
  .strict();
const unique = <T>(items: T[]) => new Set(items).size === items.length;
/** Strategy only. Neither this contract nor its owner review starts execution. */
export const marketingPlanSpec = z
  .object({
    title: z.string().trim().min(3).max(160),
    goal: z.string().trim().min(5).max(2000),
    audience: z.string().trim().min(1).max(300),
    productScope: z.string().trim().min(1).max(300),
    channels: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(5)
      .refine(unique, "Duplicate channels"),
    campaignType: z.enum(["product", "presale"]),
    language: z.enum(["en", "de"]),
    profileVersion: z.number().int().positive(),
    policy: ref,
    pillars: z
      .array(
        z
          .object({
            title: z.string().min(1).max(120),
            angle: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    cta: z
      .object({
        label: z.string().min(1).max(200),
        url: z.url(),
        factId: z.uuid(),
      })
      .strict(),
    facts: z
      .array(ref)
      .min(1)
      .max(20)
      .refine(
        (items) => unique(items.map((item) => item.id)),
        "Duplicate facts",
      ),
    sourceRefs: z.array(ref).max(20).default([]),
    horizon: z
      .object({ startAt: z.iso.datetime(), endAt: z.iso.datetime() })
      .strict()
      .refine((h) => {
        const days = (Date.parse(h.endAt) - Date.parse(h.startAt)) / 86400000;
        return days > 0 && days <= 90;
      }, "Horizon must be finite and at most 90 days"),
    timezone: z.string().min(1).max(80),
    cadence: z
      .object({
        rhythm: z.enum(["daily", "weekly"]),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(unique),
        times: z
          .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
          .min(1)
          .max(3)
          .refine(unique),
      })
      .strict()
      .refine(
        (c) =>
          c.rhythm === "weekly"
            ? c.weekdays.length > 0
            : c.weekdays.length === 0,
        "Invalid cadence",
      ),
    contentTypes: z
      .array(z.enum(["social", "blog", "newsletter"]))
      .min(1)
      .max(3)
      .refine(unique),
    kpis: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            unit: z.enum([
              "impressions",
              "clicks",
              "sessions",
              "conversions",
              "USD",
            ]),
            baselineState: z.enum(["no_data", "measured"]),
            metricRefs: z.array(ref).max(10),
          })
          .strict()
          .refine(
            (k) =>
              k.baselineState === "measured"
                ? k.metricRefs.length > 0
                : k.metricRefs.length === 0,
            "Measured baselines require stored metrics",
          ),
      )
      .min(1)
      .max(8),
    existingWork: z
      .array(
        z
          .object({
            kind: z.enum(["assignments", "missions"]),
            id: z.uuid(),
            version: z.number().int().positive(),
            proposedChange: z.string().max(1000),
          })
          .strict(),
      )
      .max(20)
      .refine(
        (items) => unique(items.map((item) => item.id)),
        "Duplicate work links",
      ),
    approvalMode: z
      .enum(["human_each", "delegated_review"])
      .default("human_each"),
    delivery: z.enum(["publish", "postiz_draft"]).default("publish"),
    creative: z
      .object({ image: z.boolean(), styleAssetIds: z.array(z.uuid()).max(5) })
      .strict(),
    monthlyBudgetMicros: z.number().int().min(0).max(10_000_000_000),
    assumptions: z.array(z.string().min(1).max(500)).max(10),
    unknowns: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict();
export type MarketingPlanSpec = z.infer<typeof marketingPlanSpec>;
export const marketingPlanChange = z
  .object({ version: z.number().int().positive(), spec: marketingPlanSpec })
  .strict();
export const marketingPlanReview = z
  .object({
    planId: z.uuid(),
    revision: z.number().int().positive(),
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    spec: marketingPlanSpec,
    sourceSnapshot: z.array(ref).max(40),
  })
  .strict();
export const marketingPlanView = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    specHash: z.string(),
    spec: marketingPlanSpec,
    sourceSnapshot: z.array(ref).max(40),
    status: z.enum(["proposed", "blocked", "active", "paused", "completed"]),
    blockers: z.array(z.string()),
    strategicallyReviewed: z.boolean(),
    reviewedAt: z.iso.datetime().nullable(),
    activationAvailable: z.boolean(),
    activation: z.record(z.string(), z.json()).nullable(),
    activationRequest: z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        packageHash: z.string(),
        status: z.string(),
        expiresAt: z.string(),
        payload: z.record(z.string(), z.json()),
      })
      .strict()
      .nullable(),
    linkedWork: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(["assignments", "missions"]),
            owned: z.boolean().optional(),
            expectedVersion: z.number().int(),
            currentVersion: z.number().int().nullable(),
            title: z.string().nullable(),
            status: z.string().nullable(),
            href: z.string(),
            latestRun: z
              .object({
                id: z.uuid(),
                status: z.string(),
                costMicros: z.number(),
                deliveries: z
                  .array(
                    z
                      .object({
                        id: z.uuid(),
                        kind: z.string(),
                        status: z.string(),
                        remoteId: z.string().nullable(),
                      })
                      .strict(),
                  )
                  .max(32)
                  .optional(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(26),
    actionRequest: z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        packageHash: z.string(),
        status: z.string(),
        expiresAt: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MarketingPlanView = z.infer<typeof marketingPlanView>;
