import { z } from "zod";
import { AGENT_CONTENT_LANGUAGES, languageCode } from "./project-settings.js";
export const id = z.uuid();
export const role = z.enum(["owner", "editor", "viewer"]);
// Generic entity routes read only these kinds. `telegram_connections` (the
// Orbit Telegram bot credential) is deliberately not one of them.
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
  "postiz_drafts",
  "matomo_schedules",
  "postiz_queue_watch",
  "assignments",
  // Assignment runs and agent tasks are internal: read through run_status and the agent runs page.
  "channel_posts",
  "channel_post_sync",
] as const;
export const collection = z.enum(collections);
/**
 * Who may retrieve a source (WP3.5): `"all"` or the modules named. Module
 * ids are listed here, not read from the registry, so a source can be
 * prepared for a module before it is enabled (support, WP5.6).
 */
export const knowledgeAudience = z.enum(["all", "marketing", "support"]);
export const sourceAudiences = z
  .array(knowledgeAudience)
  .min(1)
  .max(3)
  .refine((a) => new Set(a).size === a.length, "duplicate audience")
  .refine(
    (a) => !a.includes("all") || a.length === 1,
    '"all" cannot be combined with modules',
  );
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
    // Absent means all modules, the shape every existing source has.
    audiences: sourceAudiences.optional(),
    status: z.literal("active").default("active"),
    generation: z.literal(1).default(1),
  })
  .strict();
export const marketingTopic = z
  .object({
    topic: z.string().trim().min(1).max(2000),
    angle: z.string().trim().min(1).max(2000),
    pillar: z.string().trim().max(200).optional(),
  })
  .strict();
export const mission = z
  .object({
    title: z.string().min(3).max(160),
    goal: z.string().min(5).max(2000),
    audience: z.string().min(1).max(300),
    product: z.string().max(300).default(""),
    novelty: marketingTopic.optional(),
    allowedTopics: z.array(z.string().min(1).max(200)).max(20).default([]),
    allowedActions: z
      .array(z.enum(["draft", "review", "publish_test", "publish_live"]))
      .min(1)
      .max(4)
      .default(["draft", "review", "publish_test"]),
    language: languageCode.default("en"),
    channels: z.array(z.string().min(1).max(80)).min(1).max(10),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    maxContents: z.number().int().min(1).max(30),
    targetAction: z.string().max(300),
    targetUrl: z.url().optional(),
    targetValue: z.number().nonnegative().optional(),
    sourceIds: z.array(id).max(30).default([]),
    assetIds: z.array(id).max(10).default([]),
    contentType: z
      .enum(["social", "blog", "newsletter", "ad", "script", "community"])
      .default("social"),
    campaignType: z.enum(["product", "presale"]).optional(),
    profileVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, { message: "End must follow start" });
export const content = z
  .object({
    novelty: marketingTopic.optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(40000),
    type: z.enum(["social", "blog", "newsletter", "ad", "script", "community"]),
    language: languageCode.default("en"),
    channel: z.string().min(1).max(80),
    missionId: id.optional(),
    campaignType: z.enum(["product", "presale"]).optional(),
    profileVersion: z.number().int().positive().optional(),
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
/**
 * The project's AI spending authority (ADR 0015): the limits every paid
 * model call of every module is reserved against. Platform-owned; the
 * Marketing policy keeps only publishing rules.
 */
export const aiSpendPolicy = z
  .object({
    profile: z
      .enum(["off", "test", "normal", "monthly", "custom"])
      .default("custom"),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    approvedPaidUse: z.boolean().default(false),
    dailyBudgetMicros: z.number().int().min(0).max(1000000000),
    monthlyBudgetMicros: z.number().int().min(0).max(10000000000),
    perRunBudgetMicros: z.number().int().min(0).max(100000000),
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
const brandColor = z.string().regex(/^#[0-9A-F]{6}$/i);
export const visualIdentity = z
  .object({
    primaryColor: brandColor.default("#0969FF"),
    secondaryColor: brandColor.default("#254D66"),
    accentColor: brandColor.default("#45C2FF"),
    backgroundColor: brandColor.default("#F6FBFF"),
    surfaceColor: brandColor.default("#FFFFFF"),
    textColor: brandColor.default("#071522"),
    headingFont: z
      .enum(["Inter", "DejaVu Sans", "Arial", "system-ui"])
      .default("Inter"),
    bodyFont: z
      .enum(["Inter", "DejaVu Sans", "Arial", "system-ui"])
      .default("Inter"),
    logoAssetId: id.optional(),
    designRules: z
      .array(z.string().min(1).max(300))
      .max(20)
      .default(["Preserve the approved logo unchanged."]),
  })
  .strict();
/** Campaign types a project can run; presale only where it is enabled. */
export const CAMPAIGN_TYPES = ["product", "presale"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/**
 * The campaign types a profile enables. Profiles saved before the explicit
 * list keep what they could do: presale with a stored presale strategy
 * (that field used to be required for every project), product otherwise.
 */
export function enabledCampaignTypes(profile: {
  campaignTypes?: readonly CampaignType[];
  presaleStrategy?: string;
}): CampaignType[] {
  if (profile.campaignTypes?.length) return [...profile.campaignTypes];
  return profile.presaleStrategy ? ["product", "presale"] : ["product"];
}

/** Profile fields only some campaign types need. */
export const CAMPAIGN_TYPE_FIELDS: Readonly<Record<CampaignType, readonly string[]>> = {
  product: ["productStrategy"],
  presale: ["presaleStrategy"],
};

export const marketingProfile = z
  .object({
    productName: z.string().min(1).max(300),
    // The language automatic Marketing agents write in (English or German,
    // decision 2026-10-23); manual missions may use any project language.
    contentLanguage: z.enum(AGENT_CONTENT_LANGUAGES),
    internalLanguage: z.enum(["en", "de"]),
    audience: z.string().min(1).max(2000),
    positioning: z.string().min(1).max(2000),
    // Which campaign types the project runs (absent: see enabledCampaignTypes).
    campaignTypes: z
      .array(z.enum(CAMPAIGN_TYPES))
      .min(1)
      .max(CAMPAIGN_TYPES.length)
      .refine((types) => new Set(types).size === types.length, "duplicate")
      .optional(),
    productStrategy: z.string().min(1).max(4000).optional(),
    // Required only while presale campaigns are enabled; kept when disabled.
    presaleStrategy: z.string().min(1).max(4000).optional(),
    voice: z.array(z.string().min(1).max(300)).min(1).max(30),
    guardrails: z.array(z.string().min(1).max(500)).min(1).max(50),
    primaryCtas: z.array(z.string().min(1).max(200)).min(1).max(20),
    channelPriority: z.array(z.string().min(1).max(80)).min(1).max(10),
    notificationPreference: z.enum(["telegram", "slack", "none"]),
    officialLinks: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            url: z.url(),
            factId: id,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    visualIdentity: visualIdentity.default({
      primaryColor: "#0969FF",
      secondaryColor: "#254D66",
      accentColor: "#45C2FF",
      backgroundColor: "#F6FBFF",
      surfaceColor: "#FFFFFF",
      textColor: "#071522",
      headingFont: "Inter",
      bodyFont: "Inter",
      designRules: ["Preserve the approved logo unchanged."],
    }),
    assetPolicy: z.enum(["approved_only"]),
    // Lower-case words of the product's name that a fact sentence may
    // contain without adding a claim (WP3.4). Absent: uLiquid's built-in list.
    brandTerms: z
      .array(z.string().regex(/^[\p{Ll}\p{N}]{2,40}$/u))
      .min(1)
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    // A field is required exactly when an enabled campaign type uses it.
    for (const type of enabledCampaignTypes(profile))
      for (const field of CAMPAIGN_TYPE_FIELDS[type])
        if (!profile[field as keyof typeof profile])
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "REQUIRED_FOR_CAMPAIGN_TYPE",
          });
  });

/**
 * Which profile fields are required, optional or not used for this
 * profile's campaign types, for forms and the MCP configuration view.
 */
export function marketingProfileRequirements(profile: {
  campaignTypes?: readonly CampaignType[];
  presaleStrategy?: string;
}) {
  const enabled = enabledCampaignTypes(profile);
  const typeFields = new Set(Object.values(CAMPAIGN_TYPE_FIELDS).flat());
  const used = new Set(enabled.flatMap((t) => CAMPAIGN_TYPE_FIELDS[t]));
  const fields: Record<string, "required" | "optional" | "not_used"> = {};
  for (const [name, schema] of Object.entries(marketingProfile.shape))
    fields[name] = typeFields.has(name)
      ? used.has(name)
        ? "required"
        : "not_used"
      : schema.safeParse(undefined).success
        ? "optional"
        : "required";
  return { campaignTypes: enabled, fields };
}
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
  /** The member's roles in single modules (WP4.5); absent without overrides. */
  moduleRoles?: Readonly<Record<string, "editor" | "viewer" | "none">>;
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

export * from "./project-settings.js";
export {
  marketingPlanSpec,
  marketingPlanChange,
  marketingPlanReview,
  marketingPlanView,
  type MarketingPlanSpec,
  type MarketingPlanView,
} from "./marketing-plan.js";
