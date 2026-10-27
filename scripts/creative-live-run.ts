/**
 * Creative Studio live acceptance run (plan Task 22, acceptance test A with
 * real art) for the fictional demo brands Lumora Home and Kestrel Analytics.
 * In-process, on this worktree's isolated local test database only
 * (`.runtime/test.env`, scripts/test-db-for-worktree.ts); no HTTP server, no
 * worker, no external write.
 *
 * Default: a free dry run. Before the API is loaded every AI provider key and
 * route variable (OPENAI_*, ANTHROPIC_*) is removed (R62); only the non-secret
 * model, price and image route values below are set again, never a key. Each
 * brand gets a seeded project and one lifestyle creative over a free
 * brand-coloured placeholder art; the script prints what `--pay` would send:
 * the image model and source size, the exact art prompt (`artPrompt` of the
 * stored brief, wrapped by `buildBrandImagePrompt` as the image path does),
 * reference images (none), the confirmation, and the vision review request
 * (captured by a stub that sends nothing) with its reserved estimate.
 *
 * `--pay`: needs OPENAI_API_KEY in the launch environment (never printed,
 * logged or stored: the projects have no saved AI configuration, so the
 * runtime uses the environment fallback). Per brand exactly one paid image
 * (`maxArtCorrections: 0`, the generator refuses a second call), the owner's
 * rights approval of the art (with provider use) through the `asset-status`
 * action, a free recomposition and one vision review. No paid call is ever
 * retried; any error stops the run. Output: `.runtime/creative-live-run/`
 * (PNGs and result.json), kept after the seeded projects are removed.
 *
 * The vision review's task class `creative_review` uses the standard tier,
 * which the environment fallback cannot set (no tier or task route
 * variable): this process sets the default tier map's `standard` to
 * gpt-6.1-sol (catalog price) and verifies the resolved route per project
 * before any call; the cleanup restores it.
 *
 * Cost limits: per project a Marketing policy and an AI spending authority of
 * USD 1/month, 1/day, 0.50/run for 2 hours; across both brands a script cap
 * of USD 1 checked from the ceilings before every paid call; brand 2 is
 * skipped when brand 1 used more than USD 0.60.
 *
 *   node scripts/test-db-for-worktree.ts                     (once, after new migrations)
 *   node --import tsx scripts/creative-live-run.ts           (dry run, free)
 *   OPENAI_API_KEY=... node --import tsx scripts/creative-live-run.ts --pay
 *
 * `.runtime/local.env` (this worktree's, else the main checkout's) supplies
 * the remaining local settings; it never overrides the launch environment.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clearProviderAccess } from "./provider-free-env.ts";
import { loadWorktreeTestEnv } from "./test-database.ts";

export const IMAGE_MODEL = "gpt-image-2.5-flare";
export const REVIEW_MODEL = "gpt-6.1-sol";
/** Across both brands: images and reviews together, checked before each paid call. */
export const SCRIPT_CAP_MICROS = 1_000_000;
/** The script's ceiling per vision review; its reserved estimate must stay below it. */
export const REVIEW_CEILING_MICROS = 100_000;
/** Brand 2 runs only while brand 1 used at most this much. */
export const BRAND_STOP_MICROS = 600_000;
/** Each seeded project's AI spending limits (Marketing policy and platform record). */
export const PROJECT_LIMITS = {
  monthlyBudgetMicros: 1_000_000,
  dailyBudgetMicros: 1_000_000,
  perRunBudgetMicros: 500_000,
};
const WINDOW_MS = 2 * 3600_000;
const X_CHANNEL = "x-live-run";
const BRANDS = ["lumora", "kestrel"] as const;
type BrandName = (typeof BRANDS)[number];

// The image copy of acceptance test A (apps/api/tests/creative-acceptance.integration.test.ts).
export const COPY: Record<BrandName, Record<string, string>> = {
  lumora: {
    eyebrow: "New this autumn",
    headline: "Evenings feel softer in warm light",
    subline:
      "Lamps, throws and textures that turn any room into a calm retreat.",
    cta: "Shop the collection",
  },
  kestrel: {
    eyebrow: "Weekly insight",
    headline: "See every metric that moves your team",
    subline:
      "Dashboards that update themselves, so Monday starts with answers.",
    cta: "Start free trial",
  },
};
// Kestrel's visual identity as in the acceptance test, plus imagery notes so
// the paid art has a concrete motif (the test's identity has none).
const KESTREL_IDENTITY = {
  primaryColor: "#0F4C5C",
  secondaryColor: "#082F38",
  accentColor: "#B5E655",
  backgroundColor: "#F2F6F5",
  surfaceColor: "#FFFFFF",
  textColor: "#0B1F24",
  headingFont: "DejaVu Sans",
  bodyFont: "DejaVu Sans",
  designRules: ["Preserve the approved logo unchanged."],
  imagery: {
    kind: "3d",
    mood: "focused, confident, clear",
    subjects:
      "Abstract 3D forms that suggest data: layered translucent glass panels, rising bars and flowing light lines",
    avoid: [
      "People at laptops",
      "Screens or charts with readable numbers",
      "Generic stock office scenes",
    ],
  },
};
/** The post each creative is made for; its title is the art's motif (manual brief). */
const POSTS: Record<BrandName, { title: string; body: string }> = {
  lumora: {
    title: "Evenings feel softer in warm light",
    body: "Evenings feel softer in warm light: lamps, throws and textures for a calm retreat. Shop the collection.",
  },
  kestrel: {
    title: "Clarity rises from your data",
    body: "See every metric that moves your team with dashboards that update themselves. Start free trial.",
  },
};
/** The brand kit's creative settings: one paid image per brand at most, review on. */
const CREATIVE_SETTINGS = {
  enabled: true,
  maxArtCorrections: 0,
  visualReview: true,
} as const;

const usd = (micros: number) => (micros / 1_000_000).toFixed(6);

/** A database URL on this machine only. */
export function assertLocalDatabase(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is not set`);
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
    throw new Error(
      `REFUSED: ${name} points at ${host}; this script runs on a local database only`,
    );
}

const DATABASE_KEYS = [
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TEST_DATABASE_URL",
  "TEST_AUTH_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
] as const;

/**
 * The non-secret settings both modes run with: the verified models, the
 * review model's catalog price and the catalog's image ceiling (R62: no key
 * among them), and every central AI layer off so nothing but the
 * environment fallback configures the projects.
 */
export function liveSettings(
  catalog: Readonly<
    Record<
      string,
      {
        rate?: Record<string, number>;
        perImageMicros?: number;
        verifiedAt: string;
      }
    >
  >,
): Record<string, string> {
  const review = catalog[REVIEW_MODEL];
  const image = catalog[IMAGE_MODEL];
  if (!review?.rate || !image?.perImageMicros)
    throw new Error("CATALOG_PRICE_MISSING");
  return {
    AI_DEFAULT_PROVIDER: "openai",
    OPENAI_VERIFIED_MODELS: `${REVIEW_MODEL},${IMAGE_MODEL}`,
    OPENAI_RATE_CARD_JSON: JSON.stringify({
      [REVIEW_MODEL]: { ...review.rate, verifiedAt: review.verifiedAt },
    }),
    OPENAI_IMAGE_MODEL: IMAGE_MODEL,
    OPENAI_IMAGE_MAX_COST_MICROS: String(image.perImageMicros),
    OPENAI_IMAGE_PRICE_VERIFIED_AT: image.verifiedAt,
    ORBIT_AI_CATALOG: "false",
    ORBIT_AI_DEFAULTS: "false",
    ORBIT_AI_ORG_BUDGET: "false",
    ORBIT_AI_KEY_RULE_V2: "false",
    ORBIT_CONNECTIONS: "false",
    ORBIT_KNOWLEDGE_SHARES: "false",
    ORBIT_IMAGE_REFERENCES: "false",
    // The strict default: the seeded platform spending authority decides.
    ORBIT_SPEND_POLICY_SOURCE: "platform",
    ORBIT_MODULES: "false",
    ORBIT_CREATIVE_STUDIO: "true",
    EXECUTION_MODE: "test",
    ENABLE_EXTERNAL_WRITES: "false",
    ENABLE_POSTIZ_DRAFTS: "false",
  };
}

/**
 * Leaves `env` with no provider access but `key` (pay mode only) and the
 * live settings: every OPENAI_* and ANTHROPIC_* variable is removed first,
 * and the central connection cutover is unset.
 */
export function applyLiveEnvironment(
  env: Record<string, string | undefined>,
  settings: Record<string, string>,
  key?: string,
) {
  clearProviderAccess(env);
  delete env.ORBIT_CONNECTIONS_CUTOVER;
  Object.assign(env, settings);
  if (key) env.OPENAI_API_KEY = key;
}

/** One paid (or stubbed) call the run made, as result.json records it. */
type ReservationRecord = {
  key: string;
  category: string;
  model: string | null;
  state: string;
  reservedMicros: number;
  settledMicros: number | null;
};

export type BrandResult = {
  brand: BrandName;
  statusPath: string[];
  creativeStatus?: string;
  qa?: { verdict: string; failedChecks: string[] };
  vision?: {
    verdict: string;
    scores: Record<string, number>;
    issues: unknown[];
  } | null;
  image: {
    model: string;
    size: string;
    quality: string;
    background: string;
    referenceImages: number;
    confirmation: Record<string, unknown>;
    artPrompt: string;
    providerPrompt: string;
    /** Pay mode: the prompt the image call received (equals providerPrompt). */
    sentPrompt?: string;
  };
  review: {
    model: string;
    maxOutputTokens: number;
    reasoningEffort: string | null;
    estimateMicros: number | null;
    image: { format: string; width: number; height: number; bytes: number };
    briefText: string;
    instructionsChars: number;
  } | null;
  reservations: ReservationRecord[];
  creativeCost?: { settledMicros: number; unknownMicros: number };
  spentMicros: number;
  files: string[];
  error?: { code: string; message: string; afterTransmission: boolean };
};

export type LiveResult = {
  mode: "dry-run" | "pay";
  startedAt: string;
  finishedAt?: string;
  capMicros: number;
  ceilings: {
    imageMicros: number;
    reviewCeilingMicros: number;
    worstCaseMicros: number;
  };
  brands: BrandResult[];
  totalSpentMicros: number;
  /** Why the run stopped early: an error (`failed`) or the brand 1 spend rule. */
  stoppedReason?: string;
  failed: boolean;
};

type ImageProvider = typeof import("../packages/ai/src/index.ts").generateImage;
type ResponseProvider = typeof import("../packages/ai/src/index.ts").respond;

export type LiveOptions = {
  pay: boolean;
  outDir: string;
  log?: (line: string) => void;
  /** Test seam: the image and response providers (default: the real ones). */
  providers?: { generate?: ImageProvider; respond?: ResponseProvider };
  capMicros?: number;
  /** Registers the cleanup for SIGINT; called once with it. */
  onCleanup?: (cleanup: () => Promise<void>) => void;
};

/** Thrown by the dry run's response stub: the request was captured, nothing sent. */
class DryRunStop extends Error {
  constructor() {
    super("DRY_RUN_NOTHING_SENT");
  }
}

/**
 * Runs both brands; the environment must already be prepared
 * (`applyLiveEnvironment`) and point at the local test database.
 */
export async function runCreativeLive(
  options: LiveOptions,
): Promise<LiveResult> {
  for (const name of DATABASE_KEYS.slice(0, 3))
    assertLocalDatabase(name, process.env[name]);
  const key = process.env.OPENAI_API_KEY;
  if (options.pay !== Boolean(key))
    throw new Error(
      options.pay
        ? "OPENAI_API_KEY_REQUIRED"
        : "DRY_RUN_WITH_PROVIDER_KEY_REFUSED",
    );
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_IMAGE_API_KEY)
    throw new Error("UNEXPECTED_PROVIDER_KEY");
  // Never print the key, whatever an error message carries.
  const redact = (text: string) =>
    key ? text.split(key).join("[redacted]") : text;
  const print = (line = "") => (options.log ?? console.log)(redact(line));
  const capMicros = options.capMicros ?? SCRIPT_CAP_MICROS;

  const ai = await import("../packages/ai/src/index.ts");
  const config = await import("../packages/config/src/index.ts");
  const { authDb, scoped } = await import("../packages/db/src/index.ts");
  const schemas = await import("../packages/schemas/src/index.ts");
  const { solidRaster, sha256Hex } =
    await import("../packages/creative/src/index.ts");
  const { demoBrand, fixtureScreenshot } =
    await import("../packages/creative/fixtures/demo-brands.ts");
  const { create, data, entity } = await import("../apps/api/src/shared.ts");
  const { registerModules } =
    await import("../apps/api/src/modules/registry.ts");
  const { saveSpendPolicy } =
    await import("../apps/api/src/platform/ai/spend-policy.ts");
  const { effectiveAiStatus, runtimeOpenAiConfiguration } =
    await import("../apps/api/src/platform/ai/openai-configuration.ts");
  const { marketingActions } =
    await import("../apps/api/src/modules/marketing/actions.ts");
  const { produceCreative, recomposeCreative } =
    await import("../apps/api/src/modules/marketing/creative/pipeline.ts");
  const { visionReviewCreative } =
    await import("../apps/api/src/modules/marketing/creative/vision-review.ts");
  const { resolveBrandKit } =
    await import("../apps/api/src/modules/marketing/creative/brand-kit.ts");
  const { briefLayout } =
    await import("../apps/api/src/modules/marketing/creative/brief.ts");
  const { artPrompt } =
    await import("../apps/api/src/modules/marketing/creative/art-direction.ts");
  const { artSize } =
    await import("../apps/api/src/modules/marketing/creative/art.ts");
  const { buildBrandImagePrompt } =
    await import("../apps/api/src/modules/marketing/brand/image-generation.ts");
  const { lumoraProfile } =
    await import("../apps/api/tests/support/creative-profile.ts");
  registerModules();

  // The vision review's task class routes to the standard tier, and the
  // environment fallback has no setting for tiers or task routes: the
  // default tier map is set for this process only, and verified below.
  const tiers = config.modelRoutes as unknown as Record<string, string>;
  const standardBefore = tiers.standard!;
  tiers.standard = REVIEW_MODEL;

  type Scope = import("../packages/schemas/src/index.ts").Scope;
  type Seeded = { name: BrandName; owner: Scope; contentId: string };
  const seeded: Seeded[] = [];
  // Everything seeded, recorded as soon as it exists, for the cleanup.
  const users: string[] = [];
  const workspaces: string[] = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    tiers.standard = standardBefore;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
  };
  options.onCleanup?.(cleanup);

  const run = <T>(scope: Scope, work: Parameters<typeof scoped<T>>[2]) =>
    scoped(scope.workspaceId, scope.projectId, work);

  /** A seeded project of one demo brand with its brand kit and a reviewed X post. */
  async function seed(name: BrandName): Promise<Seeded> {
    const label = `Creative live run ${name}`;
    const userId = randomUUID();
    users.push(userId);
    await authDb.user.create({
      data: {
        id: userId,
        name: label,
        email: `${randomUUID()}@example.invalid`,
      },
    });
    const workspace = await authDb.workspace.create({
      data: { name: label, members: { create: { userId, role: "owner" } } },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: label,
        timezone: "Europe/Berlin",
      },
    });
    const owner: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    const entry: Seeded = { name, owner, contentId: "" };
    seeded.push(entry);
    const brand = await demoBrand(name);
    const screenshot = await fixtureScreenshot(name);
    const now = Date.now();
    const startAt = new Date(now - 60_000).toISOString();
    const endAt = new Date(now + WINDOW_MS).toISOString();
    const cta = COPY[name].cta!;
    entry.contentId = await run(owner, async (tx) => {
      await create(tx, owner, "policies", {
        mode: "assisted",
        channels: [X_CHANNEL],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt,
        endAt,
        maxPerDay: 1,
        minIntervalMinutes: 60,
        ...PROJECT_LIMITS,
        approvedPaidTests: true,
        active: true,
      });
      await saveSpendPolicy(tx, owner, {
        profile: "custom",
        startAt,
        endAt,
        approvedPaidUse: true,
        ...PROJECT_LIMITS,
      });
      await create(tx, owner, "connectors", {
        provider: "postiz",
        status: "read_verified",
        channels: [
          {
            id: X_CHANNEL,
            name: "Synthetic X",
            identifier: "x",
            disabled: false,
          },
        ],
        assignedIntegrationIds: [X_CHANNEL],
      });
      const source = await create(tx, owner, "sources", {
        name: "Synthetic brand source",
        status: "active",
        publicUse: true,
        modelUse: false,
        authority: "official",
        generation: 1,
        maxAgeHours: 168,
      });
      const link = await create(tx, owner, "facts", {
        key: "official.link",
        value: "https://example.invalid",
        valueType: "url",
        language: "en",
        sourceId: source.id,
        sourceGeneration: 1,
        validFrom: startAt,
        validUntil: endAt,
        status: "verified",
        publicUse: true,
        modelUse: false,
      });
      // The brand kit's approved raster assets; the owner allows provider use (R28).
      const asset = async (type: string, bytes: Buffer) =>
        create(tx, owner, "assets", {
          name: `${brand.brandName} ${type}`,
          type,
          mime: "image/png",
          base64: bytes.toString("base64"),
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
          source: "Synthetic demo brand fixture",
          license: "Synthetic rights fixture",
          validUses: ["brand", "social"],
          usageApproved: true,
          assetStatus: "approved",
          providerUse: true,
          driveSyncStatus: "LOCAL_ONLY",
        });
      const logo = await asset("logo", brand.logos[0]!.bytes);
      await asset("screenshot", screenshot.bytes);
      const links = [
        { label: "Official", url: "https://example.invalid", factId: link.id },
      ];
      const identity = {
        logoAssetId: logo.id,
        creative: CREATIVE_SETTINGS,
      };
      const profile =
        name === "lumora"
          ? lumoraProfile(identity, {
              officialLinks: links,
              channelPriority: [X_CHANNEL],
            })
          : schemas.marketingProfile.parse({
              productName: "Kestrel Analytics",
              contentLanguage: "en",
              internalLanguage: "en",
              audience: "Product and operations teams that run on numbers",
              positioning:
                "Dashboards that keep themselves current, so teams start with answers",
              productStrategy: "Show calm, clear moments of insight",
              voice: ["clear", "confident"],
              guardrails: ["No unsupported claims"],
              primaryCtas: [cta],
              channelPriority: [X_CHANNEL],
              notificationPreference: "none",
              officialLinks: links,
              assetPolicy: "approved_only",
              visualIdentity: { ...KESTREL_IDENTITY, ...identity },
            });
      await tx.projectMarketingProfile.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          version: 1,
          data: profile as object,
        },
      });
      const mission = await create(tx, owner, "missions", {
        title: `${brand.brandName} live acceptance`,
        status: "active",
        targetAction: cta,
      });
      const evidence = await create(tx, owner, "evidence", {
        status: "ready",
        purpose: "public",
        facts: [],
        items: [],
      });
      const content = await create(tx, owner, "content", {
        ...POSTS[name],
        type: "social",
        channel: X_CHANNEL,
        status: "reviewed",
        missionId: mission.id,
        evidenceId: evidence.id,
        claims: [],
      });
      return content.id;
    });
    return entry;
  }

  /**
   * The AI configuration a project's calls use: the environment fallback
   * only (no saved row, no central layer), the verified models, and the
   * review route. Throws on anything else, before any paid call.
   */
  async function verifyRuntime(owner: Scope) {
    const runtime = await run(owner, (tx) =>
      runtimeOpenAiConfiguration(tx, owner),
    );
    const status = await run(owner, (tx) => effectiveAiStatus(tx, owner));
    const route = ai.resolveRoute("creative_review", runtime);
    const problems = [
      runtime.routeVersion !== undefined && "a saved AI configuration",
      runtime.keySources && "a central connection key",
      runtime.imageApiKey && "an image key",
      runtime.anthropicApiKey && "an Anthropic key",
      (runtime.apiKey ?? undefined) !== key && "another OpenAI key",
      status.keySources.openai !== (key ? "environment" : "none") &&
        `key source ${status.keySources.openai}`,
      [...runtime.verifiedModels].sort().join(",") !==
        [IMAGE_MODEL, REVIEW_MODEL].sort().join(",") && "other verified models",
      runtime.imageGeneration?.model !== IMAGE_MODEL && "another image model",
      route.model !== REVIEW_MODEL && `review route ${route.model}`,
    ].filter(Boolean);
    if (problems.length)
      throw new Error(`AI_CONFIGURATION_UNEXPECTED: ${problems.join(", ")}`);
    return { runtime, route };
  }

  /** The art request `planArt` makes for this creative's brief (same functions). */
  async function artRequest(
    owner: Scope,
    creative: { brief: any; options: any },
  ) {
    const kit = await run(owner, (tx) => resolveBrandKit(tx, owner));
    const layout = briefLayout(creative.brief, creative.options.logoPlacement);
    const prompt = artPrompt(creative.brief, kit.profile, layout);
    return {
      prompt,
      providerPrompt: buildBrandImagePrompt(prompt, kit.profile),
      size: artSize(IMAGE_MODEL, layout),
    };
  }

  type DbTx = import("../packages/db/src/index.ts").DbTx;
  /** Reservations of a project as the budget ledger holds them. */
  const ledgerOf = async (tx: DbTx, owner: Scope) =>
    (
      await tx.budgetReservation.findMany({
        where: { workspaceId: owner.workspaceId, projectId: owner.projectId },
        orderBy: { createdAt: "asc" },
      })
    ).map((r): ReservationRecord => ({
      key: r.key.slice(owner.projectId.length + 1),
      category: r.category,
      model: r.model,
      state: r.state,
      reservedMicros: Number(r.amountMicros),
      settledMicros: r.settledMicros === null ? null : Number(r.settledMicros),
    }));
  const reservationsOf = (owner: Scope) =>
    run(owner, (tx) => ledgerOf(tx, owner));
  /** What the ledger counts against a budget: settled, else reserved (released: 0). */
  const counted = (rows: ReservationRecord[]) =>
    rows
      .filter((r) => r.state !== "released")
      .reduce(
        (sum, r) =>
          sum +
          (r.state === "settled" ? (r.settledMicros ?? 0) : r.reservedMicros),
        0,
      );
  /**
   * Spent across every seeded project. Inside a project's transaction
   * (`inside`) that project is read through it: a second transaction of the
   * same project would wait for its advisory lock.
   */
  const spentAll = async (inside?: { tx: DbTx; owner: Scope }) => {
    let sum = 0;
    for (const project of seeded)
      sum += counted(
        inside && project.owner.projectId === inside.owner.projectId
          ? await ledgerOf(inside.tx, project.owner)
          : await reservationsOf(project.owner),
      );
    return sum;
  };

  const imageCeiling = Number(process.env.OPENAI_IMAGE_MAX_COST_MICROS);
  const worstCase = BRANDS.length * (imageCeiling + REVIEW_CEILING_MICROS);
  let imagesLeft = BRANDS.length;
  let reviewsLeft = BRANDS.length;
  /** The script cap: what was spent plus every remaining call at its ceiling. */
  async function assertCap(
    what: string,
    nextMicros: number,
    inside?: { tx: DbTx; owner: Scope },
  ) {
    const spent = await spentAll(inside);
    const remaining =
      imagesLeft * imageCeiling + reviewsLeft * REVIEW_CEILING_MICROS;
    const total = spent + Math.max(nextMicros, 0) + remaining;
    if (total > capMicros)
      throw new Error(
        `SCRIPT_COST_CAP: ${what} would allow USD ${usd(total)} > cap ${usd(capMicros)}`,
      );
  }

  const result: LiveResult = {
    mode: options.pay ? "pay" : "dry-run",
    startedAt: new Date().toISOString(),
    capMicros,
    ceilings: {
      imageMicros: imageCeiling,
      reviewCeilingMicros: REVIEW_CEILING_MICROS,
      worstCaseMicros: worstCase,
    },
    brands: [],
    totalSpentMicros: 0,
    failed: false,
  };
  mkdirSync(options.outDir, { recursive: true });
  const writeResult = () =>
    writeFileSync(
      join(options.outDir, "result.json"),
      redact(JSON.stringify(result, null, 2)) + "\n",
    );
  const confirmation = {
    confirmMaximumCostMicros: imageCeiling,
    confirmPromptMayBeSentToProvider: true as const,
  };

  print(
    `Creative Studio live acceptance run (${result.mode}) on the local test database`,
  );
  print(
    `Cost ceilings: image ${IMAGE_MODEL} USD ${usd(imageCeiling)} each (catalog perImageMicros, settled at the ceiling); vision review ${REVIEW_MODEL} at most USD ${usd(REVIEW_CEILING_MICROS)} each (script ceiling over the reserved estimate)`,
  );
  print(
    `Worst case: ${BRANDS.length} x (${usd(imageCeiling)} + ${usd(REVIEW_CEILING_MICROS)}) = USD ${usd(worstCase)}; script cap USD ${usd(capMicros)}; per project: monthly ${usd(PROJECT_LIMITS.monthlyBudgetMicros)}, daily ${usd(PROJECT_LIMITS.dailyBudgetMicros)}, per run ${usd(PROJECT_LIMITS.perRunBudgetMicros)}; brand 2 only while brand 1 <= ${usd(BRAND_STOP_MICROS)}`,
  );

  try {
    if (worstCase > capMicros)
      throw new Error(
        `SCRIPT_COST_CAP: the ceilings allow USD ${usd(worstCase)} > cap ${usd(capMicros)}`,
      );
    for (const name of BRANDS) {
      const project = await seed(name);
      const { owner } = project;
      const { route } = await verifyRuntime(owner);
      print();
      print(`== ${name} (project ${owner.projectId})`);
      print(
        `AI configuration: environment fallback only (no saved project configuration, no central connection); provider key present: ${key ? "yes (not shown)" : "no"}; review route ${route.model}, max output ${route.maxOutputTokens} tokens, reasoning effort ${route.reasoningEffort ?? "provider default"}`,
      );
      const entry: BrandResult = {
        brand: name,
        statusPath: [],
        image: {
          model: IMAGE_MODEL,
          size: "",
          quality: "medium",
          background: "opaque",
          referenceImages: 0,
          confirmation,
          artPrompt: "",
          providerPrompt: "",
        },
        review: null,
        reservations: [],
        spentMicros: 0,
        files: [],
      };
      result.brands.push(entry);
      let transmitted = false;
      const reviewRequest = async (creativeId: string) => {
        const seen: {
          estimate: number | null;
          captured?: Parameters<ResponseProvider>[0];
          calls: number;
        } = { estimate: null, calls: 0 };
        const send: ResponseProvider = async (request) => {
          if (seen.calls++) throw new Error("SECOND_REVIEW_REFUSED");
          seen.captured = request;
          if (!options.pay) throw new DryRunStop();
          transmitted = true;
          return (options.providers?.respond ?? ai.respond)(request);
        };
        const view = await visionReviewCreative(
          owner,
          creativeId,
          {
            authorize: async (tx, estimateMicros) => {
              seen.estimate = estimateMicros;
              if (estimateMicros > REVIEW_CEILING_MICROS)
                throw new Error(
                  `SCRIPT_COST_CAP: review estimate USD ${usd(estimateMicros)} > ceiling ${usd(REVIEW_CEILING_MICROS)}`,
                );
              reviewsLeft--;
              await assertCap("the vision review", estimateMicros, {
                tx,
                owner,
              });
            },
          },
          { respond: send },
        ).catch((error) => {
          // The dry run's stub stops the review once its request is captured.
          if (!options.pay && seen.captured) return null;
          throw error;
        });
        return { view, estimate: seen.estimate, captured: seen.captured };
      };
      const summarizeReview = (
        captured: Parameters<ResponseProvider>[0] | undefined,
        estimate: number | null,
        shown: { format: string; width: number; height: number; bytes: number },
      ) => {
        if (!captured) return null;
        const rendition = {
          format: shown.format,
          width: shown.width,
          height: shown.height,
          bytes: shown.bytes,
        };
        const content = (captured.input[0] as any).content as any[];
        const text = String(content.find((p) => p.type === "input_text")?.text);
        const images = content.filter((p) => p.type === "input_image");
        entry.review = {
          model: captured.route.model,
          maxOutputTokens: captured.route.maxOutputTokens,
          reasoningEffort: captured.route.reasoningEffort ?? null,
          estimateMicros: estimate,
          image: rendition,
          briefText: text,
          instructionsChars: captured.instructions.length,
        };
        print(
          `Vision review request: model ${captured.route.model}, max output tokens ${captured.route.maxOutputTokens}, reasoning effort ${captured.route.reasoningEffort ?? "provider default"}, tools none, reserved estimate USD ${estimate === null ? "n/a" : usd(estimate)}`,
        );
        print(
          `  image bytes sent: ${images.length} PNG (the ${rendition.format} rendition ${rendition.width}x${rendition.height}, ${rendition.bytes} bytes, as a data URL); instructions ${captured.instructions.length} chars; brief JSON: ${text}`,
        );
      };
      const savePng = (file: string, bytes: Buffer) => {
        const path = join(options.outDir, file);
        writeFileSync(path, bytes);
        entry.files.push(path);
      };
      const renditionBytes = async (assetId: string) =>
        run(owner, async (tx) =>
          Buffer.from(
            String(data(await entity(tx, owner, "assets", assetId)).base64),
            "base64",
          ),
        );
      const record = (view: any) => {
        entry.creativeStatus = view.status;
        entry.qa = {
          verdict: view.qa.verdict,
          failedChecks: view.qa.checks
            .filter((c: any) => !c.passed)
            .map((c: any) => c.code),
        };
        const vision = view.qa.vision;
        entry.vision = vision
          ? {
              verdict: vision.verdict,
              scores: vision.scores,
              issues: vision.issues,
            }
          : null;
        entry.creativeCost = {
          settledMicros: view.cost.settledMicros,
          unknownMicros: view.cost.unknownMicros,
        };
      };

      try {
        if (!options.pay) {
          // Free: the lifestyle layout over brand-coloured placeholder art.
          const kit = await run(owner, (tx) => resolveBrandKit(tx, owner));
          const placeholder = await solidRaster(
            kit.profile.visualIdentity.primaryColor,
            1536,
            1024,
          );
          const art = await run(owner, (tx) =>
            create(tx, owner, "assets", {
              name: "Placeholder art (dry run)",
              type: "background",
              mime: "image/png",
              base64: placeholder.bytes.toString("base64"),
              sha256: placeholder.sha256,
              bytes: placeholder.bytes.length,
              source: "Dry run placeholder",
              license: "Synthetic rights fixture",
              validUses: ["social"],
              usageApproved: true,
              assetStatus: "approved",
              providerUse: true,
              driveSyncStatus: "LOCAL_ONLY",
            }),
          );
          const view = await produceCreative(owner, {
            contentId: project.contentId,
            template: "lifestyle",
            copy: COPY[name] as any,
            artAssetId: art.id,
          });
          entry.statusPath.push(`placeholder_composed:${view.status}`);
          record(view);
          const request = await artRequest(owner, view);
          Object.assign(entry.image, {
            size: request.size,
            artPrompt: request.prompt,
            providerPrompt: request.providerPrompt,
          });
          print(
            `Placeholder composition: ${view.status}, QA ${view.qa.verdict}${entry.qa!.failedChecks.length ? ` (${entry.qa!.failedChecks.join(", ")})` : ""}, formats ${view.renditions.map((r: any) => `${r.format} ${r.width}x${r.height}`).join(", ")}`,
          );
          print(
            `Image request (--pay): ${IMAGE_MODEL} images.generate, size ${request.size}, quality medium, background opaque, output png, n 1, reference images: none (generateImage, ORBIT_IMAGE_REFERENCES off)`,
          );
          print(
            `  confirmation body: ${JSON.stringify({ generateArt: confirmation })}`,
          );
          print("  art prompt (artPrompt):");
          for (const line of request.prompt.split("\n")) print(`    ${line}`);
          print(
            "  provider prompt (buildBrandImagePrompt around it, as sent):",
          );
          for (const line of request.providerPrompt.split("\n"))
            print(`    ${line}`);
          for (const r of view.renditions)
            savePng(`${name}-${r.format}.png`, await renditionBytes(r.assetId));
          const { estimate, captured } = await reviewRequest(view.id);
          summarizeReview(captured, estimate, view.renditions[0]!);
          entry.statusPath.push("review_stubbed:nothing_sent");
        } else {
          // (1) One paid image, new art for the post's lifestyle creative.
          await assertCap(`the ${name} image`, 0);
          imagesLeft--;
          const sent: { calls: number; prompt: string; art?: Buffer } = {
            calls: 0,
            prompt: "",
          };
          const generate: ImageProvider = async (request) => {
            if (sent.calls++) throw new Error("SECOND_IMAGE_REFUSED");
            sent.prompt = request.prompt;
            transmitted = true;
            const generated = await (
              options.providers?.generate ?? ai.generateImage
            )(request);
            sent.art = generated.bytes;
            return generated;
          };
          const produced = await produceCreative(
            owner,
            {
              contentId: project.contentId,
              template: "lifestyle",
              copy: COPY[name] as any,
              generateArt: confirmation,
              requestId: randomUUID(),
            },
            { generate },
          );
          entry.statusPath.push(`produced:${produced.status}`);
          record(produced);
          if (sent.art) savePng(`${name}-art.png`, sent.art);
          const request = await artRequest(owner, produced);
          Object.assign(entry.image, {
            size: request.size,
            artPrompt: request.prompt,
            providerPrompt: request.providerPrompt,
            sentPrompt: sent.prompt,
          });
          print(
            `Image: ${sent.calls} call, ${IMAGE_MODEL} ${request.size}; creative ${produced.status}`,
          );
          if (sent.prompt !== request.providerPrompt)
            print(
              "  WARNING: the prompt sent differs from the dry run's prompt function",
            );
          const artId = produced.components.artAssetId;
          if (produced.status !== "needs_rights" || !artId)
            throw new Error(`UNEXPECTED_STATUS: ${produced.status}`);
          // (2) The owner's rights decision on the new art, with provider use (R28).
          await run(owner, async (tx) => {
            const handler = marketingActions["asset-status"]!;
            if (handler.transaction !== "shared")
              throw new Error("SHARED_EXPECTED");
            const row = await entity(tx, owner, "assets", artId);
            await handler.run(tx, {
              scope: owner,
              input: {
                assetId: artId,
                version: row.version,
                assetStatus: "approved",
                confirmUsageRights: true,
                providerUse: true,
              },
              config: {} as any,
              auth: {} as any,
            });
          });
          entry.statusPath.push("art_approved");
          const recomposed = await recomposeCreative(owner, produced.id, {});
          entry.statusPath.push(`recomposed:${recomposed.status}`);
          record(recomposed);
          print(
            `Recomposed: ${recomposed.status}, QA ${recomposed.qa.verdict}${entry.qa!.failedChecks.length ? ` (${entry.qa!.failedChecks.join(", ")})` : ""}`,
          );
          // (3) One vision review of the first rendition.
          const { view, estimate, captured } = await reviewRequest(
            recomposed.id,
          );
          summarizeReview(captured, estimate, recomposed.renditions[0]!);
          if (!view) throw new Error("VISION_REVIEW_MISSING");
          record(view);
          entry.statusPath.push(`reviewed:${entry.vision?.verdict ?? "none"}`);
          print(
            `Vision verdict: ${entry.vision?.verdict} ${JSON.stringify(entry.vision?.scores ?? {})}; creative ${view.status}`,
          );
          for (const r of view.renditions)
            savePng(`${name}-${r.format}.png`, await renditionBytes(r.assetId));
        }
      } catch (error) {
        const code =
          (error as { code?: string }).code ??
          (error instanceof Error
            ? error.message.split(":")[0]!
            : "UNEXPECTED");
        entry.error = {
          code,
          message: error instanceof Error ? error.message : String(error),
          afterTransmission: transmitted,
        };
        throw error;
      } finally {
        entry.reservations = await reservationsOf(owner);
        entry.spentMicros = counted(entry.reservations);
        result.totalSpentMicros = await spentAll();
        writeResult();
      }
      print(
        `Ledger: ${entry.reservations.map((r) => `${r.category} ${r.model ?? ""} ${r.state} reserved ${usd(r.reservedMicros)} settled ${r.settledMicros === null ? "-" : usd(r.settledMicros)}`).join("; ") || "no reservation"}`,
      );
      if (options.pay && entry.spentMicros > BRAND_STOP_MICROS) {
        result.stoppedReason = `${name} used USD ${usd(entry.spentMicros)} > ${usd(BRAND_STOP_MICROS)}`;
        print(`Stopping before the next brand: ${result.stoppedReason}`);
        break;
      }
    }
  } catch (error) {
    result.failed = true;
    result.stoppedReason = redact(
      error instanceof Error ? error.message : String(error),
    );
    print(`STOPPED (no retry): ${result.stoppedReason}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    result.totalSpentMicros = seeded.length ? await spentAll() : 0;
    writeResult();
    await cleanup();
  }
  print();
  print(
    result.mode === "pay"
      ? `Total spent: USD ${usd(result.totalSpentMicros)}; output in ${options.outDir}`
      : `Dry run: no provider call was made (the stubbed reviews' reservations on the throwaway projects: USD ${usd(result.totalSpentMicros)}); output in ${options.outDir}`,
  );
  return result;
}

/** The checkout whose `.runtime/local.env` supplies local settings. */
function localEnvFile() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const main = dirname(
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  return [root, main]
    .map((dir) => join(dir, ".runtime/local.env"))
    .find((file) => existsSync(file));
}

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args)
    if (arg !== "--pay") throw new Error(`Unknown option ${arg}`);
  const pay = args.includes("--pay");
  // A database the caller named must be local too, before anything else.
  for (const name of DATABASE_KEYS)
    if (process.env[name]) assertLocalDatabase(name, process.env[name]);
  const key = pay ? process.env.OPENAI_API_KEY?.trim() : undefined;
  if (pay && !key)
    throw new Error(
      "REFUSED: --pay needs OPENAI_API_KEY in the environment of this command",
    );
  // R62: nothing provider-related from the launch environment or local.env.
  clearProviderAccess();
  const file = localEnvFile();
  if (file) process.loadEnvFile(file);
  clearProviderAccess();
  if (!loadWorktreeTestEnv())
    throw new Error(
      "Create the isolated worktree test database first: node scripts/test-db-for-worktree.ts",
    );
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
  for (const name of DATABASE_KEYS)
    assertLocalDatabase(name, process.env[name]);
  const { priceCatalog } = await import("../packages/ai/src/catalog.ts");
  applyLiveEnvironment(process.env, liveSettings(priceCatalog), key);

  const { closeDatabase } = await import("../packages/db/src/index.ts");
  let cleanup: (() => Promise<void>) | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      console.log(
        `${signal}: removing the seeded projects (PNGs and result.json stay)`,
      );
      await cleanup?.();
      await closeDatabase();
      process.exit(130);
    });
  const outDir = resolve(
    ".runtime/creative-live-run",
    ...(pay ? [] : ["dry-run"]),
  );
  const result = await runCreativeLive({
    pay,
    outDir,
    onCleanup: (fn) => {
      cleanup = fn;
    },
  });
  await closeDatabase();
  process.exit(result.failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    // Messages only (a stack or an SDK error object is never printed), without the key.
    const key = process.env.OPENAI_API_KEY;
    const message = error instanceof Error ? error.message : "UNEXPECTED";
    console.error(key ? message.split(key).join("[redacted]") : message);
    process.exit(2);
  });
