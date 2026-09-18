import { z } from "zod";
export const id = z.uuid();
export const role = z.enum(["owner", "editor", "viewer"]);
export const collections = [
  "sources",
  "facts",
  "evidence",
  "content",
  "missions",
  "jobs",
  "publications",
  "policies",
  "approvals",
  "metrics",
  "insights",
  "preferences",
  "exceptions",
  "connectors",
  "assets",
  "experiments",
  "calendar_blocks",
  "connector_verifications",
  "index_evaluations",
  "work_packages",
  "followup_plans",
  "knowledge_imports",
  "community_questions",
  "community_groups",
] as const;
export const collection = z.enum(collections);
export const source = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(["manual", "file", "website", "gitbook"]),
    publicUse: z.boolean().default(false),
    modelUse: z.boolean().default(false),
    authority: z
      .enum(["official", "website", "research", "generated"])
      .default("research"),
    maxAgeHours: z.number().int().min(1).max(8760).default(168),
    allowedOrigins: z.array(z.url()).max(20).default([]),
    allowedPaths: z.array(z.string().max(400)).max(20).default(["/"]),
    syncEveryHours: z.number().int().min(1).max(168).optional(),
    status: z.literal("active").default("active"),
    generation: z.literal(1).default(1),
  })
  .strict();
export const mission = z
  .object({
    title: z.string().min(3).max(160),
    goal: z.string().min(5).max(2000),
    audience: z.string().min(1).max(300),
    product: z.string().max(300).default(""),
    allowedTopics: z.array(z.string().min(1).max(200)).max(20).default([]),
    allowedActions: z
      .array(z.enum(["draft", "review", "publish_test", "publish_live"]))
      .min(1)
      .max(4)
      .default(["draft", "review", "publish_test"]),
    language: z.enum(["en", "de"]).default("en"),
    channels: z.array(z.string().min(1).max(80)).min(1).max(10),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    maxContents: z.number().int().min(1).max(30),
    targetAction: z.string().max(300),
    targetValue: z.number().nonnegative().optional(),
    sourceIds: z.array(id).max(30).default([]),
    contentType: z
      .enum(["social", "blog", "newsletter", "ad", "script", "community"])
      .default("social"),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, { message: "End must follow start" });
export const content = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(40000),
    type: z.enum(["social", "blog", "newsletter", "ad", "script", "community"]),
    language: z.enum(["en", "de"]).default("en"),
    channel: z.string().min(1).max(80),
    missionId: id.optional(),
    evidenceId: id,
    claims: z
      .array(
        z.object({
          text: z.string().min(1).max(2000),
          factId: id.optional(),
          chunkId: z.string().max(100).optional(),
          kind: z.enum(["fact", "quote", "style"]),
        }),
      )
      .max(100),
    targetUrl: z.url().optional(),
    assetId: id.optional(),
    scheduledAt: z.iso.datetime().optional(),
    description: z.string().max(500).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(120)
      .optional(),
    outline: z.array(z.string().max(300)).max(20).optional(),
    internalLinks: z.array(z.url()).max(20).optional(),
    altTexts: z.array(z.string().max(500)).max(10).optional(),
    newsletter: z
      .object({
        subjects: z.array(z.string().min(1).max(200)).min(1).max(5),
        preview: z.string().max(300),
        segmentRef: z.string().max(200),
        consentRef: z.string().max(200),
        suppressionRef: z.string().max(200),
      })
      .strict()
      .optional(),
    risk: z.enum(["routine", "sensitive"]).default("routine"),
  })
  .strict();
export const policy = z
  .object({
    mode: z.enum(["observe", "assisted", "autopilot"]),
    channels: z.array(z.string().max(80)).max(20),
    contentTypes: z
      .array(z.enum(["social", "blog", "newsletter", "script", "community"]))
      .max(5),
    allowedOrigins: z.array(z.url()).max(20),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    maxPerDay: z.number().int().min(0).max(20),
    minIntervalMinutes: z.number().int().min(1).max(1440),
    dailyBudgetMicros: z.number().int().min(0).max(1000000000),
    monthlyBudgetMicros: z.number().int().min(0).max(10000000000),
    perRunBudgetMicros: z.number().int().min(0).max(100000000),
    approvedPaidTests: z.boolean().default(false),
    quietStart: z.number().int().min(0).max(23).optional(),
    quietEnd: z.number().int().min(0).max(23).optional(),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, { message: "Invalid policy interval" });
export const metric = z
  .object({
    source: z.enum(["csv", "matomo", "postiz", "manual_test"]),
    externalId: z.string().min(1).max(200),
    campaign: z.string().max(200),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    timezone: z.string().max(80),
    currency: z.string().regex(/^[A-Z]{3}$/),
    impressions: z.number().int().nonnegative().nullable(),
    clicks: z.number().int().nonnegative().nullable(),
    sessions: z.number().int().nonnegative().nullable(),
    conversions: z.number().int().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().nullable(),
    sampleSize: z.number().int().nonnegative(),
    synthetic: z.boolean().default(false),
  })
  .strict();
export const preference = z
  .object({
    name: z.string().min(1).max(200),
    rule: z.string().min(1).max(2000),
    validUntil: z.iso.datetime(),
    status: z.enum(["proposed", "confirmed", "disabled"]).default("proposed"),
  })
  .strict();
export const experiment = z
  .object({
    name: z.string().min(1).max(200),
    hypothesis: z.string().min(1).max(2000),
    variants: z.array(z.string().max(200)).min(2).max(5),
    primaryMetric: z.enum(["clicks", "sessions", "conversions"]),
    minimumSample: z.number().int().min(30),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    stopRule: z.string().min(5).max(500),
  })
  .strict();
export type ContentInput = z.infer<typeof content>;
export type PolicyInput = z.infer<typeof policy>;
export type Scope = {
  workspaceId: string;
  projectId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
};
export type EntityView = {
  id: string;
  workspaceId: string;
  projectId: string;
  kind: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
