import { describe, expect, it } from "vitest";
import { datasetHash, parseFixtures } from "./harness.ts";
import {
  assertLiveAllowed,
  type CandidatesFile,
  isLiveRequested,
  parseCandidatesFile,
  planLiveEval,
  redactSecret,
  renderPlan,
} from "./live-plan.ts";
import rawFixtures from "./fixtures-v1.json" with { type: "json" };
import rawCandidates from "./candidates-v1.json" with { type: "json" };

// Planning only: nothing here touches a database or the network.
const fixtures = parseFixtures(rawFixtures);
const candidates = parseCandidatesFile(rawCandidates);
const verifiedAt = new Date(candidates.verifiedAt).valueOf();
const now = verifiedAt + 3600_000;
// Deliberately not credential-shaped, so the repository secret scan stays clean.
const SYNTHETIC_KEY = "synthetic-eval-key-not-real-0123456789";

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
    // Still valid at the eval limit of 31 days.
    expect(() =>
      planLiveEval({}, fixtures, candidates, verifiedAt + 31 * 86_400_000),
    ).not.toThrow();
  });

  it("refuses a future-dated rate card", () => {
    expect(() =>
      planLiveEval({}, fixtures, candidates, verifiedAt - 1),
    ).toThrow("EVAL_RATE_CARD_FUTURE");
    expect(() =>
      planLiveEval({}, fixtures, candidates, verifiedAt),
    ).not.toThrow();
  });

  it("binds the rate card, its date and the ceiling into the confirmation", () => {
    const base = planLiveEval({}, fixtures, candidates, now);
    expect(base.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(base.confirmation).not.toBe(base.hash);
    expect(
      planLiveEval(
        {},
        structuredClone(fixtures),
        structuredClone(candidates),
        now,
      ).confirmation,
    ).toBe(base.confirmation);
    // The confirmation does not depend on when the plan was made.
    expect(
      planLiveEval({}, fixtures, candidates, now + 86_400_000).confirmation,
    ).toBe(base.confirmation);

    const priced = (edit: (card: CandidatesFile["rateCard"]) => void) => {
      const copy = structuredClone(candidates);
      edit(copy.rateCard);
      return planLiveEval({}, fixtures, copy, now);
    };
    for (const field of [
      "inputMicrosPerMillion",
      "cachedInputMicrosPerMillion",
      "cacheWriteMicrosPerMillion",
      "outputMicrosPerMillion",
    ] as const) {
      const edited = priced((card) => {
        card["gpt-6.1-sol"]![field] = card["gpt-6.1-sol"]![field]! + 1;
      });
      expect(edited.confirmation).not.toBe(base.confirmation);
      // Prices are not part of the dataset hash.
      expect(edited.hash).toBe(base.hash);
    }
    // The embedding price is bound as well.
    expect(
      priced((card) => {
        card["text-embedding-3-small"]!.inputMicrosPerMillion += 1;
      }).confirmation,
    ).not.toBe(base.confirmation);

    const redated = structuredClone(candidates);
    redated.verifiedAt = new Date(verifiedAt + 1000).toISOString();
    const dated = planLiveEval({}, fixtures, redated, now);
    expect(dated.confirmation).not.toBe(base.confirmation);
    expect(dated.hash).toBe(base.hash);

    const lowered = planLiveEval(
      { ORBIT_EVAL_MAX_USD: "4" },
      fixtures,
      candidates,
      now,
    );
    expect(lowered.confirmation).not.toBe(base.confirmation);
    expect(lowered.hash).not.toBe(base.hash);
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
    expect(text).toContain(plan.confirmation);
    expect(text).toContain("64 planned calls");
    expect(text).toContain("terra-default");
  });
});

describe("Live run gate", () => {
  const plan = planLiveEval({}, fixtures, candidates, now);
  const confirmation = plan.confirmation;

  it("stays a dry run without key and confirmation", () => {
    expect(isLiveRequested({})).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: "" })).toBe(false);
    // A whitespace-only key without confirmation is still a dry run.
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: "  " })).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_CONFIRM: confirmation })).toBe(true);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY })).toBe(
      true,
    );
  });

  it("requires a key", () => {
    expect(() => assertLiveAllowed({}, confirmation)).toThrow(
      "EVAL_KEY_REQUIRED",
    );
    expect(() =>
      assertLiveAllowed(
        { ORBIT_EVAL_OPENAI_API_KEY: "  ", ORBIT_EVAL_CONFIRM: confirmation },
        confirmation,
      ),
    ).toThrow("EVAL_KEY_REQUIRED");
  });

  it("requires the exact confirmation, not the dataset hash", () => {
    const key = { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY };
    expect(() => assertLiveAllowed(key, confirmation)).toThrow(
      "EVAL_CONFIRMATION_MISMATCH",
    );
    for (const wrong of ["0".repeat(64), confirmation + " ", plan.hash])
      expect(() =>
        assertLiveAllowed({ ...key, ORBIT_EVAL_CONFIRM: wrong }, confirmation),
      ).toThrow("EVAL_CONFIRMATION_MISMATCH");
  });

  it("returns the key only for a matching confirmation and never echoes it in errors", () => {
    const env = {
      ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY,
      ORBIT_EVAL_CONFIRM: confirmation,
    };
    expect(assertLiveAllowed(env, confirmation)).toBe(SYNTHETIC_KEY);
    let thrown: unknown = null;
    try {
      assertLiveAllowed({ ...env, ORBIT_EVAL_CONFIRM: "wrong" }, confirmation);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("EVAL_CONFIRMATION_MISMATCH");
    expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
  });
});

describe("Secret redaction", () => {
  it("removes the key from message and stack and drops the cause", () => {
    const original = new Error(`provider rejected ${SYNTHETIC_KEY} twice`, {
      cause: new Error(SYNTHETIC_KEY),
    });
    original.stack = `Error: ${SYNTHETIC_KEY}\n    at call (${SYNTHETIC_KEY}.ts:1:1)`;
    const safe = redactSecret(original, SYNTHETIC_KEY);
    expect(safe).toBeInstanceOf(Error);
    expect(safe).not.toBe(original);
    expect(safe.message).toBe("provider rejected [redacted] twice");
    expect(safe.stack).not.toContain(SYNTHETIC_KEY);
    expect(safe.stack).toContain("[redacted]");
    expect(safe.cause).toBeUndefined();
    expect(
      JSON.stringify(safe, Object.getOwnPropertyNames(safe)),
    ).not.toContain(SYNTHETIC_KEY);
  });

  it("handles non-Error values and keeps other text", () => {
    expect(redactSecret(`bad ${SYNTHETIC_KEY}`, SYNTHETIC_KEY).message).toBe(
      "bad [redacted]",
    );
    expect(
      redactSecret(new Error("EVAL_DATABASE_NOT_LOCAL"), SYNTHETIC_KEY).message,
    ).toBe("EVAL_DATABASE_NOT_LOCAL");
  });
});
