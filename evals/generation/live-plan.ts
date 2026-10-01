/**
 * Planning and gating for the manual live generation eval. Pure functions:
 * nothing here reads a database, calls a provider or prints a secret.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  estimateCost,
  modelRouteSchema,
  type OpenAiRuntimeConfig,
} from "../../packages/ai/src/index.ts";
import {
  canonical,
  datasetHash,
  type EvalCandidate,
  type EvalCase,
} from "./harness.ts";

// Hard ceiling of a live eval; ORBIT_EVAL_MAX_USD can only lower it.
const CEILING_USD = 5;
// Production requires prices verified within 31 days.
const RATE_MAX_AGE_MS = 31 * 86_400_000;
// The mission contract and evidence wrapped around a case; a planning bound
// only, because each real reservation uses the exact payload size.
const PROMPT_OVERHEAD_BYTES = 20_000;
// Same safety margin as the production estimate in generateMissionLive.
const ESTIMATE_MARGIN_BYTES = 4_000;
const EMBEDDING_MODEL = "text-embedding-3-small";

const price = z
  .object({
    inputMicrosPerMillion: z.number().nonnegative(),
    outputMicrosPerMillion: z.number().nonnegative(),
    cachedInputMicrosPerMillion: z.number().nonnegative().optional(),
    cacheWriteMicrosPerMillion: z.number().nonnegative().optional(),
  })
  .strict();
const candidatesFileSchema = z
  .object({
    // One verification date for the whole card, applied to every model.
    verifiedAt: z.iso.datetime(),
    rateCard: z.record(z.string(), price),
    candidates: z
      .array(
        z
          .object({ label: z.string().min(1).max(80), route: modelRouteSchema })
          .strict(),
      )
      .min(1)
      .max(10),
    repetitions: z.number().int().min(1).max(10),
  })
  .strict();
export type CandidatesFile = z.infer<typeof candidatesFileSchema> & {
  candidates: EvalCandidate[];
};

export function parseCandidatesFile(raw: unknown): CandidatesFile {
  return candidatesFileSchema.parse(raw) as CandidatesFile;
}

export type LiveEnv = Record<string, string | undefined>;
export type LivePlan = {
  datasetVersion: string;
  caseCount: number;
  candidates: EvalCandidate[];
  repetitions: number;
  calls: number;
  // Upper bound of the summed reservation estimates in USD micros.
  worstCaseMicros: number;
  maxCostMicros: number;
  // Hash of fixtures, candidates, repetitions and ceiling (also in the report).
  hash: string;
  // Value for ORBIT_EVAL_CONFIRM: binds the hash, the full rate card (the
  // ceiling is enforced in rate-card micros), its verification date and the
  // ceiling, so any later price edit invalidates the approval.
  confirmation: string;
  // Rate card for the harness, with the verification date applied per model.
  runtime: Pick<OpenAiRuntimeConfig, "verifiedModels" | "rateCard">;
};

function ceilingMicros(env: LiveEnv) {
  const raw = env.ORBIT_EVAL_MAX_USD;
  // Unset means the default; an empty or malformed value is an error.
  const usd = raw === undefined ? CEILING_USD : Number(raw);
  const micros = Math.round(Math.min(usd, CEILING_USD) * 1_000_000);
  if (
    (raw !== undefined && raw.trim() === "") ||
    !Number.isFinite(usd) ||
    !Number.isSafeInteger(micros) ||
    micros < 1
  )
    throw new Error("EVAL_MAX_USD_INVALID");
  return micros;
}

export function planLiveEval(
  env: LiveEnv,
  fixtures: { datasetVersion: string; cases: EvalCase[] },
  file: CandidatesFile,
  now = Date.now(),
): LivePlan {
  const verified = new Date(file.verifiedAt).valueOf();
  // Production only rejects old prices; a future date would never go stale.
  if (verified > now) throw new Error("EVAL_RATE_CARD_FUTURE");
  if (now - verified > RATE_MAX_AGE_MS) throw new Error("EVAL_RATE_CARD_STALE");
  const models = [
    ...new Set(file.candidates.map((candidate) => candidate.route.model)),
  ];
  if ([...models, EMBEDDING_MODEL].some((model) => !file.rateCard[model]))
    throw new Error("EVAL_CANDIDATE_NOT_PRICED");
  const rateCard = Object.fromEntries(
    Object.entries(file.rateCard).map(([model, rate]) => [
      model,
      { ...rate, verifiedAt: file.verifiedAt },
    ]),
  );
  const maxCostMicros = ceilingMicros(env);
  let worstCaseMicros = 0;
  for (const item of fixtures.cases) {
    const bytes =
      Buffer.byteLength(JSON.stringify(item)) +
      PROMPT_OVERHEAD_BYTES +
      ESTIMATE_MARGIN_BYTES;
    for (const { route } of file.candidates)
      worstCaseMicros +=
        estimateCost(route.model, bytes, route.maxOutputTokens, { rateCard }) *
        file.repetitions;
  }
  const hash = datasetHash(
    fixtures.cases,
    file.candidates,
    file.repetitions,
    maxCostMicros,
  );
  return {
    datasetVersion: fixtures.datasetVersion,
    caseCount: fixtures.cases.length,
    candidates: file.candidates,
    repetitions: file.repetitions,
    calls: fixtures.cases.length * file.candidates.length * file.repetitions,
    worstCaseMicros,
    maxCostMicros,
    hash,
    confirmation: createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            datasetHash: hash,
            rateCard,
            verifiedAt: file.verifiedAt,
            maxCostMicros,
          }),
        ),
      )
      .digest("hex"),
    // The embedding model is priced for the harness, never listed as a route.
    runtime: { verifiedModels: [...models], rateCard },
  };
}

/** Live mode is requested by a key or a confirmation; otherwise it is a dry run. */
export function isLiveRequested(env: LiveEnv) {
  return Boolean(
    env.ORBIT_EVAL_OPENAI_API_KEY?.trim() || env.ORBIT_EVAL_CONFIRM?.trim(),
  );
}

/** Returns the key once both gates pass. Error messages never contain it. */
export function assertLiveAllowed(env: LiveEnv, confirmation: string): string {
  const key = env.ORBIT_EVAL_OPENAI_API_KEY?.trim();
  if (!key) throw new Error("EVAL_KEY_REQUIRED");
  if (env.ORBIT_EVAL_CONFIRM !== confirmation)
    throw new Error("EVAL_CONFIRMATION_MISMATCH");
  return key;
}

const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(4);

export function renderPlan(plan: LivePlan): string {
  return [
    "Generation eval plan (dry run; nothing is transmitted)",
    `  dataset version: ${plan.datasetVersion}`,
    `  cases: ${plan.caseCount}`,
    "  candidates:",
    ...plan.candidates.map(
      ({ label, route }) =>
        `    - ${label}: ${route.model}, reasoning ${route.reasoningEffort ?? "default"}, max output ${route.maxOutputTokens}`,
    ),
    `  repetitions: ${plan.repetitions}`,
    `  ${plan.calls} planned calls (${plan.caseCount} cases x ${plan.candidates.length} candidates x ${plan.repetitions} repetitions)`,
    `  worst-case estimate: ${usd(plan.worstCaseMicros)} (${plan.worstCaseMicros} micros; every call at its full output limit)`,
    `  cost ceiling: ${usd(plan.maxCostMicros)} (${plan.maxCostMicros} micros; the run stops when it is reached)`,
    ...(plan.worstCaseMicros > plan.maxCostMicros
      ? [
          "  note: the worst case exceeds the ceiling, so the run may stop early with a partial report.",
        ]
      : []),
    `  dataset hash: ${plan.hash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${plan.confirmation}`,
  ].join("\n");
}

/** UTC timestamp safe for file names, e.g. 2026-10-01T12-30-00Z. */
export function evidenceStamp(date: Date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

/**
 * Error safe to rethrow: the secret is removed from message and stack and
 * no cause is kept, so nothing can print it later.
 */
export function redactSecret(error: unknown, secret: string): Error {
  const clean = (text: string) =>
    secret ? text.split(secret).join("[redacted]") : text;
  const source = error instanceof Error ? error : null;
  const safe = new Error(clean(source ? source.message : String(error)));
  safe.name = source?.name ?? "Error";
  safe.stack = clean(source?.stack ?? safe.stack ?? "");
  return safe;
}
