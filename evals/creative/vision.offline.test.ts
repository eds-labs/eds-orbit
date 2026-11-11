import { afterAll, describe, expect, it, vi } from "vitest";

// Offline: the vision eval set and its live harness end to end with replayed
// answers; the provider is never called.
const replay = vi.hoisted(() => ({
  // The answers in the order of the calls; a string is sent as the raw answer text.
  answers: [] as unknown[],
  requests: [] as any[],
  costMicros: 4200,
}));
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    replay.requests.push(request);
    const answer = replay.answers.shift();
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text:
                typeof answer === "string" ? answer : JSON.stringify(answer),
            },
          ],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 2400,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 180,
        reasoningTokens: 0,
        costMicros: replay.costMicros,
      },
      responseId: "resp_vision",
      truncated: false,
    };
  }),
}));

import { authDb, closeDatabase } from "../../packages/db/src/index.ts";
import {
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
} from "../../packages/creative/src/index.ts";
import { demoBrand } from "../../packages/creative/fixtures/demo-brands.ts";
import { visionVerdict } from "../../apps/api/src/modules/marketing/creative/vision-review.ts";
import { parseVisionSet, type VisionSet } from "./vision-set.ts";
import {
  evaluateVisionPassRule,
  parseVisionRouteFile,
  planVisionEval,
  renderVisionReport,
  VISION_BRIEF_BYTES,
  visionPromptHash,
} from "./vision-plan.ts";
import { runVisionEval, VISION_EVAL_MARKER } from "./vision-harness.ts";
import rawSet from "./vision-v1.json" with { type: "json" };
import rawRoute from "./vision-route-v1.json" with { type: "json" };

const set = parseVisionSet(rawSet);
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("Vision eval set (creative-vision-v1)", () => {
  it("has eight cases in the 4:5 feed_portrait format: four good, four bad", () => {
    expect(set.datasetVersion).toBe("creative-vision-v1");
    expect(set.format).toBe("feed_portrait");
    expect(set.cases).toHaveLength(8);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(8);
    const good = set.cases.filter((c) => c.label === "good");
    const bad = set.cases.filter((c) => c.label === "bad");
    expect([good.length, bad.length]).toEqual([4, 4]);
    // Good: each demo brand's good art in its own kit, in two templates.
    for (const brand of ["lumora", "kestrel"] as const) {
      const own = good.filter((c) => c.brand === brand);
      expect(own).toHaveLength(2);
      expect(new Set(own.map((c) => c.template)).size).toBe(2);
      for (const c of own) {
        expect(c.art).toBe("good");
        expect(c.kitBrand).toBe(brand);
        expect(c.expected).toBe("pass");
      }
    }
    // Bad: a tiny subject, an almost empty field, a bright busy scene, and
    // the good art composed in the other brand's palette and logo.
    expect(bad.every((c) => c.expected === "needs_correction")).toBe(true);
    const ownKit = bad.filter((c) => c.kitBrand === c.brand);
    expect(ownKit.map((c) => c.art).sort()).toEqual([
      "bright",
      "flat",
      "tiny_subject",
    ]);
    const wrongKit = bad.filter((c) => c.kitBrand !== c.brand);
    expect(wrongKit).toHaveLength(1);
    expect(wrongKit[0]!.art).toBe("good");
  });

  it("replays every recorded answer to the case's expected verdict", () => {
    for (const c of set.cases)
      expect(visionVerdict(c.recorded).verdict, c.id).toBe(c.expected);
  });

  it("gives each brand its fixture palette and fonts, and copy every case's template fits", async () => {
    for (const name of ["lumora", "kestrel"] as const) {
      const { palette } = await demoBrand(name);
      const identity = set.brands[name].visualIdentity;
      for (const key of [
        "primaryColor",
        "secondaryColor",
        "accentColor",
        "backgroundColor",
        "surfaceColor",
        "textColor",
        "headingFont",
        "bodyFont",
      ] as const)
        expect(identity[key], `${name} ${key}`).toBe(palette[key]);
    }
    for (const c of set.cases) {
      // The art is drawn and no product is needed.
      expect(TEMPLATE_NEEDS[c.template].art).not.toBe("none");
      expect(TEMPLATE_NEEDS[c.template].product).not.toBe("required");
      const copy = set.brands[c.brand].copy;
      const limits = TEMPLATE_COPY_LIMITS[c.template];
      expect(copy.eyebrow.length).toBeLessThanOrEqual(limits.eyebrow);
      expect(copy.headline.length).toBeLessThanOrEqual(limits.headline);
      expect(copy.subline.length).toBeLessThanOrEqual(limits.subline);
      expect(copy.cta.length).toBeLessThanOrEqual(limits.cta);
    }
  });

  it("refuses a set that breaks its shape", () => {
    const edit = (change: (raw: any) => void) => {
      const raw = structuredClone(rawSet) as any;
      change(raw);
      return () => parseVisionSet(raw);
    };
    expect(edit(() => undefined)).not.toThrow();
    // A recorded answer that does not give the expected verdict.
    expect(
      edit((raw) => {
        raw.cases[4].recorded.scores.subject = 4;
        raw.cases[4].recorded.scores.messageFit = 4;
        raw.cases[4].recorded.scores.value = 4;
        raw.cases[4].recorded.scores.balance = 4;
      }),
    ).toThrow("VISION_RECORDED_MISMATCH");
    // A good case must expect a pass, with its own brand's good art and kit.
    expect(edit((raw) => (raw.cases[0].expected = "needs_correction"))).toThrow(
      "VISION_LABEL_MISMATCH",
    );
    expect(edit((raw) => (raw.cases[0].kitBrand = "kestrel"))).toThrow(
      "VISION_GOOD_CASE_INVALID",
    );
    expect(edit((raw) => (raw.cases[0].art = "flat"))).toThrow(
      "VISION_GOOD_CASE_INVALID",
    );
    expect(edit((raw) => (raw.cases[1].id = raw.cases[0].id))).toThrow(
      "VISION_CASE_DUPLICATE",
    );
    expect(edit((raw) => raw.cases.pop())).toThrow();
    expect(edit((raw) => (raw.format = "square"))).toThrow();
    // A template that needs a product, and copy longer than a template allows.
    expect(edit((raw) => (raw.cases[0].template = "product_showcase"))).toThrow(
      "VISION_TEMPLATE_UNUSABLE",
    );
    expect(
      edit((raw) => (raw.brands.lumora.copy.headline = "x".repeat(61))),
    ).toThrow("VISION_COPY_TOO_LONG");
  });
});

describe.skipIf(!enabled)("Vision eval harness (offline replay)", () => {
  const routeFile = parseVisionRouteFile(rawRoute);
  // The production route priced with a fixture rate card (never the
  // repository's): Orbit's catalog price of claude-sonnet-5-5.
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
  const plan = planVisionEval(
    {},
    set,
    routeFile,
    rates,
    visionPromptHash(),
    new Date(rates.verifiedAt).valueOf() + 3600_000,
  );
  // Deliberately not credential-shaped, so the repository secret scan stays clean.
  const KEY = "synthetic-anthropic-key-not-real-0123456789";
  const notes = set.cases.flatMap((c) => c.recorded.issues.map((i) => i.note));

  afterAll(async () => {
    await closeDatabase();
  });

  const run = (
    cases: VisionSet["cases"],
    answers: unknown[],
    changes: Partial<Parameters<typeof runVisionEval>[0]> = {},
  ) => {
    replay.answers = [...answers];
    replay.requests = [];
    return runVisionEval({
      set: { ...set, cases },
      route: plan.route,
      provider: plan.provider,
      apiKey: KEY,
      maxCostMicros: plan.maxCostMicros,
      runtime: plan.runtime,
      ...changes,
    });
  };
  const workspaceGone = async (id: string) =>
    expect(await authDb.workspace.findUnique({ where: { id } })).toBeNull();

  it("reviews every case once through the production vision review and reports metrics only", async () => {
    const flag = process.env.ORBIT_CREATIVE_STUDIO;
    const report = await run(
      set.cases,
      set.cases.map((c) => c.recorded),
    );
    expect(process.env.ORBIT_CREATIVE_STUDIO).toBe(flag);
    expect(report.stoppedReason).toBeNull();
    expect(report.cleanupError).toBeNull();
    expect(report.datasetHash).toBe(plan.hash);
    expect(report.results.map((r) => r.caseId)).toEqual(
      set.cases.map((c) => c.id),
    );
    for (const [index, c] of set.cases.entries()) {
      const result = report.results[index]!;
      expect(result, c.id).toMatchObject({
        label: c.label,
        expected: c.expected,
        verdict: c.expected,
        pass: true,
        format: "feed_portrait",
        model: "claude-sonnet-5-5",
        errorCode: null,
        costMicros: 4200,
        settledMicros: 4200,
        scores: c.recorded.scores,
      });
      expect(result.issueKinds).toEqual({
        art: c.recorded.issues.filter((i) => i.kind === "art").length,
        layout: c.recorded.issues.filter((i) => i.kind === "layout").length,
        copy: c.recorded.issues.filter((i) => i.kind === "copy").length,
        logo: c.recorded.issues.filter((i) => i.kind === "logo").length,
      });
    }
    const outcome = evaluateVisionPassRule(
      set.cases,
      report.results,
      report.stoppedReason,
    );
    expect(outcome.pass).toBe(true);

    // One call per case on the route file's route with the run's key, the
    // rendition as an image and the brief of the case's brand.
    expect(replay.requests).toHaveLength(8);
    const images: string[] = [];
    for (const [index, c] of set.cases.entries()) {
      const request = replay.requests[index]!;
      expect(request.route).toEqual(plan.route);
      expect(request.runtime.anthropicApiKey).toBe(KEY);
      expect(request.tools).toEqual([]);
      const content = request.input[0].content as any[];
      expect(content.map((part) => part.type)).toEqual([
        "input_text",
        "input_image",
      ]);
      expect(content[1].image_url).toMatch(/^data:image\/png;base64,/);
      images.push(content[1].image_url);
      // The plan's worst case bounds the brief.
      expect(Buffer.byteLength(content[0].text)).toBeLessThanOrEqual(
        VISION_BRIEF_BYTES,
      );
      const brief = JSON.parse(content[0].text);
      const brand = set.brands[c.brand];
      expect(brief).toMatchObject({
        brand: brand.productName,
        palette: {
          primary: brand.visualIdentity.primaryColor,
          secondary: brand.visualIdentity.secondaryColor,
          accent: brand.visualIdentity.accentColor,
          background: brand.visualIdentity.backgroundColor,
          text: brand.visualIdentity.textColor,
        },
        imagery: {
          kind: brand.visualIdentity.imagery.kind,
          mood: brand.visualIdentity.imagery.mood,
        },
        format: { id: "feed_portrait", width: 1080, height: 1350 },
        template: c.template,
        keyMessage: brand.post.title,
        copy: brand.copy,
      });
      // The model never sees the case id or its label.
      const sent = JSON.stringify(request.input);
      expect(sent).not.toContain(c.id);
      expect(sent).not.toContain("tiny_subject");
    }
    // Every rendition differs; the wrong kit's differs from its brand's own
    // good lifestyle creative (same art and template, other palette and logo).
    expect(new Set(images).size).toBe(8);
    const at = (id: string) => images[set.cases.findIndex((c) => c.id === id)];
    expect(at("lumora-bad-wrong-kit")).not.toBe(at("lumora-good-lifestyle"));

    // Metrics only: no notes, no image bytes, no key.
    const json = JSON.stringify(report);
    const markdown = renderVisionReport(report, outcome);
    for (const text of [json, markdown]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("base64");
      for (const note of notes) expect(text).not.toContain(note);
    }
    expect(markdown).toContain("**Result: PASS**");
    expect(markdown).toContain("lumora-bad-wrong-kit");
    await workspaceGone(report.workspaceId);
    expect(
      await authDb.workspace.count({ where: { name: VISION_EVAL_MARKER } }),
    ).toBe(0);
  });

  it("stops at the ceiling before any call and still cleans up", async () => {
    const report = await run(set.cases, [], { maxCostMicros: 1 });
    expect(replay.requests).toHaveLength(0);
    expect(report.stoppedReason).toBe("BUDGET_EXCEEDED");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      verdict: "error",
      errorCode: "BUDGET_EXCEEDED",
      costMicros: null,
      pass: false,
    });
    expect(
      evaluateVisionPassRule(set.cases, report.results, report.stoppedReason)
        .pass,
    ).toBe(false);
    await workspaceGone(report.workspaceId);
  });

  it("holds the ceiling across cases: a review that would exceed what the run has left is refused", async () => {
    // The first review settles at 90,000 micros of a 100,000 ceiling, so the
    // second one's reservation estimate no longer fits.
    replay.costMicros = 90_000;
    try {
      const report = await run(
        set.cases,
        set.cases.map((c) => c.recorded),
        { maxCostMicros: 100_000 },
      );
      expect(replay.requests).toHaveLength(1);
      expect(report.stoppedReason).toBe("BUDGET_EXCEEDED");
      expect(report.results.map((r) => [r.verdict, r.errorCode])).toEqual([
        ["pass", null],
        ["error", "BUDGET_EXCEEDED"],
      ]);
      expect(report.results[0]!.costMicros).toBe(90_000);
      await workspaceGone(report.workspaceId);
    } finally {
      replay.costMicros = 4200;
    }
  });

  it("counts an invalid answer as a paid error and goes on", async () => {
    const cases = set.cases.slice(0, 2);
    const report = await run(cases, ["not json", cases[1]!.recorded]);
    expect(replay.requests).toHaveLength(2);
    expect(report.stoppedReason).toBeNull();
    expect(report.results[0]).toMatchObject({
      verdict: "error",
      errorCode: "VISION_REVIEW_OUTPUT_INVALID",
      costMicros: 4200,
      scores: null,
      pass: false,
    });
    expect(report.results[1]).toMatchObject({ verdict: "pass", pass: true });
    await workspaceGone(report.workspaceId);
  });

  it("refuses before any project exists: an unconfigured route, another provider, no key, a ceiling above 0.5 USD", async () => {
    const before = await authDb.workspace.count({
      where: { name: VISION_EVAL_MARKER },
    });
    await expect(
      run(set.cases, [], {
        runtime: { verifiedModels: [], rateCard: plan.runtime.rateCard },
      }),
    ).rejects.toThrow("EVAL_ROUTE_NOT_CONFIGURED");
    await expect(run(set.cases, [], { provider: "openai" })).rejects.toThrow(
      "EVAL_ROUTE_MISMATCH",
    );
    await expect(run(set.cases, [], { apiKey: " " })).rejects.toThrow(
      "EVAL_KEY_REQUIRED",
    );
    await expect(
      run(set.cases, [], { maxCostMicros: 500_001 }),
    ).rejects.toThrow("EVAL_MAX_COST_INVALID");
    expect(replay.requests).toHaveLength(0);
    expect(
      await authDb.workspace.count({ where: { name: VISION_EVAL_MARKER } }),
    ).toBe(before);
  });
});
