import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../generation/harness.ts";
import {
  assertLiveAllowed,
  isLiveRequested,
  parseCandidatesFile,
} from "../generation/live-plan.ts";
import {
  caseAsPlanned,
  casePasses,
  DIAGNOSTIC_CEILING_USD,
  diagnoseMode,
  evaluatePassRule,
  gateResult,
  parseRouteFile,
  planReviewEval,
  renderPlan,
  reviewDatasetHash,
  type VerdictClass,
} from "./live-plan.ts";
import { isBareHost, parseReviewSet } from "./review-set.ts";
import { reviewPromptHash } from "./code-version.ts";
import rawSet from "./review-v2.json" with { type: "json" };
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
const PROMPT_HASH = reviewPromptHash();
const plan = (env: Record<string, string | undefined> = {}, at = now) =>
  planReviewEval(env, set, routeFile, rates, PROMPT_HASH, at);

describe("Live review eval planning (dry run)", () => {
  it("plans at most two review calls per case under a 2 USD ceiling and prints it without secrets", () => {
    const p = plan({ ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY });
    expect(p.datasetVersion).toBe("agents-review-v2");
    expect(p.caseCount).toBe(26);
    expect([p.good, p.bad, p.bareHost]).toEqual([8, 17, 1]);
    expect(p.calls).toBe(52);
    expect(p.expectedModelCalls).toBe(20);
    expect(p.expectedModelCalls).toBe(
      set.cases.filter((c) => c.expected.modelSees).length,
    );
    expect(p.route).toEqual({ model: "gpt-6.1-sol", maxOutputTokens: 1800 });
    expect(p.maxCostMicros).toBe(2_000_000);
    expect(p.perCallMicros).toBeGreaterThan(0);
    expect(p.worstCaseMicros).toBe(p.perCallMicros * 52);
    // A full run with every round-2 call fits under the ceiling.
    expect(p.worstCaseMicros).toBeLessThanOrEqual(p.maxCostMicros);
    expect(p.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.runtime.verifiedModels).toEqual(["gpt-6.1-sol"]);
    for (const rate of Object.values(p.runtime.rateCard))
      expect(rate.verifiedAt).toBe(rates.verifiedAt);
    const text = renderPlan(p);
    expect(text).toContain("nothing is transmitted");
    expect(text).toContain("52 review calls at most");
    expect(text).toContain("round 2");
    expect(text).toContain("verify in Orbit Settings");
    expect(text).toContain("cost ceiling: $2.0000");
    expect(text).toContain(p.promptHash);
    expect(text).toContain(p.hash);
    expect(text).toContain(p.confirmation);
    expect(text).not.toContain(SYNTHETIC_KEY);
  });

  it("stays a dry run without key and confirmation", () => {
    expect(isLiveRequested({})).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: "  " })).toBe(false);
    expect(isLiveRequested({ ORBIT_EVAL_MAX_USD: "0.5" })).toBe(false);
  });

  it("clamps a ceiling above 2 USD and refuses a malformed one", () => {
    expect(plan({ ORBIT_EVAL_MAX_USD: "5" }).maxCostMicros).toBe(2_000_000);
    expect(plan({ ORBIT_EVAL_MAX_USD: "50" }).maxCostMicros).toBe(2_000_000);
    const low = plan({ ORBIT_EVAL_MAX_USD: "0.25" });
    expect(low.maxCostMicros).toBe(250_000);
    expect(low.hash).not.toBe(plan().hash);
    expect(low.confirmation).not.toBe(plan().confirmation);
    for (const bad of ["0", "-1", "abc", "", "Infinity", "NaN", "0.0000001"])
      expect(() => plan({ ORBIT_EVAL_MAX_USD: bad })).toThrow(
        "EVAL_MAX_USD_INVALID",
      );
  });

  it("binds the dataset, the complete rate card, its date, the route, the prompt and the ceiling into the confirmation", () => {
    const base = plan();
    expect(base.hash).toBe(
      reviewDatasetHash(set.cases, routeFile.route, 2_000_000, set.brief),
    );
    // A changed review prompt or output schema invalidates the approval.
    const prompted = planReviewEval(
      {},
      set,
      routeFile,
      rates,
      "0".repeat(64),
      now,
    );
    expect(prompted.confirmation).not.toBe(base.confirmation);
    expect(prompted.hash).toBe(base.hash);
    expect(base.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(base.confirmation).not.toBe(base.hash);
    // Stable across copies and over time.
    expect(
      planReviewEval(
        {},
        structuredClone(set),
        structuredClone(routeFile),
        structuredClone(rates),
        PROMPT_HASH,
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
      const p = planReviewEval({}, set, routeFile, edited, PROMPT_HASH, now);
      expect(p.confirmation).not.toBe(base.confirmation);
      expect(p.hash).toBe(base.hash);
    }
    const redated = structuredClone(rates);
    redated.verifiedAt = new Date(verifiedAt + 1000).toISOString();
    expect(
      planReviewEval({}, set, routeFile, redated, PROMPT_HASH, now)
        .confirmation,
    ).not.toBe(base.confirmation);
    const rerouted = structuredClone(routeFile);
    rerouted.route.reasoningEffort = "low";
    const r = planReviewEval({}, set, rerouted, rates, PROMPT_HASH, now);
    expect(r.confirmation).not.toBe(base.confirmation);
    expect(r.hash).not.toBe(base.hash);
    const edited = structuredClone(set);
    edited.cases[0]!.body += " Today.";
    expect(
      planReviewEval({}, edited, routeFile, rates, PROMPT_HASH, now).hash,
    ).not.toBe(base.hash);
    // The brief the drafts answer is part of what is measured.
    const rebriefed = structuredClone(set);
    rebriefed.brief.cta = "Join the beta.";
    const b = planReviewEval({}, rebriefed, routeFile, rates, PROMPT_HASH, now);
    expect(b.hash).not.toBe(base.hash);
    expect(b.confirmation).not.toBe(base.confirmation);
  });

  it("uses a brief the good drafts follow", () => {
    expect(set.brief.cta).toBe("Learn more.");
    for (const c of set.cases.filter((c) => c.label === "good"))
      expect(c.body.trim().endsWith(set.brief.cta)).toBe(true);
  });

  it("refuses a stale or future rate card and an unpriced route", () => {
    expect(() => plan({}, verifiedAt + 32 * 86_400_000)).toThrow(
      "EVAL_RATE_CARD_STALE",
    );
    expect(() => plan({}, verifiedAt + 31 * 86_400_000)).not.toThrow();
    expect(() => plan({}, verifiedAt - 1)).toThrow("EVAL_RATE_CARD_FUTURE");
    const unpriced = structuredClone(routeFile);
    unpriced.route.model = "gpt-5.6-sol";
    expect(() =>
      planReviewEval({}, set, unpriced, rates, PROMPT_HASH, now),
    ).toThrow("EVAL_ROUTE_NOT_PRICED");
    expect(() =>
      parseRouteFile({ ...rawRoute, taskClass: "draft_social" }),
    ).toThrow();
  });
});

describe("Live review eval diagnostic mode (dry run)", () => {
  const diagnose = { ORBIT_EVAL_DIAGNOSE: "good" };
  const goodIds = set.cases.filter((c) => c.label === "good").map((c) => c.id);

  it("plans only the good cases, at most two calls each, under a 0.5 USD ceiling, and says so", () => {
    const p = plan(diagnose);
    expect(p.mode).toBe("diagnose-good");
    expect(p.cases.map((c) => c.id)).toEqual(goodIds);
    expect(p.caseCount).toBe(8);
    expect([p.good, p.bad, p.bareHost]).toEqual([8, 0, 0]);
    expect(p.calls).toBe(16);
    expect(p.worstCaseMicros).toBe(p.perCallMicros * 16);
    expect(p.maxCostMicros).toBe(500_000);
    expect(DIAGNOSTIC_CEILING_USD).toBe(0.5);
    expect(p.hash).toBe(
      reviewDatasetHash(p.cases, routeFile.route, 500_000, set.brief),
    );
    const text = renderPlan(p);
    expect(text).toContain("DIAGNOSTIC");
    expect(text).toContain("not a gate result");
    expect(text).toContain("cases: 8 (8 good, 0 bad, 0 bare host)");
    expect(text).toContain("16 review calls at most (two per case");
    expect(text).toContain("worst-case estimate: ");
    expect(text).toContain("cost ceiling: $0.5000");
    for (const id of goodIds) expect(text).toContain(id);
    expect(text).toContain(p.confirmation);
    // The normal plan says nothing about a diagnostic run.
    expect(plan().mode).toBe("normal");
    expect(plan().cases).toEqual(set.cases);
    expect(renderPlan(plan())).not.toContain("DIAGNOSTIC");
  });

  it("binds the mode and the case subset into a confirmation of its own", () => {
    const normal = plan();
    const diag = plan(diagnose);
    expect(diag.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(diag.confirmation).not.toBe(normal.confirmation);
    expect(diag.hash).not.toBe(normal.hash);
    // Even at the same ceiling the two modes never share a confirmation.
    const sameCeiling = plan({ ORBIT_EVAL_MAX_USD: "0.5" });
    expect(sameCeiling.maxCostMicros).toBe(diag.maxCostMicros);
    expect(sameCeiling.confirmation).not.toBe(diag.confirmation);
    // Stable across copies.
    expect(
      planReviewEval(
        diagnose,
        structuredClone(set),
        structuredClone(routeFile),
        structuredClone(rates),
        PROMPT_HASH,
        now,
      ).confirmation,
    ).toBe(diag.confirmation);
    // A changed good case changes the subset and the confirmation.
    const edited = structuredClone(set);
    edited.cases.find((c) => c.label === "good")!.body += " Today.";
    expect(
      planReviewEval(diagnose, edited, routeFile, rates, PROMPT_HASH, now)
        .confirmation,
    ).not.toBe(diag.confirmation);
    // A changed bad case does not touch the diagnostic subset.
    const badEdited = structuredClone(set);
    badEdited.cases.find((c) => c.label === "bad")!.body += " Today.";
    expect(
      planReviewEval(diagnose, badEdited, routeFile, rates, PROMPT_HASH, now)
        .confirmation,
    ).toBe(diag.confirmation);
  });

  it("refuses a normal confirmation in diagnostic mode, and the reverse", () => {
    const key = { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY };
    const normal = plan();
    const diag = plan(diagnose);
    expect(() =>
      assertLiveAllowed(
        { ...key, ...diagnose, ORBIT_EVAL_CONFIRM: normal.confirmation },
        diag.confirmation,
      ),
    ).toThrow("EVAL_CONFIRMATION_MISMATCH");
    expect(() =>
      assertLiveAllowed(
        { ...key, ORBIT_EVAL_CONFIRM: diag.confirmation },
        normal.confirmation,
      ),
    ).toThrow("EVAL_CONFIRMATION_MISMATCH");
    expect(
      assertLiveAllowed(
        { ...key, ...diagnose, ORBIT_EVAL_CONFIRM: diag.confirmation },
        diag.confirmation,
      ),
    ).toBe(SYNTHETIC_KEY);
  });

  it("clamps the ceiling to 0.5 USD and lets it only be lowered", () => {
    for (const raw of ["0.5", "2", "5", "50"])
      expect(plan({ ...diagnose, ORBIT_EVAL_MAX_USD: raw }).maxCostMicros).toBe(
        500_000,
      );
    expect(plan({ ...diagnose, ORBIT_EVAL_MAX_USD: "0.2" }).maxCostMicros).toBe(
      200_000,
    );
    expect(() => plan({ ...diagnose, ORBIT_EVAL_MAX_USD: "" })).toThrow(
      "EVAL_MAX_USD_INVALID",
    );
    // The normal ceiling stays 2 USD.
    expect(plan({ ORBIT_EVAL_MAX_USD: "5" }).maxCostMicros).toBe(2_000_000);
  });

  it("accepts only the good subset and refuses any other value", () => {
    expect(diagnoseMode({})).toBeNull();
    expect(diagnoseMode(diagnose)).toBe("good");
    for (const bad of ["", " ", "bad", "GOOD", "all", "true", "1"]) {
      expect(() => diagnoseMode({ ORBIT_EVAL_DIAGNOSE: bad })).toThrow(
        "EVAL_DIAGNOSE_INVALID",
      );
      expect(() => plan({ ORBIT_EVAL_DIAGNOSE: bad })).toThrow(
        "EVAL_DIAGNOSE_INVALID",
      );
    }
  });

  it("never counts a diagnostic run as PASS", () => {
    const all = { rules: {} as never, pass: true };
    expect(gateResult(plan(), all)).toBe("PASS");
    expect(gateResult(plan(), { ...all, pass: false })).toBe("FAIL");
    expect(gateResult(plan(diagnose), all)).toBe("DIAGNOSTIC");
    expect(gateResult(plan(diagnose), { ...all, pass: false })).toBe(
      "DIAGNOSTIC",
    );
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
  type Result = {
    caseId: string;
    verdict: VerdictClass;
    modelCalled: boolean;
    deterministicProblems: string[];
    costMicros: number | null;
  };
  // The expected outcome of every case: good ones approved, bad ones rejected,
  // the bare host left for the owner, each seen by the model as the set plans.
  const expected = (): Result[] =>
    set.cases.map((c) => ({
      caseId: c.id,
      verdict: (c.expected.verdict === "reject"
        ? c.expected.deterministic.length
          ? "blocked"
          : "reject"
        : c.expected.verdict) as VerdictClass,
      modelCalled: c.expected.modelSees,
      deterministicProblems: [...c.expected.deterministic],
      costMicros: c.expected.modelSees ? 2500 : null,
    }));
  const edit = (id: string, change: Partial<Result>) =>
    expected().map((r) => (r.caseId === id ? { ...r, ...change } : r));
  const withVerdict = (id: string, verdict: VerdictClass) =>
    edit(id, { verdict });
  const goodCase = set.cases.find((c) => c.label === "good")!;
  const badCase = set.cases.find(
    (c) => c.label === "bad" && !isBareHost(c) && c.expected.modelSees,
  )!;
  const blockedCase = set.cases.find(
    (c) =>
      c.label === "bad" && c.expected.deterministic.length && !isBareHost(c),
  )!;
  const bareHost = set.cases.find(isBareHost)!;

  it("passes when every case meets its expectation as planned", () => {
    const outcome = evaluatePassRule(set.cases, expected(), null);
    expect(outcome.pass).toBe(true);
    expect(Object.values(outcome.rules).every(Boolean)).toBe(true);
  });

  it("fails when a bad case is approved, also after a revision", () => {
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

  it("passes a good case left for the owner, and a bad one rejected, blocked or left for the owner", () => {
    const owner = evaluatePassRule(
      set.cases,
      withVerdict(goodCase.id, "owner"),
      null,
    );
    expect(owner.pass).toBe(true);
    expect(casePasses({ label: "good", verdict: "owner" })).toBe(true);
    for (const verdict of ["reject", "owner", "blocked"] as const)
      expect(
        evaluatePassRule(set.cases, withVerdict(badCase.id, verdict), null)
          .pass,
      ).toBe(true);
  });

  it("fails a good case that is not approved, an error and an incomplete run", () => {
    for (const verdict of ["reject", "blocked", "error"] as const) {
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

  it("fails a case that did not run as planned (model seen or deterministic codes)", () => {
    // A blocker case the model saw: the deterministic checks did not catch it.
    const seen = evaluatePassRule(
      set.cases,
      edit(blockedCase.id, {
        verdict: "reject",
        modelCalled: true,
        deterministicProblems: [],
        costMicros: 2500,
      }),
      null,
    );
    expect(seen.rules.asPlanned).toBe(false);
    expect(seen.rules.noBadApproved).toBe(true);
    expect(seen.pass).toBe(false);
    // A model case decided without the model.
    expect(
      evaluatePassRule(
        set.cases,
        edit(badCase.id, { modelCalled: false, costMicros: null }),
        null,
      ).rules.asPlanned,
    ).toBe(false);
    // An expected code missing, while another one is recorded.
    expect(
      evaluatePassRule(
        set.cases,
        edit(blockedCase.id, { deterministicProblems: ["OTHER_CODE"] }),
        null,
      ).rules.asPlanned,
    ).toBe(false);
    // Extra codes beside the expected ones are fine.
    expect(
      evaluatePassRule(
        set.cases,
        edit(blockedCase.id, {
          deterministicProblems: [
            ...blockedCase.expected.deterministic,
            "OTHER_CODE",
          ],
        }),
        null,
      ).pass,
    ).toBe(true);
    expect(
      caseAsPlanned(blockedCase, {
        modelCalled: false,
        deterministicProblems: blockedCase.expected.deterministic,
      }),
    ).toBe(true);
  });

  it("does not count a revised case as planned unless round 2 reached the model", () => {
    const seen = set.cases.find((c) => c.expected.modelSees)!;
    const ran = {
      modelCalled: true,
      deterministicProblems: seen.expected.deterministic,
      revised: true,
    };
    expect(caseAsPlanned(seen, { ...ran, reviewCalls: 1 })).toBe(false);
    expect(caseAsPlanned(seen, { ...ran, reviewCalls: 2 })).toBe(true);
  });

  it("fails a model-called case without a known positive cost", () => {
    for (const costMicros of [0, null]) {
      const outcome = evaluatePassRule(
        set.cases,
        edit(goodCase.id, { costMicros }),
        null,
      );
      expect(outcome.rules.costsKnown).toBe(false);
      expect(outcome.pass).toBe(false);
    }
  });
});
