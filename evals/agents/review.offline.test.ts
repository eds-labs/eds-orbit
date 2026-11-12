import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Offline only: drafts and review answers are recorded; no provider is called.
const replay = vi.hoisted(() => ({
  shown: [] as string[][],
  recorded: null as null | { verdict: string; reasons: string[] },
  // A verdict per review round instead of the recorded one (revision tests).
  rounds: null as null | { 1: string; 2: string },
}));
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  // The copywriter of the live eval: the template draft, and every revision unchanged.
  ...(await import("./stubs.ts")).draftStubs(),
  respond: vi.fn(async (request: any) => {
    if (!replay.recorded) throw new Error("REPLAY_NOT_CONFIGURED");
    const input = JSON.parse(request.input[0].content) as {
      round: 1 | 2;
      drafts: Array<{ contentId: string }>;
    };
    const drafts = input.drafts;
    replay.shown.push(drafts.map((draft) => draft.contentId));
    const verdict = replay.rounds?.[input.round] ?? replay.recorded.verdict;
    return {
      output: [
        message({
          decisions: drafts.map((draft) => ({
            contentId: draft.contentId,
            verdict,
            reasons: verdict === "approve" ? [] : replay.recorded!.reasons,
            revisionInstructions:
              verdict === "revise" ? "Synthetic instruction." : null,
          })),
        }),
      ],
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 7,
      },
      responseId: "resp_review",
    };
  }),
}));
import { closeDatabase } from "../../packages/db/src/index.ts";
import { data } from "../../apps/api/src/shared.ts";
import {
  REVIEW_INSTRUCTIONS,
  reviewStep,
} from "../../apps/api/src/modules/agents/specialists/review.ts";
import { creativeCopyProblems } from "../../apps/api/src/modules/marketing/creative/copy-checks.ts";
import { TEMPLATE_COPY_LIMITS } from "../../packages/creative/src/index.ts";
import { createPackageProject } from "../../apps/api/tests/support/package-project.ts";
import { message } from "../../apps/api/tests/support/assignment-review.ts";
import {
  caseDraft,
  endCase,
  prepareBrandRun,
  type BrandRun,
} from "./brand-projects.ts";
import {
  CATEGORIES,
  CREATIVE_TEMPLATE,
  caseBrand,
  IMAGE_COPY_CATEGORIES,
  isBareHost,
  parseReviewSet,
  type ReviewCase,
} from "./review-set.ts";
import raw from "./review-v3.json" with { type: "json" };
import rawV2 from "./review-v2.json" with { type: "json" };

const dataset = parseReviewSet(raw);
const good = dataset.cases.filter((c) => c.label === "good");
const bad = dataset.cases.filter((c) => c.label === "bad");
const creative = dataset.cases.filter((c) => c.creativeCopy !== undefined);
const ctaOf = (c: ReviewCase) =>
  dataset.brands[caseBrand(dataset, c)]!.profile.primaryCtas[0]!;

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("Review eval set v3", () => {
  it("v3 parses with every v2 case unchanged", () => {
    const v2 = parseReviewSet(rawV2);
    expect(v2.datasetVersion).toBe("agents-review-v2");
    expect(v2.cases).toHaveLength(26);
    expect(dataset.datasetVersion).toBe("agents-review-v3");
    // The case ids and bodies of v2 are a subset of v3, and each case is unchanged.
    const v3Ids = new Map(dataset.cases.map((c) => [c.id, c]));
    for (const c of v2.cases) {
      expect(v3Ids.get(c.id)?.body).toBe(c.body);
      expect(v3Ids.get(c.id)).toEqual(c);
    }
    // v2's cases keep v2's brand, its first: profile, fact and brief.
    expect(Object.keys(dataset.brands)[0]).toBe("en");
    expect(dataset.brands.en).toEqual(v2.brands.en);
    for (const c of v2.cases) expect(caseBrand(dataset, c)).toBe("en");
  });

  it("holds the v2 cases and 12 German creative cases over every image copy failure kind", () => {
    expect(dataset.cases).toHaveLength(38);
    expect(good.length).toBe(13);
    expect(bad.filter((c) => !isBareHost(c)).length).toBe(24);
    expect(bad.filter(isBareHost).length).toBe(1);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(
      dataset.cases.length,
    );
    for (const category of CATEGORIES)
      expect(bad.filter((c) => c.category === category).length).toBeGreaterThan(
        0,
      );
    // Every new case is a German creative post of the fictional brand.
    expect(creative).toHaveLength(12);
    expect(creative.filter((c) => c.label === "good")).toHaveLength(5);
    expect(creative.filter((c) => c.label === "bad")).toHaveLength(7);
    for (const c of creative) expect(c.brand).toBe("de");
    for (const c of dataset.cases.filter((c) => c.brand === "de"))
      expect(c.creativeCopy).toBeDefined();
    expect(dataset.brands.de!.profile).toMatchObject({
      productName: "Familienzeit",
      contentLanguage: "de",
      voice: ["warm", "klar"],
      guardrails: ["keine Preise nennen"],
      primaryCtas: ["Jetzt ausprobieren."],
    });
    expect(dataset.brands.de!.facts).toHaveLength(1);
    // Long-form posts: up to Instagram's caption limit.
    for (const c of creative.filter((c) => c.label === "good"))
      expect(c.body.length).toBeGreaterThanOrEqual(600);
    expect(Math.max(...creative.map((c) => c.body.length))).toBeGreaterThan(
      2_000,
    );
    for (const category of IMAGE_COPY_CATEGORIES) {
      const cases = bad.filter((c) => c.category === category);
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) expect(c.expected.verdict).toBe("reject");
    }
    // Two cases whose body is a clean post: only the image copy breaks a rule.
    for (const id of ["de-bad-image-number-words", "de-bad-image-holidays"]) {
      const c = dataset.cases.find((c) => c.id === id)!;
      expect(c.category).toMatch(/^image_copy_(wrong_number|unbacked_claim)$/);
      expect(c.expected).toEqual({
        verdict: "reject",
        deterministic: [],
        modelSees: true,
      });
    }
    for (const c of good) expect(c.expected.verdict).toBe("approve");
    for (const c of bad) expect(c.expected.verdict).not.toBe("approve");
    // A blocker case records a wrong approve, so the set proves the model cannot clear it.
    for (const c of bad.filter((c) => c.expected.deterministic.length))
      expect(c.recorded.verdict).toBe("approve");
    // An unbacked claim is the model's to catch; its recorded round-1 answer is reject.
    for (const c of bad.filter((c) => c.category === "unbacked_claim")) {
      expect(c.expected).toEqual({
        verdict: "reject",
        deterministic: [],
        modelSees: true,
      });
      expect(c.recorded.verdict).toBe("reject");
    }
  });

  it("states each brand's CTA exactly once in every post, and the image CTA as Orbit sets it", () => {
    for (const c of dataset.cases.filter(
      (c) => !c.expected.deterministic.length,
    )) {
      const cta = ctaOf(c).toLocaleLowerCase();
      expect(c.body.toLocaleLowerCase().split(cta).length - 1).toBe(1);
    }
    for (const c of creative)
      expect((c.creativeCopy as { cta?: string }).cta).toBe(
        ctaOf(c).replace(/[\s\p{P}]+$/u, ""),
      );
  });

  // The image copy check is deterministic: the set plans exactly the codes it finds.
  it("expects exactly the deterministic image copy codes the production check finds", () => {
    for (const c of creative) {
      const found = creativeCopyProblems(
        c.creativeCopy,
        TEMPLATE_COPY_LIMITS[CREATIVE_TEMPLATE],
        { cta: ctaOf(c) },
      );
      expect({ id: c.id, found }).toEqual({
        id: c.id,
        found: c.expected.deterministic,
      });
    }
  });

  it("refuses image copy that does not fit the template and a case of an unknown brand", () => {
    const edited = structuredClone(raw) as any;
    edited.cases.at(-1).creativeCopy.headline = "x".repeat(61);
    expect(() => parseReviewSet(edited)).toThrow("CREATIVE_COPY_INVALID");
    const unknown = structuredClone(raw) as any;
    unknown.cases.at(-1).brand = "fr";
    expect(() => parseReviewSet(unknown)).toThrow("UNKNOWN_BRAND");
    const long = structuredClone(raw) as any;
    long.cases.at(-1).body = "a".repeat(2_201);
    expect(() => parseReviewSet(long)).toThrow();
  });

  // The prompt's examples must not be the set's own sentences, or the set would test recall.
  it("quotes no sentence of a case body in the review prompt", () => {
    const ctas = new Set(
      Object.values(dataset.brands).flatMap((b) => b.profile.primaryCtas),
    );
    const sentences = dataset.cases.flatMap((c) =>
      c.body
        .split(/(?<=[.?!])\s+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence && !ctas.has(sentence)),
    );
    expect(sentences.length).toBeGreaterThan(0);
    expect(
      sentences.filter((sentence) => REVIEW_INSTRUCTIONS.includes(sentence)),
    ).toEqual([]);
  });
});

describe.skipIf(!enabled)("Review eval v3 (offline replay)", () => {
  // One synthetic project per brand, prepared up to its review step.
  const runs = new Map<string, BrandRun>();

  beforeAll(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_CREATIVE_STUDIO = "true";
    // The replay measures what the review would approve with its authority on,
    // creative posts included; the vision review stays off, so those wait.
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    process.env.ORBIT_AGENT_REVIEW_CREATIVES = "true";
    for (const [brand, config] of Object.entries(dataset.brands)) {
      const project = await createPackageProject();
      runs.set(
        brand,
        await prepareBrandRun(project, brand, config, {
          creative: creative.some((c) => caseBrand(dataset, c) === brand),
          policy: {
            startAt: "2026-01-01T00:00:00.000Z",
            endAt: "2027-12-31T00:00:00.000Z",
            maxPerDay: 2,
            minIntervalMinutes: 120,
          },
          beforeAssignment: async (h) => {
            await h.connectTelegram();
          },
        }),
      );
    }
  }, 120_000);
  afterAll(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_CREATIVE_STUDIO;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    delete process.env.ORBIT_AGENT_REVIEW_CREATIVES;
    for (const run of runs.values()) await run.project.cleanup();
    await closeDatabase();
  });

  type Decision = {
    contentId: string;
    verdict: string;
    deterministicProblems: string[];
    revisedTo?: string | null;
  };

  /** One case: its draft (and creative) in its brand's run, its own review task; returns the final outcome. */
  async function review(c: ReviewCase) {
    const run = runs.get(caseBrand(dataset, c))!;
    const setup = await caseDraft(run, c, 1_000_000);
    replay.recorded = c.recorded;
    replay.shown = [];
    const output = (await reviewStep(run.h.worker(), {
      id: setup.task.id,
      ...(data(setup.task) as any),
    })) as { decisions: Decision[] };
    const first = output.decisions.find((d) => d.contentId === setup.contentId);
    // A revised draft is decided by its round-2 review.
    const final = first?.revisedTo
      ? output.decisions.find((d) => d.contentId === first.revisedTo)
      : first;
    const contents = await run.h.rows("content");
    const content = contents.find((row) => row.id === final?.contentId)!;
    const original = contents.find((row) => row.id === setup.contentId)!;
    await endCase(run, setup, [setup.contentId, first?.revisedTo]);
    return {
      first,
      verdict: final?.verdict,
      content,
      original,
      problems: [
        ...new Set([
          ...(first?.deterministicProblems ?? []),
          ...(final?.deterministicProblems ?? []),
        ]),
      ],
      calls: replay.shown.length,
      // The draft the review judged first carried a composed creative.
      composed:
        typeof original.creativeId === "string" &&
        typeof original.assetId === "string" &&
        !original.creativeFailure,
      modelSaw: replay.shown
        .flat()
        .some((id) => id === setup.contentId || id === first?.revisedTo),
    };
  }

  it("approves every good case of review-v3", async () => {
    const failures: string[] = [];
    for (const c of good) {
      const outcome = await review(c);
      const creativePost = c.creativeCopy !== undefined;
      const ok =
        outcome.verdict === "approve" &&
        Boolean(outcome.content.agentReview) &&
        outcome.modelSaw &&
        outcome.calls === 1 &&
        (creativePost
          ? // A composed creative was on the draft the model approved; without
            // a vision review the post still waits for the owner.
            outcome.composed &&
            outcome.content.status === "needs_review" &&
            outcome.content.agentAuthorityProblem ===
              "CREATIVE_VISION_REVIEW_REQUIRED"
          : outcome.content.status === "reviewed");
      if (!ok)
        failures.push(
          `${c.id}: ${outcome.verdict} ${outcome.content.status} ${outcome.content.agentAuthorityProblem ?? ""} calls=${outcome.calls} ${JSON.stringify(outcome.problems)}`,
        );
    }
    expect(failures).toEqual([]);
  }, 300_000);

  // A bad case is never approved: objected to (handed to the owner with the
  // reasons since 2026-11-11, or closed by the owner's own rules), or left
  // for the owner where the set expects that.
  it("rejects every bad case of review-v3", async () => {
    const failures: string[] = [];
    for (const c of bad) {
      const outcome = await review(c);
      const owner = c.expected.verdict === "owner";
      if (
        outcome.verdict !== (owner ? "needs_owner" : "reject") ||
        !(owner ? ["needs_review"] : ["needs_review", "rejected"]).includes(
          outcome.content.status,
        ) ||
        outcome.content.agentReview ||
        outcome.modelSaw !== c.expected.modelSees ||
        // The model judges a creative case with its composed creative.
        (c.creativeCopy !== undefined &&
          c.expected.modelSees &&
          !outcome.composed) ||
        c.expected.deterministic.some(
          (code) => !outcome.problems.includes(code),
        )
      )
        failures.push(
          `${c.id}: ${outcome.verdict} ${outcome.content.status} saw=${outcome.modelSaw} composed=${outcome.composed} ${JSON.stringify(outcome.problems)}`,
        );
    }
    expect(failures).toEqual([]);
  }, 300_000);

  // Only the review model is measured: the brand kit's vision review is off.
  it("keeps the vision review off in the creative brand's kit", async () => {
    const run = runs.get("de")!;
    const profile = await run.h.run((tx) =>
      tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: run.project.owner.projectId },
      }),
    );
    const identity = (profile.data as Record<string, any>).visualIdentity;
    expect(identity.creative).toMatchObject({
      enabled: true,
      visualReview: false,
    });
  });

  // The worst-case revision of a creative post keeps its body and image copy
  // and gets a creative of its own, which round 2 judges again.
  it("revises a creative case with its image copy and a newly composed creative", async () => {
    const c = good.find((c) => c.creativeCopy !== undefined)!;
    replay.rounds = { 1: "revise", 2: "approve" };
    try {
      const outcome = await review(c);
      expect(outcome.first?.verdict).toBe("revise");
      expect(outcome.verdict).toBe("approve");
      expect(outcome.calls).toBe(2);
      const { original, content: revised } = outcome;
      expect(revised.id).toBe(outcome.first!.revisedTo);
      expect(original.status).toBe("rejected");
      expect(revised.body).toBe(c.body);
      expect(revised.creativeCopy).toEqual(c.creativeCopy);
      expect(revised.creativeCopy).toEqual(original.creativeCopy);
      expect([revised.hook, revised.coreMessage]).toEqual([
        original.hook,
        original.coreMessage,
      ]);
      expect(typeof revised.creativeId).toBe("string");
      expect(typeof revised.assetId).toBe("string");
      expect(revised.creativeId).not.toBe(original.creativeId);
      expect(revised.agentReview).toBeTruthy();
      expect(revised.agentAuthorityProblem).toBe(
        "CREATIVE_VISION_REVIEW_REQUIRED",
      );
    } finally {
      replay.rounds = null;
    }
  }, 120_000);
});
