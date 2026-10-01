import { describe, expect, it } from "vitest";
import { datasetHash, parseFixtures } from "./harness.ts";
import {
  assertLiveAllowed,
  isLiveRequested,
  parseCandidatesFile,
  planLiveEval,
  renderPlan,
} from "./live-plan.ts";
import rawFixtures from "./fixtures-v1.json" with { type: "json" };
import rawCandidates from "./candidates-v1.json" with { type: "json" };

// Planning only: nothing here touches a database or the network.
const fixtures = parseFixtures(rawFixtures);
const candidates = parseCandidatesFile(rawCandidates);
const verifiedAt = new Date(candidates.verifiedAt).valueOf();
const now = verifiedAt + 3600_000;
const SYNTHETIC_KEY = "sk-synthetic-not-a-real-key-0123456789";

describe("Live generation eval planning", () => {
  it("plans cases x candidates x repetitions calls under the hard ceiling", () => {
    const plan = planLiveEval({}, fixtures, candidates, now);
    expect(plan.calls).toBe(
      fixtures.cases.length *
        candidates.candidates.length *
        candidates.repetitions,
    );
    expect(plan.calls).toBe(8 * 4 * 2);
    expect(plan.maxCostMicros).toBe(5_000_000);
    expect(plan.worstCaseMicros).toBeGreaterThan(0);
    expect(plan.datasetVersion).toBe(fixtures.datasetVersion);
  });

  it("never lets the environment raise the ceiling above 5 USD", () => {
    const high = planLiveEval(
      { ORBIT_EVAL_MAX_USD: "50" },
      fixtures,
      candidates,
      now,
    );
    expect(high.maxCostMicros).toBe(5_000_000);
    const low = planLiveEval(
      { ORBIT_EVAL_MAX_USD: "0.5" },
      fixtures,
      candidates,
      now,
    );
    expect(low.maxCostMicros).toBe(500_000);
    expect(low.hash).not.toBe(high.hash);
    for (const bad of ["0", "-1", "abc", "", "Infinity", "NaN", "0.0000001"])
      expect(() =>
        planLiveEval({ ORBIT_EVAL_MAX_USD: bad }, fixtures, candidates, now),
      ).toThrow("EVAL_MAX_USD_INVALID");
  });

  it("prints a stable hash that matches the harness dataset hash", () => {
    const first = planLiveEval({}, fixtures, candidates, now);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      planLiveEval({}, structuredClone(fixtures), candidates, now).hash,
    ).toBe(first.hash);
    expect(first.hash).toBe(
      datasetHash(
        fixtures.cases,
        candidates.candidates,
        candidates.repetitions,
        5_000_000,
      ),
    );
    const changed = structuredClone(candidates);
    changed.candidates[0]!.route.maxOutputTokens = 1700;
    expect(planLiveEval({}, fixtures, changed, now).hash).not.toBe(first.hash);
  });

  it("applies the verification date per model and refuses a stale rate card", () => {
    const plan = planLiveEval({}, fixtures, candidates, now);
    for (const rate of Object.values(plan.runtime.rateCard))
      expect(rate.verifiedAt).toBe(candidates.verifiedAt);
    expect(plan.runtime.verifiedModels).toEqual([
      "gpt-5.6-terra",
      "gpt-6.1-sol",
      "gpt-6-luna",
    ]);
    expect(() =>
      planLiveEval({}, fixtures, candidates, verifiedAt + 32 * 86_400_000),
    ).toThrow("EVAL_RATE_CARD_STALE");
    // Still valid at the production limit of 31 days.
    expect(() =>
      planLiveEval({}, fixtures, candidates, verifiedAt + 31 * 86_400_000),
    ).not.toThrow();
  });

  it("rejects a candidate without a price and a malformed file", () => {
    const unpriced = structuredClone(candidates);
    unpriced.candidates[0]!.route.model = "gpt-unpriced";
    expect(() => planLiveEval({}, fixtures, unpriced, now)).toThrow(
      "EVAL_CANDIDATE_NOT_PRICED",
    );
    expect(() =>
      parseCandidatesFile({ ...rawCandidates, repetitions: 0 }),
    ).toThrow();
    expect(() =>
      parseCandidatesFile({ ...rawCandidates, extra: true }),
    ).toThrow();
  });

  it("renders the plan without secrets", () => {
    const plan = planLiveEval(
      { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY },
      fixtures,
      candidates,
      now,
    );
    const text = renderPlan(plan);
    expect(text).not.toContain(SYNTHETIC_KEY);
    expect(text).toContain(plan.hash);
    expect(text).toContain("64 planned calls");
    expect(text).toContain("terra-default");
  });
});

describe("Live run gate", () => {
  const hash = planLiveEval({}, fixtures, candidates, now).hash;

  it("stays a dry run without key and confirmation", () => {
    expect(isLiveRequested({})).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: "" })).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_CONFIRM: hash })).toBe(true);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY })).toBe(
      true,
    );
  });

  it("requires a key", () => {
    expect(() => assertLiveAllowed({}, hash)).toThrow("EVAL_KEY_REQUIRED");
    expect(() =>
      assertLiveAllowed(
        { ORBIT_EVAL_OPENAI_API_KEY: "  ", ORBIT_EVAL_CONFIRM: hash },
        hash,
      ),
    ).toThrow("EVAL_KEY_REQUIRED");
  });

  it("requires the exact confirmation hash", () => {
    const key = { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY };
    expect(() => assertLiveAllowed(key, hash)).toThrow(
      "EVAL_CONFIRMATION_MISMATCH",
    );
    expect(() =>
      assertLiveAllowed({ ...key, ORBIT_EVAL_CONFIRM: "0".repeat(64) }, hash),
    ).toThrow("EVAL_CONFIRMATION_MISMATCH");
    expect(() =>
      assertLiveAllowed({ ...key, ORBIT_EVAL_CONFIRM: hash + " " }, hash),
    ).toThrow("EVAL_CONFIRMATION_MISMATCH");
  });

  it("returns the key only for a matching confirmation and never echoes it in errors", () => {
    const env = {
      ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY,
      ORBIT_EVAL_CONFIRM: hash,
    };
    expect(assertLiveAllowed(env, hash)).toBe(SYNTHETIC_KEY);
    try {
      assertLiveAllowed({ ...env, ORBIT_EVAL_CONFIRM: "wrong" }, hash);
    } catch (error) {
      expect(String(error)).not.toContain(SYNTHETIC_KEY);
    }
  });
});
