import { describe, expect, it, vi } from "vitest";

// Planning only: nothing here touches a database, and a call of the provider fails the test.
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

import { respond } from "../../packages/ai/src/index.ts";
import type { CandidatesFile } from "../generation/live-plan.ts";
import { isEvalLiveRequested } from "../agents/eval-key.ts";
import { parseVisionSet } from "./vision-set.ts";
import {
  evaluateVisionPassRule,
  MIN_GOOD_PASSES,
  parseVisionRouteFile,
  planVisionEval,
  renderVisionPlan,
  startVisionEval,
  VISION_CEILING_USD,
  visionCasePasses,
  visionDatasetHash,
  visionPromptHash,
  type VisionCaseResult,
} from "./vision-plan.ts";
import rawSet from "./vision-v1.json" with { type: "json" };
import rawRoute from "./vision-route-v1.json" with { type: "json" };

const set = parseVisionSet(rawSet);
const routeFile = parseVisionRouteFile(rawRoute);
// A fixture rate card, never the repository's (stale until it is refreshed):
// Orbit's verified catalog price of claude-sonnet-5-5 in USD micros per million tokens.
const rates = {
  verifiedAt: "2026-11-11T00:00:00.000Z",
  rateCard: {
    "claude-sonnet-5-5": {
      inputMicrosPerMillion: 2_000_000,
      cachedInputMicrosPerMillion: 100_000,
      cacheWriteMicrosPerMillion: 2_500_000,
      outputMicrosPerMillion: 10_000_000,
    },
  },
};
const verifiedAt = new Date(rates.verifiedAt).valueOf();
const now = verifiedAt + 3600_000;
// Deliberately not credential-shaped, so the repository secret scan stays clean.
const SYNTHETIC_KEY = "synthetic-anthropic-key-not-real-0123456789";
const PROMPT_HASH = visionPromptHash();
const plan = (env: Record<string, string | undefined> = {}, at = now) =>
  planVisionEval(env, set, routeFile, rates, PROMPT_HASH, at);
/** Starts a run as vision.eval.ts does and collects what it prints. */
const start = async (
  env: Record<string, string | undefined>,
  r: Pick<CandidatesFile, "verifiedAt" | "rateCard"> = rates,
) => {
  const printed: string[] = [];
  const result = await startVisionEval(
    env,
    { set, routeFile, rates: r, now },
    (text) => printed.push(text),
  );
  return { ...result, text: printed.join("\n") };
};

describe("Vision eval route file", () => {
  it("mirrors production's creative_review route on Anthropic", () => {
    expect(routeFile.taskClass).toBe("creative_review");
    expect(routeFile.provider).toBe("anthropic");
    expect(routeFile.route).toEqual({
      model: "claude-sonnet-5-5",
      maxOutputTokens: 1500,
    });
    expect(routeFile.route.reasoningEffort).toBeUndefined();
    expect(routeFile.description).toContain("2026-11-11");
    expect(routeFile.description).toContain("Re-check");
  });

  it("refuses another task class and a provider that does not serve the model", () => {
    expect(() =>
      parseVisionRouteFile({ ...rawRoute, taskClass: "agent_review" }),
    ).toThrow();
    expect(() =>
      parseVisionRouteFile({ ...rawRoute, provider: "openai" }),
    ).toThrow("EVAL_ROUTE_PROVIDER_MISMATCH");
    // Absent, the provider is OpenAI, which does not serve a Claude model.
    const { provider: _provider, ...withoutProvider } = rawRoute;
    expect(() => parseVisionRouteFile(withoutProvider)).toThrow(
      "EVAL_ROUTE_PROVIDER_MISMATCH",
    );
  });
});

describe("Vision eval planning (dry run)", () => {
  it("plans one review call per case under the 0.5 USD ceiling and prints route, worst case, ceiling and confirmation", () => {
    const p = plan();
    expect(p.datasetVersion).toBe("creative-vision-v1");
    expect([p.caseCount, p.good, p.bad, p.calls]).toEqual([8, 4, 4, 8]);
    expect(p.format).toBe("feed_portrait");
    expect(p.provider).toBe("anthropic");
    expect(p.route).toEqual({
      model: "claude-sonnet-5-5",
      maxOutputTokens: 1500,
    });
    expect(VISION_CEILING_USD).toBe(0.5);
    expect(p.maxCostMicros).toBe(500_000);
    expect(p.perCallMicros).toBeGreaterThan(0);
    expect(p.worstCaseMicros).toBe(p.perCallMicros * 8);
    // The worst case fits the ceiling at the catalog price.
    expect(p.worstCaseMicros).toBeLessThanOrEqual(p.maxCostMicros);
    expect(p.promptHash).toBe(PROMPT_HASH);
    expect(p.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(p.confirmation).not.toBe(p.hash);
    expect(p.runtime.verifiedModels).toEqual(["claude-sonnet-5-5"]);
    for (const rate of Object.values(p.runtime.rateCard))
      expect(rate.verifiedAt).toBe(rates.verifiedAt);
    const text = renderVisionPlan(p);
    expect(text).toContain("nothing is transmitted");
    expect(text).toContain("dataset version: creative-vision-v1");
    expect(text).toContain("cases: 8 (4 good, 4 bad), all in feed_portrait");
    expect(text).toContain(
      "route (creative_review): provider anthropic, model claude-sonnet-5-5, reasoning default, max output 1500",
    );
    expect(text).toContain("verify in Orbit Settings");
    expect(text).toContain("8 review calls at most");
    expect(text).toContain(
      `worst-case estimate: $${(p.worstCaseMicros / 1e6).toFixed(4)}`,
    );
    expect(text).toContain("cost ceiling: $0.5000");
    expect(text).not.toContain("note: the worst case exceeds the ceiling");
    expect(text).toContain(p.hash);
    expect(text).toContain(p.promptHash);
    expect(text).toContain(
      `confirmation (ORBIT_EVAL_CONFIRM): ${p.confirmation}`,
    );
    // A lower ceiling below the worst case says so.
    expect(renderVisionPlan(plan({ ORBIT_EVAL_MAX_USD: "0.01" }))).toContain(
      "note: the worst case exceeds the ceiling",
    );
  });

  it("stays a dry run without key and confirmation, prints the plan and sends nothing", async () => {
    vi.mocked(respond).mockClear();
    for (const env of [
      {},
      { ORBIT_EVAL_ANTHROPIC_API_KEY: "  " },
      { ORBIT_EVAL_MAX_USD: "0.25" },
      // A keychain service alone requests nothing.
      { ORBIT_EVAL_KEYCHAIN_SERVICE: "orbit-eval-anthropic" },
    ]) {
      expect(isEvalLiveRequested(env)).toBe(false);
      const result = await start(env);
      expect(result.apiKey).toBeNull();
      expect(result.text).toContain(renderVisionPlan(result.plan));
      expect(result.text).toContain("Dry run only");
      expect(result.text).toContain(
        `ORBIT_EVAL_ANTHROPIC_API_KEY=<key> ORBIT_EVAL_CONFIRM=${result.plan.confirmation} pnpm eval:creative-vision`,
      );
      expect(result.text).toContain(
        `ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-anthropic ORBIT_EVAL_CONFIRM=${result.plan.confirmation} pnpm eval:creative-vision`,
      );
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it("treats a key alone or a confirmation alone as an error, never as a dry run", async () => {
    vi.mocked(respond).mockClear();
    const { confirmation } = plan();
    const keyOnly = { ORBIT_EVAL_ANTHROPIC_API_KEY: SYNTHETIC_KEY };
    expect(isEvalLiveRequested(keyOnly)).toBe(true);
    let thrown: unknown = null;
    try {
      await start(keyOnly);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("EVAL_CONFIRMATION_MISMATCH");
    expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
    const confirmationOnly = { ORBIT_EVAL_CONFIRM: confirmation };
    expect(isEvalLiveRequested(confirmationOnly)).toBe(true);
    await expect(start(confirmationOnly)).rejects.toThrow("EVAL_KEY_REQUIRED");
    await expect(
      start({ ...keyOnly, ORBIT_EVAL_CONFIRM: "0".repeat(64) }),
    ).rejects.toThrow("EVAL_CONFIRMATION_MISMATCH");
    const live = await start({ ...keyOnly, ORBIT_EVAL_CONFIRM: confirmation });
    expect(live.apiKey).toBe(SYNTHETIC_KEY);
    expect(live.text).not.toContain(SYNTHETIC_KEY);
    expect(live.text).not.toContain("Dry run only");
    expect(respond).not.toHaveBeenCalled();
  });

  // Review Focus 5: prices are never invented, and only the route provider's key counts.
  it("refuses a route without a price before any call, and a confirmation without the provider's key", async () => {
    vi.mocked(respond).mockClear();
    const { confirmation } = plan();
    const unpriced = { verifiedAt: rates.verifiedAt, rateCard: {} };
    expect(() =>
      planVisionEval({}, set, routeFile, unpriced, PROMPT_HASH, now),
    ).toThrow("EVAL_ROUTE_NOT_PRICED");
    // Even with a key and a confirmation, the price check comes first.
    await expect(
      start(
        {
          ORBIT_EVAL_ANTHROPIC_API_KEY: SYNTHETIC_KEY,
          ORBIT_EVAL_CONFIRM: confirmation,
        },
        unpriced,
      ),
    ).rejects.toThrow("EVAL_ROUTE_NOT_PRICED");
    // Another model's price does not stand in for the route's.
    const other = {
      verifiedAt: rates.verifiedAt,
      rateCard: {
        "claude-opus-5-5": rates.rateCard["claude-sonnet-5-5"],
      },
    };
    expect(() =>
      planVisionEval({}, set, routeFile, other, PROMPT_HASH, now),
    ).toThrow("EVAL_ROUTE_NOT_PRICED");
    // The OpenAI key is not the Anthropic route's key.
    await expect(
      start({
        ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY,
        ORBIT_EVAL_CONFIRM: confirmation,
      }),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    await expect(
      start({
        ORBIT_EVAL_ANTHROPIC_API_KEY: " ",
        ORBIT_EVAL_CONFIRM: confirmation,
      }),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    expect(respond).not.toHaveBeenCalled();
  });

  it("refuses a stale or future rate card", () => {
    expect(() => plan({}, verifiedAt + 32 * 86_400_000)).toThrow(
      "EVAL_RATE_CARD_STALE",
    );
    expect(() => plan({}, verifiedAt - 1)).toThrow("EVAL_RATE_CARD_FUTURE");
  });

  it("clamps the ceiling to 0.5 USD and lets it only be lowered", () => {
    expect(plan({ ORBIT_EVAL_MAX_USD: "5" }).maxCostMicros).toBe(500_000);
    expect(plan({ ORBIT_EVAL_MAX_USD: "0.5" }).maxCostMicros).toBe(500_000);
    const low = plan({ ORBIT_EVAL_MAX_USD: "0.25" });
    expect(low.maxCostMicros).toBe(250_000);
    expect(low.hash).not.toBe(plan().hash);
    expect(low.confirmation).not.toBe(plan().confirmation);
    for (const bad of ["0", "-1", "abc", "", "Infinity", "NaN", "0.0000001"])
      expect(() => plan({ ORBIT_EVAL_MAX_USD: bad })).toThrow(
        "EVAL_MAX_USD_INVALID",
      );
  });

  it("binds the dataset, the rate card, its date, the provider, the route, the prompt and the ceiling into the confirmation", () => {
    const base = plan();
    expect(base.hash).toBe(
      visionDatasetHash(set, routeFile.route, 500_000, "anthropic"),
    );
    // Stable across copies and over time.
    expect(
      planVisionEval(
        {},
        structuredClone(set),
        structuredClone(routeFile),
        structuredClone(rates),
        PROMPT_HASH,
        now + 86_400_000,
      ).confirmation,
    ).toBe(base.confirmation);
    // A changed vision prompt or output schema.
    const prompted = planVisionEval(
      {},
      set,
      routeFile,
      rates,
      "0".repeat(64),
      now,
    );
    expect(prompted.hash).toBe(base.hash);
    expect(prompted.confirmation).not.toBe(base.confirmation);
    expect(() =>
      planVisionEval({}, set, routeFile, rates, "not-a-hash", now),
    ).toThrow("EVAL_PROMPT_HASH_INVALID");
    // Any price field.
    const priced = structuredClone(rates);
    priced.rateCard["claude-sonnet-5-5"].outputMicrosPerMillion += 1;
    const p = planVisionEval({}, set, routeFile, priced, PROMPT_HASH, now);
    expect(p.hash).toBe(base.hash);
    expect(p.confirmation).not.toBe(base.confirmation);
    // The rate card's date.
    const redated = {
      ...rates,
      verifiedAt: new Date(verifiedAt + 1000).toISOString(),
    };
    expect(
      planVisionEval({}, set, routeFile, redated, PROMPT_HASH, now)
        .confirmation,
    ).not.toBe(base.confirmation);
    // The route.
    const rerouted = structuredClone(routeFile);
    rerouted.route.maxOutputTokens = 2000;
    const r = planVisionEval({}, set, rerouted, rates, PROMPT_HASH, now);
    expect(r.hash).not.toBe(base.hash);
    expect(r.confirmation).not.toBe(base.confirmation);
    // The provider is part of the dataset hash.
    expect(visionDatasetHash(set, routeFile.route, 500_000, "openai")).not.toBe(
      base.hash,
    );
    // A case, a recorded answer and a brand.
    const recased = structuredClone(set);
    recased.cases[1]!.template = "lifestyle";
    expect(
      planVisionEval({}, recased, routeFile, rates, PROMPT_HASH, now).hash,
    ).not.toBe(base.hash);
    const rebranded = structuredClone(set);
    rebranded.brands.lumora.copy.cta = "Shop now";
    const b = planVisionEval({}, rebranded, routeFile, rates, PROMPT_HASH, now);
    expect(b.hash).not.toBe(base.hash);
    expect(b.confirmation).not.toBe(base.confirmation);
  });
});

describe("Vision eval pass rule", () => {
  // Every case as the set expects it, at a known cost.
  const expectedResults = (): Array<
    Pick<VisionCaseResult, "caseId" | "verdict" | "costMicros">
  > =>
    set.cases.map((c) => ({
      caseId: c.id,
      verdict: c.expected,
      costMicros: 4200,
    }));
  const good = set.cases.filter((c) => c.label === "good");
  const bad = set.cases.filter((c) => c.label === "bad");
  const withVerdict = (
    results: ReturnType<typeof expectedResults>,
    ids: string[],
    verdict: VisionCaseResult["verdict"],
  ) => results.map((r) => (ids.includes(r.caseId) ? { ...r, verdict } : r));

  it("passes when every case meets its expectation", () => {
    const outcome = evaluateVisionPassRule(set.cases, expectedResults(), null);
    expect(outcome.pass).toBe(true);
    expect(outcome.goodPasses).toBe(4);
    expect(Object.values(outcome.rules).every(Boolean)).toBe(true);
  });

  it("fails when one bad case passes", () => {
    for (const c of bad) {
      const outcome = evaluateVisionPassRule(
        set.cases,
        withVerdict(expectedResults(), [c.id], "pass"),
        null,
      );
      expect(outcome.pass).toBe(false);
      expect(outcome.rules.noBadPassed).toBe(false);
    }
  });

  it("needs at least 3 of 4 good cases to pass", () => {
    expect(MIN_GOOD_PASSES).toBe(3);
    const two = evaluateVisionPassRule(
      set.cases,
      withVerdict(
        expectedResults(),
        good.slice(0, 2).map((c) => c.id),
        "needs_correction",
      ),
      null,
    );
    expect(two.goodPasses).toBe(2);
    expect(two.rules.goodPassed).toBe(false);
    expect(two.pass).toBe(false);
    const three = evaluateVisionPassRule(
      set.cases,
      withVerdict(expectedResults(), [good[0]!.id], "needs_correction"),
      null,
    );
    expect(three.goodPasses).toBe(3);
    expect(three.rules.goodPassed).toBe(true);
    expect(three.pass).toBe(true);
  });

  it("fails an error, a missing case and an early stop", () => {
    const errored = evaluateVisionPassRule(
      set.cases,
      withVerdict(expectedResults(), [bad[0]!.id], "error"),
      null,
    );
    expect(errored.rules.complete).toBe(false);
    expect(errored.pass).toBe(false);
    const missing = evaluateVisionPassRule(
      set.cases,
      expectedResults().slice(0, 7),
      null,
    );
    expect(missing.rules.complete).toBe(false);
    expect(missing.pass).toBe(false);
    const stopped = evaluateVisionPassRule(
      set.cases,
      expectedResults(),
      "BUDGET_EXCEEDED",
    );
    expect(stopped.rules.complete).toBe(false);
    expect(stopped.pass).toBe(false);
  });

  it("fails a case without a known cost above zero", () => {
    for (const costMicros of [null, 0]) {
      const results = expectedResults().map((r, index) =>
        index === 3 ? { ...r, costMicros } : r,
      );
      const outcome = evaluateVisionPassRule(set.cases, results, null);
      expect(outcome.rules.costsKnown).toBe(false);
      expect(outcome.pass).toBe(false);
    }
  });

  it("counts a good case as passing only with a passing verdict, a bad one with needs_correction", () => {
    expect(visionCasePasses({ label: "good", verdict: "pass" })).toBe(true);
    expect(
      visionCasePasses({ label: "good", verdict: "needs_correction" }),
    ).toBe(false);
    expect(visionCasePasses({ label: "good", verdict: "error" })).toBe(false);
    expect(
      visionCasePasses({ label: "bad", verdict: "needs_correction" }),
    ).toBe(true);
    expect(visionCasePasses({ label: "bad", verdict: "pass" })).toBe(false);
    expect(visionCasePasses({ label: "bad", verdict: "error" })).toBe(false);
  });
});
