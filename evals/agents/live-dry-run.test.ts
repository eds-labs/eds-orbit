import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../generation/harness.ts";
import {
  assertLiveAllowed,
  isLiveRequested,
  parseCandidatesFile,
} from "../generation/live-plan.ts";
import {
  casePasses,
  evaluatePassRule,
  parseRouteFile,
  planReviewEval,
  renderPlan,
  reviewDatasetHash,
  type VerdictClass,
} from "./live-plan.ts";
import { isBareHost, parseReviewSet } from "./review-set.ts";
import rawSet from "./review-v1.json" with { type: "json" };
import rawRoute from "./review-route-v1.json" with { type: "json" };
import rawRates from "../generation/candidates-v1.json" with { type: "json" };

// Planning only: nothing here touches a database or the network.
const set = parseReviewSet(rawSet);
const routeFile = parseRouteFile(rawRoute);
const rates = parseCandidatesFile(rawRates);
const verifiedAt = new Date(rates.verifiedAt).valueOf();
const now = verifiedAt + 3600_000;
// Deliberately not credential-shaped, so the repository secret scan stays clean.
const SYNTHETIC_KEY = "synthetic-eval-key-not-real-0123456789";
const plan = (env: Record<string, string | undefined> = {}, at = now) =>
  planReviewEval(env, set, routeFile, rates, at);

describe("Live review eval planning (dry run)", () => {
  it("plans one review call per case under a 1 USD ceiling and prints it without secrets", () => {
    const p = plan({ ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY });
    expect(p.datasetVersion).toBe("agents-review-v1");
    expect(p.caseCount).toBe(21);
    expect([p.good, p.bad, p.bareHost]).toEqual([8, 12, 1]);
    expect(p.calls).toBe(21);
    expect(p.expectedModelCalls).toBe(
      set.cases.filter((c) => c.expected.modelSees).length,
    );
    expect(p.route).toEqual({ model: "gpt-6.1-sol", maxOutputTokens: 1800 });
    expect(p.maxCostMicros).toBe(1_000_000);
    expect(p.perCallMicros).toBeGreaterThan(0);
    expect(p.worstCaseMicros).toBe(p.perCallMicros * 21);
    expect(p.runtime.verifiedModels).toEqual(["gpt-6.1-sol"]);
    for (const rate of Object.values(p.runtime.rateCard))
      expect(rate.verifiedAt).toBe(rates.verifiedAt);
    const text = renderPlan(p);
    expect(text).toContain("nothing is transmitted");
    expect(text).toContain("21 planned review calls at most");
    expect(text).toContain("up to 3 times per draft");
    expect(text).toContain("cost ceiling: $1.0000");
    expect(text).toContain(p.hash);
    expect(text).toContain(p.confirmation);
    expect(text).not.toContain(SYNTHETIC_KEY);
  });

  it("stays a dry run without key and confirmation", () => {
    expect(isLiveRequested({})).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: "  " })).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_MAX_USD: "0.5" })).toBe(false);
  });

  it("clamps a ceiling above 1 USD and refuses a malformed one", () => {
    expect(plan({ ORBIT_EVAL_MAX_USD: "5" }).maxCostMicros).toBe(1_000_000);
    expect(plan({ ORBIT_EVAL_MAX_USD: "50" }).maxCostMicros).toBe(1_000_000);
    const low = plan({ ORBIT_EVAL_MAX_USD: "0.25" });
    expect(low.maxCostMicros).toBe(250_000);
    expect(low.hash).not.toBe(plan().hash);
    expect(low.confirmation).not.toBe(plan().confirmation);
    for (const bad of ["0", "-1", "abc", "", "Infinity", "NaN", "0.0000001"])
      expect(() => plan({ ORBIT_EVAL_MAX_USD: bad })).toThrow(
        "EVAL_MAX_USD_INVALID",
      );
  });

  it("binds the dataset, the complete rate card, its date, the route and the ceiling into the confirmation", () => {
    const base = plan();
    expect(base.hash).toBe(
      reviewDatasetHash(set.cases, routeFile.route, 1_000_000),
    );
    expect(base.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(base.confirmation).not.toBe(base.hash);
    // Stable across copies and over time.
    expect(
      planReviewEval(
        {},
        structuredClone(set),
        structuredClone(routeFile),
        structuredClone(rates),
        now + 86_400_000,
      ).confirmation,
    ).toBe(base.confirmation);
    // Any price, including one of a model the route does not use.
    for (const model of [
      "gpt-6.1-sol",
      "gpt-6-luna",
      "text-embedding-3-small",
    ]) {
      const edited = structuredClone(rates);
      edited.rateCard[model]!.inputMicrosPerMillion += 1;
      const p = planReviewEval({}, set, routeFile, edited, now);
      expect(p.confirmation).not.toBe(base.confirmation);
      expect(p.hash).toBe(base.hash);
    }
    const redated = structuredClone(rates);
    redated.verifiedAt = new Date(verifiedAt + 1000).toISOString();
    expect(
      planReviewEval({}, set, routeFile, redated, now).confirmation,
    ).not.toBe(base.confirmation);
    const rerouted = structuredClone(routeFile);
    rerouted.route.reasoningEffort = "low";
    const r = planReviewEval({}, set, rerouted, rates, now);
    expect(r.confirmation).not.toBe(base.confirmation);
    expect(r.hash).not.toBe(base.hash);
    const edited = structuredClone(set);
    edited.cases[0]!.body += " Today.";
    expect(planReviewEval({}, edited, routeFile, rates, now).hash).not.toBe(
      base.hash,
    );
  });

  it("refuses a stale or future rate card and an unpriced route", () => {
    expect(() => plan({}, verifiedAt + 32 * 86_400_000)).toThrow(
      "EVAL_RATE_CARD_STALE",
    );
    expect(() => plan({}, verifiedAt + 31 * 86_400_000)).not.toThrow();
    expect(() => plan({}, verifiedAt - 1)).toThrow("EVAL_RATE_CARD_FUTURE");
    const unpriced = structuredClone(routeFile);
    unpriced.route.model = "gpt-5.6-sol";
    expect(() => planReviewEval({}, set, unpriced, rates, now)).toThrow(
      "EVAL_ROUTE_NOT_PRICED",
    );
    expect(() =>
      parseRouteFile({ ...rawRoute, taskClass: "draft_social" }),
    ).toThrow();
  });
});

describe("Live review eval gate", () => {
  const { confirmation, hash } = plan();

  it("refuses a confirmation that does not match", () => {
    const key = { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY };
    for (const wrong of ["0".repeat(64), confirmation + " ", hash])
      expect(() =>
        assertLiveAllowed({ ...key, ORBIT_EVAL_CONFIRM: wrong }, confirmation),
      ).toThrow("EVAL_CONFIRMATION_MISMATCH");
    // A confirmation made for another ceiling does not carry over.
    expect(() =>
      assertLiveAllowed(
        {
          ...key,
          ORBIT_EVAL_CONFIRM: plan({ ORBIT_EVAL_MAX_USD: "0.5" }).confirmation,
        },
        confirmation,
      ),
    ).toThrow("EVAL_CONFIRMATION_MISMATCH");
  });

  it("treats a key alone or a confirmation alone as an error, never as a dry run", () => {
    const keyOnly = { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY };
    expect(isLiveRequested(keyOnly)).toBe(true);
    expect(() => assertLiveAllowed(keyOnly, confirmation)).toThrow(
      "EVAL_CONFIRMATION_MISMATCH",
    );
    const confirmationOnly = { ORBIT_EVAL_CONFIRM: confirmation };
    expect(isLiveRequested(confirmationOnly)).toBe(true);
    expect(() => assertLiveAllowed(confirmationOnly, confirmation)).toThrow(
      "EVAL_KEY_REQUIRED",
    );
    let thrown: unknown = null;
    try {
      assertLiveAllowed(
        { ...keyOnly, ORBIT_EVAL_CONFIRM: "wrong" },
        confirmation,
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
    expect(
      assertLiveAllowed(
        { ...keyOnly, ORBIT_EVAL_CONFIRM: confirmation },
        confirmation,
      ),
    ).toBe(SYNTHETIC_KEY);
  });

  it("refuses a database that is not local", () => {
    const local = "postgresql://orbit@127.0.0.1:55432/orbit_test";
    expect(() =>
      assertLocalDatabase({ DATABASE_URL: local, AUTH_DATABASE_URL: local }),
    ).not.toThrow();
    for (const remote of [
      "postgresql://orbit@db.example.com:5432/orbit",
      "postgresql://orbit@10.0.0.5:5432/orbit",
      "not a url",
      undefined,
    ]) {
      expect(() =>
        assertLocalDatabase({ DATABASE_URL: remote, AUTH_DATABASE_URL: local }),
      ).toThrow("EVAL_DATABASE_NOT_LOCAL");
      expect(() =>
        assertLocalDatabase({ DATABASE_URL: local, AUTH_DATABASE_URL: remote }),
      ).toThrow("EVAL_DATABASE_NOT_LOCAL");
    }
  });
});

describe("Review eval pass rule", () => {
  // The expected outcome of every case: good ones approved, bad ones rejected, the bare host left for the owner.
  const expected = () =>
    set.cases.map((c) => ({
      caseId: c.id,
      verdict: (c.expected.verdict === "reject"
        ? c.expected.deterministic.length
          ? "blocked"
          : "reject"
        : c.expected.verdict) as VerdictClass,
    }));
  const withVerdict = (id: string, verdict: VerdictClass) =>
    expected().map((r) => (r.caseId === id ? { ...r, verdict } : r));
  const goodCase = set.cases.find((c) => c.label === "good")!;
  const badCase = set.cases.find((c) => c.label === "bad" && !isBareHost(c))!;
  const bareHost = set.cases.find(isBareHost)!;

  it("passes when every case meets its expectation", () => {
    const outcome = evaluatePassRule(set.cases, expected(), null);
    expect(outcome.pass).toBe(true);
    expect(Object.values(outcome.rules).every(Boolean)).toBe(true);
  });

  it("fails when a bad case is approved", () => {
    const outcome = evaluatePassRule(
      set.cases,
      withVerdict(badCase.id, "approve"),
      null,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.rules.noBadApproved).toBe(false);
    expect(outcome.rules.bareHostNotApproved).toBe(true);
    expect(casePasses({ label: "bad", verdict: "approve" })).toBe(false);
  });

  it("fails when the bare host is approved", () => {
    const outcome = evaluatePassRule(
      set.cases,
      withVerdict(bareHost.id, "approve"),
      null,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.rules.bareHostNotApproved).toBe(false);
    expect(outcome.rules.noBadApproved).toBe(true);
  });

  it("passes a good case left for the owner, and a bad one rejected by the model instead of blocked", () => {
    const owner = evaluatePassRule(
      set.cases,
      withVerdict(goodCase.id, "owner"),
      null,
    );
    expect(owner.pass).toBe(true);
    expect(casePasses({ label: "good", verdict: "owner" })).toBe(true);
    for (const verdict of ["reject", "revise", "owner", "blocked"] as const)
      expect(
        evaluatePassRule(set.cases, withVerdict(badCase.id, verdict), null)
          .pass,
      ).toBe(true);
  });

  it("fails a good case that is not approved, an error and an incomplete run", () => {
    for (const verdict of ["reject", "revise", "blocked", "error"] as const) {
      const outcome = evaluatePassRule(
        set.cases,
        withVerdict(goodCase.id, verdict),
        null,
      );
      expect(outcome.pass).toBe(false);
      expect(outcome.rules.goodApprovedOrOwner).toBe(false);
    }
    const errored = evaluatePassRule(
      set.cases,
      withVerdict(badCase.id, "error"),
      null,
    );
    expect(errored.rules.noBadApproved).toBe(true);
    expect(errored.rules.complete).toBe(false);
    expect(errored.pass).toBe(false);
    const partial = evaluatePassRule(set.cases, expected().slice(0, 5), null);
    expect(partial.rules.complete).toBe(false);
    expect(partial.pass).toBe(false);
    const stopped = evaluatePassRule(set.cases, expected(), "BUDGET_EXCEEDED");
    expect(stopped.pass).toBe(false);
  });
});
