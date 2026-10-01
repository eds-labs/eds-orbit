/**
 * Generation eval harness. Each run goes through the production path:
 * generateMissionLive (routing, reservation, telemetry) and checkClaims (the
 * review gate). It must run inside Vitest so the caller can mock `embed`
 * (always) and `generate` (offline replay); it never mocks anything itself.
 * Only synthetic data is used, in a workspace created and deleted per eval.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { authDb, scoped } from "../../packages/db/src/index.ts";
import {
  mission as missionSchema,
  type Scope,
} from "../../packages/schemas/src/index.ts";
import { setFact } from "../../packages/knowledge/src/index.ts";
import {
  computeCost,
  modelRouteSchema,
  type ModelRoute,
  type OpenAiRuntimeConfig,
} from "../../packages/ai/src/index.ts";
import { create, data, entity, update } from "../../apps/api/src/shared.ts";
import { generateMissionLive } from "../../apps/api/src/modules/generation.ts";
import { checkClaims } from "../../apps/api/src/modules/policy.ts";
import { errorCode } from "../../apps/api/src/modules/telemetry.ts";
import { saveOpenAiConfiguration } from "../../apps/api/src/modules/openai-configuration.ts";
import { saveMarketingProfile } from "../../apps/api/src/modules/marketing-profile.ts";
import { resolveChannelRules } from "../../apps/api/src/modules/channel-rules.ts";

export type EvalClaim = {
  text: string;
  factKey?: string;
  kind: "fact" | "quote" | "style";
};
export type EvalCase = {
  id: string;
  language: "en" | "de";
  contentType: "social" | "blog";
  // "blog" is a website channel without a provider character limit.
  channel: {
    provider: "telegram" | "x" | "blog";
    characterLimit: number | null;
  };
  profile: {
    positioning: string;
    voice: string;
    guardrails: string[];
    primaryCta: string;
    officialUrl: string;
  };
  facts: Array<{ key: string; value: string }>;
  goal: string;
  recorded?: Record<
    string,
    { title: string; body: string; claims: EvalClaim[] }
  >;
};
export type EvalCandidate = { label: string; route: ModelRoute };
export type EvalResult = {
  caseId: string;
  candidate: string;
  // False for a run that stopped the eval (budget refusal, unknown cost or an
  // unexpected error); kept for the record but excluded from the summary.
  counted: boolean;
  // Configuration version recorded on the generation run.
  routeVersion: number | null;
  valid: boolean;
  problems: string[];
  costMicros: number | null;
  // Settled amount of the generation reservation; null when not settled.
  settledMicros: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number | null;
  errorCode: string | null;
};
export type EvalSummary = {
  candidate: string;
  // Counted runs only.
  runs: number;
  // Valid stored content / counted runs; null without counted runs.
  passRate: number | null;
  costPerAcceptedMicros: number | null;
  totalCostMicros: number;
  // False when a counted run has no known cost.
  costComplete: boolean;
  p50DurationMs: number | null;
  // Counted runs ending in INSUFFICIENT_EVIDENCE / MODEL_OUTPUT_NOT_VALID.
  abstained: number;
  invalidOutput: number;
  problemCounts: Record<string, number>;
};
export type EvalReport = {
  datasetVersion: string;
  datasetHash: string;
  startedAt: string;
  // Deleted synthetic workspace; lets callers verify the cleanup.
  workspaceId: string;
  // Why the eval stopped before all planned runs; null when complete.
  stoppedReason: string | null;
  candidates: EvalCandidate[];
  results: EvalResult[];
  summary: EvalSummary[];
};

export const EVAL_PRODUCT = "Northwind Ledger";
// Exact name of every workspace, project and user the harness creates.
export const EVAL_MARKER = "Synthetic generation eval";
// Residue of a hard-killed eval is removed after this age.
const STALE_AFTER_MS = 3600_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EVAL_AUDIENCE = "Owners and finance leads of small companies";
const MAX_REPETITIONS = 10;
// Policy schema maximum for perRunBudgetMicros.
const MAX_COST_MICROS = 100_000_000;
// Budget journal refusals: further runs would be refused as well.
const BUDGET_REFUSALS = new Set([
  "BUDGET_EXCEEDED",
  "RUN_BUDGET_EXCEEDED",
  "BUDGET_NOT_APPROVED",
]);
// Completed, priced provider responses without usable output.
const MODEL_OUTCOMES = new Set([
  "INSUFFICIENT_EVIDENCE",
  "MODEL_OUTPUT_NOT_VALID",
]);

const factKey = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/);
const recordedSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(40000),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2000),
            factKey: factKey.optional(),
            kind: z.enum(["fact", "quote", "style"]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,80}$/),
    language: z.enum(["en", "de"]),
    contentType: z.enum(["social", "blog"]),
    channel: z
      .object({
        provider: z.enum(["telegram", "x", "blog"]),
        characterLimit: z.number().int().positive().nullable(),
      })
      .strict(),
    profile: z
      .object({
        positioning: z.string().min(1).max(2000),
        voice: z.string().min(1).max(300),
        guardrails: z.array(z.string().min(1).max(500)).min(1).max(50),
        primaryCta: z.string().min(1).max(200),
        officialUrl: z.url().refine((url) => url.startsWith("https://")),
      })
      .strict(),
    facts: z
      .array(z.object({ key: factKey, value: z.string().min(1).max(2000) }))
      .min(1)
      .max(10),
    goal: z.string().min(5).max(2000),
    recorded: z.record(z.string(), recordedSchema).optional(),
  })
  .strict();
const casesSchema = z
  .array(caseSchema)
  .min(1)
  .max(50)
  .superRefine((cases, context) => {
    if (new Set(cases.map((item) => item.id)).size !== cases.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_CASE_ID" });
    // One project holds all facts; a key needs one value per language.
    const values = new Map<string, string>();
    for (const item of cases)
      for (const fact of item.facts) {
        const id = item.language + ":" + fact.key;
        if ((values.get(id) ?? fact.value) !== fact.value)
          context.addIssue({ code: "custom", message: "FACT_VALUE_CONFLICT" });
        values.set(id, fact.value);
      }
  });
const candidatesSchema = z
  .array(
    z
      .object({ label: z.string().min(1).max(80), route: modelRouteSchema })
      .strict(),
  )
  .min(1)
  .max(10)
  .refine(
    (candidates) =>
      new Set(candidates.map((item) => item.label)).size === candidates.length,
    { message: "DUPLICATE_CANDIDATE_LABEL" },
  );

export function parseFixtures(raw: unknown): {
  datasetVersion: string;
  cases: EvalCase[];
} {
  return z
    .object({ datasetVersion: z.string().min(1).max(80), cases: casesSchema })
    .strict()
    .parse(raw);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function datasetHash(
  cases: EvalCase[],
  candidates: EvalCandidate[],
  repetitions: number,
  maxCostMicros: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({ cases, candidates, repetitions, maxCostMicros }),
      ),
    )
    .digest("hex");
}

const sameRoute = (a: ModelRoute, b: ModelRoute) =>
  a.model === b.model &&
  a.maxOutputTokens === b.maxOutputTokens &&
  (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null);

/**
 * Offline stand-in for `generate`: returns the recorded output of the case
 * (matched by the contract goal) for the candidate (matched by route).
 * `{{fact:<key>}}` becomes the production `{{fact:<factId>}}` placeholder.
 * Usage is derived from byte sizes and priced with the real rate card.
 */
export function recordedGenerate(
  cases: EvalCase[],
  candidates: EvalCandidate[],
) {
  const byGoal = new Map(cases.map((item) => [item.goal, item]));
  if (byGoal.size !== cases.length) throw new Error("EVAL_DUPLICATE_GOAL");
  if (
    candidates.some((a, i) =>
      candidates.some((b, j) => i < j && sameRoute(a.route, b.route)),
    )
  )
    throw new Error("EVAL_DUPLICATE_ROUTE");
  return async (params: {
    goal: string;
    evidence: unknown;
    route: ModelRoute;
    runtime?: OpenAiRuntimeConfig;
  }) => {
    const contract = JSON.parse(params.goal) as { goal?: unknown };
    const item = byGoal.get(String(contract.goal));
    const candidate = candidates.find((c) => sameRoute(c.route, params.route));
    const recorded = candidate && item?.recorded?.[candidate.label];
    if (!recorded) throw new Error("EVAL_RECORDING_MISSING");
    const facts =
      (params.evidence as { facts?: Array<{ id: string; key: string }> })
        .facts ?? [];
    const idOf = (key: string) => facts.find((fact) => fact.key === key)?.id;
    const placeholders = (text: string) =>
      text.replace(/\{\{fact:([a-z][a-z0-9.-]*)\}\}/g, (match, key: string) => {
        const id = idOf(key);
        return id ? `{{fact:${id}}}` : match;
      });
    const output = {
      title: recorded.title,
      body: placeholders(recorded.body),
      claims: recorded.claims.map((claim) => {
        if (!claim.factKey) return { text: claim.text, kind: claim.kind };
        const factId = idOf(claim.factKey);
        if (!factId) throw new Error("EVAL_RECORDING_FACT_MISSING");
        return { text: placeholders(claim.text), factId, kind: claim.kind };
      }),
    };
    const counts = {
      inputTokens: Math.ceil(
        Buffer.byteLength(params.goal + JSON.stringify(params.evidence)) / 4,
      ),
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(output)) / 4),
      reasoningTokens: 0,
    };
    return {
      output,
      responseId: "replay_" + randomUUID(),
      usage: {
        model: params.route.model,
        ...counts,
        costMicros: computeCost(
          params.route.model,
          { ...counts, detailsKnown: true },
          { rateCard: params.runtime?.rateCard ?? {} },
        ),
      },
    };
  };
}

const channelId = (item: EvalCase) => "eval-" + item.channel.provider;
const linkRef = (item: EvalCase) =>
  item.language + " " + item.profile.officialUrl;

type Setup = {
  sourceId: string;
  policyId: string;
  // Official-link fact per language and URL.
  links: Map<string, { id: string; key: string }>;
};

async function seed(
  scope: Scope,
  cases: EvalCase[],
  maxCostMicros: number,
): Promise<Setup> {
  const past = new Date(Date.now() - 3600_000).toISOString();
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const source = await create(tx, scope, "sources", {
      name: "Synthetic generation eval facts",
      type: "manual",
      status: "active",
      generation: 1,
      publicUse: true,
      modelUse: true,
      authority: "official",
      maxAgeHours: 168,
      allowedOrigins: [],
      allowedPaths: [],
    });
    const verified = (
      key: string,
      value: string,
      language: string,
      valueType: "text" | "url",
    ) =>
      setFact(tx, scope, {
        key,
        value,
        valueType,
        language,
        sourceId: source.id,
        validFrom: past,
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
    const facts = new Set<string>();
    const links = new Map<string, { id: string; key: string }>();
    for (const item of cases) {
      for (const fact of item.facts) {
        const ref = item.language + ":" + fact.key;
        if (facts.has(ref)) continue;
        await verified(fact.key, fact.value, item.language, "text");
        facts.add(ref);
      }
      if (links.has(linkRef(item))) continue;
      const key = "official.link-" + (links.size + 1);
      const link = await verified(
        key,
        item.profile.officialUrl,
        item.language,
        "url",
      );
      links.set(linkRef(item), { id: link.id, key });
    }
    await create(tx, scope, "connectors", {
      provider: "postiz",
      status: "read_verified",
      channels: [
        { id: "eval-x", name: "Eval X", identifier: "x", disabled: false },
        {
          id: "eval-telegram",
          name: "Eval Telegram",
          identifier: "telegram",
          disabled: false,
        },
      ],
      assignedIntegrationIds: ["eval-x", "eval-telegram"],
    });
    const policy = await create(tx, scope, "policies", {
      mode: "observe",
      channels: [...new Set(cases.map(channelId))],
      contentTypes: [...new Set(cases.map((item) => item.contentType))],
      allowedOrigins: [
        ...new Set(
          cases.map((item) => new URL(item.profile.officialUrl).origin),
        ),
      ],
      startAt: past,
      // Short windows limit what a hard-killed eval leaves usable.
      endAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      maxPerDay: 0,
      minIntervalMinutes: 1,
      dailyBudgetMicros: maxCostMicros,
      monthlyBudgetMicros: maxCostMicros,
      perRunBudgetMicros: maxCostMicros,
      approvedPaidTests: true,
      active: true,
    });
    // The fixture limit must match what production channel rules resolve.
    for (const item of cases) {
      const rules = await resolveChannelRules(
        tx,
        scope,
        channelId(item),
        item.contentType,
        false,
      );
      if (rules.characterLimit !== item.channel.characterLimit)
        throw new Error("EVAL_CHANNEL_LIMIT_MISMATCH");
    }
    return { sourceId: source.id, policyId: policy.id, links };
  });
}

// Routes every task class and tier to the candidate, as an owner would.
function configure(
  scope: Scope,
  runtime: OpenAiRuntimeConfig,
  route: ModelRoute,
) {
  return scoped(scope.workspaceId, scope.projectId, (tx) =>
    saveOpenAiConfiguration(tx, scope, {
      apiKey: runtime.apiKey,
      verifiedModels: runtime.verifiedModels,
      rateCard: runtime.rateCard,
      modelRoutes: {
        fast: route.model,
        standard: route.model,
        quality: route.model,
        escalation: route.model,
      },
      taskRoutes: { draft_social: route, draft_blog: route },
    }),
  );
}

async function saveProfile(scope: Scope, setup: Setup, item: EvalCase) {
  const saved = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    saveMarketingProfile(tx, scope, {
      productName: EVAL_PRODUCT,
      contentLanguage: item.language,
      internalLanguage: "en",
      audience: EVAL_AUDIENCE,
      positioning: item.profile.positioning,
      productStrategy: "Explain verified product capabilities, one per post.",
      presaleStrategy: "Not applicable: the product has no presale.",
      voice: [item.profile.voice],
      guardrails: item.profile.guardrails,
      primaryCtas: [item.profile.primaryCta],
      channelPriority: [channelId(item)],
      notificationPreference: "none",
      officialLinks: [
        {
          label: "Website",
          url: item.profile.officialUrl,
          factId: setup.links.get(linkRef(item))!.id,
        },
      ],
      assetPolicy: "approved_only",
    }),
  );
  return saved.version;
}

async function createMission(
  scope: Scope,
  setup: Setup,
  item: EvalCase,
  profileVersion: number,
) {
  const now = Date.now();
  const base = missionSchema.parse({
    title: ("Eval " + item.id).slice(0, 160),
    goal: item.goal,
    audience: EVAL_AUDIENCE,
    product: EVAL_PRODUCT,
    allowedActions: ["draft", "review"],
    language: item.language,
    channels: [channelId(item)],
    startAt: new Date(now - 60_000).toISOString(),
    endAt: new Date(now + 3600_000).toISOString(),
    maxContents: 1,
    targetAction: item.profile.primaryCta,
    targetUrl: item.profile.officialUrl,
    sourceIds: [setup.sourceId],
    contentType: item.contentType,
    campaignType: "product",
    profileVersion,
  });
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    create(tx, scope, "missions", {
      ...base,
      status: "ready",
      // Exact evidence keys, as on planned autopilot slots (missionFactKeys).
      autopilot: true,
      factKeys: [
        ...item.facts.map((fact) => fact.key),
        setup.links.get(linkRef(item))!.key,
      ],
    }),
  );
  return row.id;
}

/**
 * Hard ceiling across day and month boundaries: each run may reserve at most
 * what remains of maxCostMicros. Returns the remaining amount.
 */
async function capRemaining(scope: Scope, setup: Setup, maxCostMicros: number) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const rows = await tx.budgetReservation.findMany({
      where: { projectId: scope.projectId, state: { not: "released" } },
    });
    const spent = rows.reduce(
      (sum, row) =>
        sum +
        Number(row.state === "settled" ? row.settledMicros : row.amountMicros),
      0,
    );
    const remaining = maxCostMicros - spent;
    if (remaining <= 0) return remaining;
    const policy = await entity(tx, scope, "policies", setup.policyId);
    if (data(policy).perRunBudgetMicros !== remaining)
      await update(tx, scope, policy, {
        ...data(policy),
        perRunBudgetMicros: remaining,
      });
    return remaining;
  });
}

async function runOnce(
  scope: Scope,
  missionId: string,
  item: EvalCase,
  candidate: EvalCandidate,
): Promise<{ result: Omit<EvalResult, "counted">; unknown: boolean }> {
  const jobId = randomUUID();
  let contentId: string | null = null;
  let failure: string | null = null;
  try {
    contentId = (await generateMissionLive(scope, missionId, jobId)).id;
  } catch (error) {
    failure = errorCode(error);
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    let review: { valid: boolean; problems: string[] } = {
      valid: false,
      problems: [],
    };
    if (contentId)
      try {
        review = await checkClaims(tx, scope, contentId);
      } catch (error) {
        failure = errorCode(error);
      }
    const run = await tx.agentRun.findFirst({
      where: {
        projectId: scope.projectId,
        kind: "generation",
        subjectType: "job",
        subjectId: jobId,
      },
    });
    const span = run
      ? await tx.agentSpan.findFirst({
          where: { runId: run.id, type: "model_call" },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const reservation = await tx.budgetReservation.findFirst({
      where: { projectId: scope.projectId, key: scope.projectId + ":" + jobId },
    });
    const unknown = await tx.budgetReservation.count({
      where: { projectId: scope.projectId, state: "unknown" },
    });
    return {
      unknown: unknown > 0,
      result: {
        caseId: item.id,
        candidate: candidate.label,
        routeVersion: run?.routeVersion ?? null,
        valid: failure === null && review.valid,
        problems: failure === null ? review.problems : [],
        costMicros: span?.costMicros == null ? null : Number(span.costMicros),
        settledMicros:
          reservation?.state === "settled" && reservation.settledMicros != null
            ? Number(reservation.settledMicros)
            : null,
        inputTokens: span?.inputTokens ?? null,
        cachedTokens: span?.cachedTokens ?? null,
        cacheWriteTokens: span?.cacheWriteTokens ?? null,
        outputTokens: span?.outputTokens ?? null,
        reasoningTokens: span?.reasoningTokens ?? null,
        durationMs: span?.durationMs ?? null,
        errorCode: failure,
      },
    };
  });
}

function summarize(
  candidates: EvalCandidate[],
  results: EvalResult[],
): EvalSummary[] {
  return candidates.map(({ label }) => {
    const own = results.filter(
      (result) => result.candidate === label && result.counted,
    );
    const accepted = own.filter((result) => result.valid).length;
    const totalCostMicros = own.reduce(
      (sum, result) => sum + (result.costMicros ?? 0),
      0,
    );
    const durations = own
      .map((result) => result.durationMs)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const problemCounts: Record<string, number> = {};
    for (const result of own)
      for (const problem of result.problems)
        problemCounts[problem] = (problemCounts[problem] ?? 0) + 1;
    const ended = (code: string) =>
      own.filter((result) => result.errorCode === code).length;
    return {
      candidate: label,
      runs: own.length,
      passRate: own.length ? accepted / own.length : null,
      costPerAcceptedMicros: accepted
        ? Math.round(totalCostMicros / accepted)
        : null,
      totalCostMicros,
      costComplete: own.every((result) => result.costMicros !== null),
      p50DurationMs: durations.length
        ? durations[Math.ceil(durations.length / 2) - 1]!
        : null,
      abstained: ended("INSUFFICIENT_EVIDENCE"),
      invalidOutput: ended("MODEL_OUTPUT_NOT_VALID"),
      problemCounts,
    };
  });
}

/** Evals write and delete rows; they never run against a remote database. */
function assertLocalDatabase() {
  for (const key of ["DATABASE_URL", "AUTH_DATABASE_URL"]) {
    let host = "";
    try {
      host = new URL(process.env[key] ?? "").hostname;
    } catch {
      // Unparsable or missing counts as not local.
    }
    if (!LOCAL_HOSTS.has(host)) throw new Error("EVAL_DATABASE_NOT_LOCAL");
  }
}

/** Removes residue of hard-killed evals: marker-named rows older than an hour. */
async function removeStaleEvals() {
  const before = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await authDb.workspace.findMany({
    where: { name: EVAL_MARKER, createdAt: { lt: before } },
    select: { id: true },
  });
  for (const { id } of stale) await authDb.workspace.delete({ where: { id } });
  // Only marker users that no longer belong to any workspace.
  await authDb.user.deleteMany({
    where: {
      name: EVAL_MARKER,
      email: { endsWith: "@example.invalid" },
      createdAt: { lt: before },
      memberships: { none: {} },
    },
  });
}

// Whether a finished run stops the eval, and why.
function stopReason(result: Omit<EvalResult, "counted">, unknown: boolean) {
  if (unknown) return "RESERVATION_UNKNOWN";
  if (result.errorCode === null || MODEL_OUTCOMES.has(result.errorCode))
    return null;
  if (BUDGET_REFUSALS.has(result.errorCode)) return result.errorCode;
  return "UNEXPECTED:" + result.errorCode;
}

export async function runEval(options: {
  cases: EvalCase[];
  candidates: EvalCandidate[];
  repetitions: number;
  maxCostMicros: number;
  runtime: OpenAiRuntimeConfig;
  datasetVersion: string;
}): Promise<EvalReport> {
  assertLocalDatabase();
  const cases = casesSchema.parse(options.cases) as EvalCase[];
  const candidates = candidatesSchema.parse(options.candidates);
  const { repetitions, maxCostMicros, runtime } = options;
  if (
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > MAX_REPETITIONS
  )
    throw new Error("EVAL_REPETITIONS_INVALID");
  if (
    !Number.isSafeInteger(maxCostMicros) ||
    maxCostMicros < 1 ||
    maxCostMicros > MAX_COST_MICROS
  )
    throw new Error("EVAL_MAX_COST_INVALID");
  if (
    candidates.some(
      ({ route }) =>
        !runtime.verifiedModels.includes(route.model) ||
        !runtime.rateCard[route.model],
    )
  )
    throw new Error("EVAL_CANDIDATE_NOT_CONFIGURED");
  await removeStaleEvals();
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  let stoppedReason: string | null = null;
  let workspaceId: string | null = null;
  let setupError: unknown = null;
  const user = await authDb.user.create({
    data: {
      id: randomUUID(),
      name: EVAL_MARKER,
      email: `${randomUUID()}@example.invalid`,
    },
  });
  try {
    const workspace = await authDb.workspace.create({
      data: {
        name: EVAL_MARKER,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: EVAL_MARKER, mode: "observe" },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    const setup = await seed(scope, cases, maxCostMicros);
    // Case-major with interleaved candidates, so an early stop leaves
    // comparable partial data.
    let configured: EvalCandidate | null = null;
    try {
      evaluation: for (const item of cases) {
        const profileVersion = await saveProfile(scope, setup, item);
        for (const candidate of candidates) {
          if (configured !== candidate) {
            await configure(scope, runtime, candidate.route);
            configured = candidate;
          }
          for (let repetition = 0; repetition < repetitions; repetition++) {
            if ((await capRemaining(scope, setup, maxCostMicros)) <= 0) {
              stoppedReason = "BUDGET_EXCEEDED";
              break evaluation;
            }
            const missionId = await createMission(
              scope,
              setup,
              item,
              profileVersion,
            );
            const { result, unknown } = await runOnce(
              scope,
              missionId,
              item,
              candidate,
            );
            stoppedReason = stopReason(result, unknown);
            results.push({ ...result, counted: stoppedReason === null });
            if (stoppedReason) break evaluation;
          }
        }
      }
    } catch (error) {
      // Keep the completed runs; the cleanup below still runs.
      stoppedReason = "UNEXPECTED:" + errorCode(error);
    }
  } catch (error) {
    setupError = error;
  }
  // Cleanup always runs; the first error wins.
  let cleanupError: unknown = null;
  try {
    // Cascades to the project and every row of the eval.
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
  } catch (error) {
    cleanupError = error;
  }
  try {
    await authDb.user.delete({ where: { id: user.id } });
  } catch (error) {
    cleanupError ??= error;
  }
  if (setupError) throw setupError;
  if (cleanupError) throw cleanupError;
  return {
    datasetVersion: options.datasetVersion,
    datasetHash: datasetHash(
      options.cases,
      options.candidates,
      repetitions,
      maxCostMicros,
    ),
    startedAt,
    // Set once setup succeeded; setup errors were rethrown above.
    workspaceId: workspaceId!,
    stoppedReason,
    candidates,
    results,
    summary: summarize(candidates, results),
  };
}

const cell = (value: unknown) => String(value).replace(/[|\n]/g, " ");
const usd = (micros: number | null) =>
  micros === null ? "–" : "$" + (micros / 1_000_000).toFixed(6);

export function renderMarkdown(report: EvalReport): string {
  const table = (header: string[], rows: unknown[][]) =>
    [
      "| " + header.join(" | ") + " |",
      "| " + header.map(() => "---").join(" | ") + " |",
      ...rows.map((row) => "| " + row.map(cell).join(" | ") + " |"),
    ].join("\n");
  return [
    "# Generation eval report",
    "",
    `- Dataset: ${report.datasetVersion}`,
    `- Dataset hash: \`${report.datasetHash}\``,
    `- Started: ${report.startedAt}`,
    `- Stopped early: ${report.stoppedReason ?? "no"}`,
    "",
    "## Candidates",
    "",
    table(
      ["Label", "Model", "Reasoning effort", "Max output tokens"],
      report.candidates.map(({ label, route }) => [
        label,
        route.model,
        route.reasoningEffort ?? "default",
        route.maxOutputTokens,
      ]),
    ),
    "",
    "## Summary",
    "",
    table(
      [
        "Candidate",
        "Runs",
        "Pass rate",
        "Abstained",
        "Invalid output",
        "Cost per accepted",
        "Total cost",
        "p50 model call (ms)",
        "Problems",
      ],
      report.summary.map((row) => [
        row.candidate,
        row.runs,
        row.passRate === null ? "–" : (row.passRate * 100).toFixed(1) + "%",
        row.abstained,
        row.invalidOutput,
        usd(row.costPerAcceptedMicros),
        usd(row.totalCostMicros) + (row.costComplete ? "" : " (incomplete)"),
        row.p50DurationMs ?? "–",
        Object.entries(row.problemCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([code, count]) => `${code} ×${count}`)
          .join(", ") || "–",
      ]),
    ),
    "",
    "## Results",
    "",
    table(
      [
        "Case",
        "Candidate",
        "Counted",
        "Route version",
        "Valid",
        "Problems or error",
        "Cost (micros)",
        "Input",
        "Cached",
        "Cache write",
        "Output",
        "Reasoning",
        "Duration (ms)",
      ],
      report.results.map((result) => [
        result.caseId,
        result.candidate,
        result.counted ? "yes" : "no",
        result.routeVersion ?? "–",
        result.valid ? "yes" : "no",
        result.errorCode ?? (result.problems.join(", ") || "–"),
        result.costMicros ?? "–",
        result.inputTokens ?? "–",
        result.cachedTokens ?? "–",
        result.cacheWriteTokens ?? "–",
        result.outputTokens ?? "–",
        result.reasoningTokens ?? "–",
        result.durationMs ?? "–",
      ]),
    ),
    "",
  ].join("\n");
}
