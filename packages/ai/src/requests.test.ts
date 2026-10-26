import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import {
  COPY_CRAFT_INSTRUCTION,
  CREATIVE_DRAFT_INSTRUCTION,
  DRAFT_INSTRUCTIONS,
  GenerationOutputError,
  generate,
  streamChat,
  withoutBannerClaims,
} from "./index.ts";

const runtime = {
  apiKey: "test-key",
  verifiedModels: ["m"],
  rateCard: {
    m: {
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
      verifiedAt: new Date().toISOString(),
    },
  },
};
const answer = {
  id: "resp_1",
  output_text: JSON.stringify({
    title: "t",
    body: "b",
    claims: [{ text: "c", factId: null, chunkId: null, kind: "style" }],
  }),
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

describe("route-driven requests", () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue(answer);
  });
  it("generate sends the route model, ceiling and reasoning effort", async () => {
    await generate({
      task: "draft",
      goal: "g",
      evidence: {},
      route: { model: "m", reasoningEffort: "low", maxOutputTokens: 2400 },
      reservationId: "r",
      runtime,
    });
    const body = create.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: "m",
      max_output_tokens: 2400,
      reasoning: { effort: "low" },
    });
  });
  // Production uLiquid, 2026-10-17 (run f610945b): a paragraph addressed
  // the reviewer, so the post did not read as finished.
  it("generate asks for a finished post without notes to a reviewer", async () => {
    await generate({
      task: "draft",
      goal: "g",
      evidence: {},
      route: { model: "m", maxOutputTokens: 2400 },
      reservationId: "r",
      runtime,
    });
    const { instructions } = create.mock.calls[0]![0];
    expect(instructions).toContain(
      "The body is the finished post exactly as readers see it",
    );
    expect(instructions).toMatch(/never address a reviewer, editor or Orbit/);
    expect(instructions).toMatch(/no bracketed directions/);
  });
  it("generate omits reasoning when the route has no effort", async () => {
    await generate({
      task: "draft",
      goal: "g",
      evidence: {},
      route: { model: "m", maxOutputTokens: 1800 },
      reservationId: "r",
      runtime,
    });
    const body = create.mock.calls[0]![0];
    expect(body.max_output_tokens).toBe(1800);
    expect("reasoning" in body).toBe(false);
  });
  it("streamChat sends the route ceiling and optional reasoning", async () => {
    const base = {
      input: [],
      tools: [],
      instructions: "i",
      reservationId: "r",
      runtime,
    };
    await streamChat({
      ...base,
      route: { model: "m", reasoningEffort: "high", maxOutputTokens: 3600 },
    });
    await streamChat({
      ...base,
      route: { model: "m", maxOutputTokens: 3000 },
    });
    const [first, second] = create.mock.calls.map((call) => call[0]);
    expect(first).toMatchObject({
      model: "m",
      stream: true,
      max_output_tokens: 3600,
      reasoning: { effort: "high" },
    });
    expect(second.max_output_tokens).toBe(3000);
    expect("reasoning" in second).toBe(false);
  });
});

describe("unusable generation output", () => {
  const request = {
    task: "draft",
    goal: "g",
    evidence: {},
    route: { model: "m", maxOutputTokens: 1800 },
    reservationId: "r",
    runtime: {
      ...runtime,
      rateCard: {
        m: {
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 2_000_000,
          verifiedAt: new Date().toISOString(),
        },
      },
    },
  };
  const outcome = async (output_text: string) => {
    create.mockReset().mockResolvedValue({ ...answer, output_text });
    return generate(request).then(
      () => null,
      (error: unknown) => error,
    );
  };
  it.each([
    ["MODEL_OUTPUT_NOT_VALID", '{"title":"t","body":'],
    ["MODEL_OUTPUT_NOT_VALID", JSON.stringify({ title: "t", body: "b" })],
    [
      "MODEL_EVIDENCE_ABSTENTION",
      JSON.stringify({ title: "t", body: "", claims: [] }),
    ],
  ])("throws %s with the known usage and cost", async (code, text) => {
    const error = await outcome(text);
    expect(error).toBeInstanceOf(GenerationOutputError);
    expect(error).toMatchObject({
      code,
      message: code,
      responseId: "resp_1",
      // 10 input tokens at 1 micro plus 5 output tokens at 2 micros.
      costMicros: 20,
      usage: {
        model: "m",
        inputTokens: 10,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        costMicros: 20,
      },
    });
  });
  it("pins the invalid-output code to the worker's non-retryable NOT_ pattern", async () => {
    const error = (await outcome("not json")) as GenerationOutputError;
    expect(error.code).toBe("MODEL_OUTPUT_NOT_VALID");
    expect(error.message).toBe("MODEL_OUTPUT_NOT_VALID");
    expect(error.message).toMatch(/NOT_/);
  });
  it("keeps an unknown outcome when usage is missing", async () => {
    create.mockReset().mockResolvedValue({
      ...answer,
      output_text: "not json",
      usage: undefined,
    });
    const error = await generate(request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GenerationOutputError);
    expect((error as Error).message).toBe("USAGE_UNKNOWN");
  });
  it("lets transport errors through unchanged", async () => {
    create.mockReset().mockRejectedValue(new Error("socket hang up"));
    const error = await generate(request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GenerationOutputError);
    expect((error as Error).message).toBe("socket hang up");
  });
});

describe("banner copy in drafts (R78)", () => {
  const params = {
    task: "draft",
    goal: "g",
    evidence: {},
    route: { model: "m", maxOutputTokens: 1800 },
    reservationId: "r",
    runtime,
  };
  const banner = {
    headline1: "Start free.",
    headline2: "Build your workflow.",
    subline: "Markets. Paper trading. Bots.",
    button: "Explore Desk",
  };
  const withBanner = (value: unknown) => ({
    ...answer,
    output_text: JSON.stringify({
      ...JSON.parse(answer.output_text),
      banner: value,
    }),
  });
  beforeEach(() => {
    create.mockReset().mockResolvedValue(answer);
  });

  it("leaves a draft without a banner exactly as before", async () => {
    await generate(params);
    const body = create.mock.calls[0]![0];
    expect(body.instructions).not.toContain("banner");
    expect(Object.keys(body.text.format.schema.properties)).toEqual([
      "title",
      "body",
      "claims",
    ]);
    expect(body.text.format.schema.required).toEqual([
      "title",
      "body",
      "claims",
    ]);
  });

  it("asks for and returns the banner copy", async () => {
    create.mockResolvedValue(withBanner(banner));
    const result = await generate({ ...params, banner: true });
    const body = create.mock.calls[0]![0];
    expect(body.instructions).toMatch(/ The contract has a banner: /);
    // A revision keeps the banner unless its instruction concerns it.
    expect(body.instructions).toContain(
      "return previousBanner unchanged unless revision.instruction concerns the banner",
    );
    // The button never competes with the post's call to action.
    expect(body.instructions).toContain(
      "button is the label of an outlined button: write the contract's intendedPrimaryCta there",
    );
    expect(body.instructions).not.toContain("Explore Desk");
    expect(body.text.format.schema.required).toContain("banner");
    expect(body.text.format.schema.properties.banner.required).toEqual([
      "headline1",
      "headline2",
      "subline",
      "button",
    ]);
    expect(result.output.banner).toEqual(banner);
  });

  it("drops a style claim that is only the banner copy (R83)", async () => {
    const cta = { text: "Explore Desk", kind: "style" };
    const fact = { text: "Beta access is open", kind: "fact", factId: "f1" };
    create.mockResolvedValue({
      ...answer,
      output_text: JSON.stringify({
        title: "t",
        body: "Beta access is open. Explore Desk",
        claims: [
          fact,
          cta,
          // The banner copy as the model recorded it in production.
          {
            text: "START FREE. / BUILD YOUR WORKFLOW. / Markets. Paper trading. Bots. / Explore Desk",
            kind: "style",
          },
          { text: "Markets. Paper trading. Bots.", kind: "style" },
          // Not only banner copy, or not a style claim: kept for the checks.
          { text: "Start free. / Trade without limits", kind: "style" },
          { text: "Build your workflow", kind: "fact", factId: "f2" },
        ],
        banner,
      }),
    });
    const result = await generate({ ...params, banner: true });
    expect(result.output.claims).toEqual([
      fact,
      cta,
      { text: "Start free. / Trade without limits", kind: "style" },
      { text: "Build your workflow", kind: "fact", factId: "f2" },
    ]);
    expect(create.mock.calls[0]![0].instructions).toContain(
      "never record banner text in the claims ledger",
    );
  });

  it("refuses an answer without the banner it asked for, at the known cost", async () => {
    await expect(generate({ ...params, banner: true })).rejects.toBeInstanceOf(
      GenerationOutputError,
    );
    create.mockResolvedValue(withBanner({ ...banner, button: "" }));
    await expect(generate({ ...params, banner: true })).rejects.toMatchObject({
      code: "MODEL_OUTPUT_NOT_VALID",
    });
  });
});

describe("copy craft and creative copy in drafts (Creative Studio)", () => {
  const params = {
    task: "draft",
    goal: "g",
    evidence: {},
    route: { model: "m", maxOutputTokens: 1800 },
    reservationId: "r",
    runtime,
  };
  const limits = { eyebrow: 32, headline: 60, subline: 120, cta: 24 };
  const creative = {
    eyebrow: "Home office",
    headline: "Calm light for long days",
    subline: "",
    cta: "Shop the lamp",
  };
  const crafted = (extra: Record<string, unknown>) => ({
    ...answer,
    output_text: JSON.stringify({
      ...JSON.parse(answer.output_text),
      ...extra,
    }),
  });
  beforeEach(() => {
    create.mockReset().mockResolvedValue(answer);
  });

  it("leaves the prompt and schema unchanged without copy craft or creative", async () => {
    await generate(params);
    const body = create.mock.calls[0]![0];
    expect(body.instructions).toBe(DRAFT_INSTRUCTIONS);
    expect(body.text.format.schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              factId: { type: ["string", "null"] },
              chunkId: { type: ["string", "null"] },
              kind: { type: "string", enum: ["fact", "quote", "style"] },
            },
            required: ["text", "factId", "chunkId", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "body", "claims"],
      additionalProperties: false,
    });
  });

  it("asks for a core message and a hook with copy craft", async () => {
    create.mockResolvedValue(
      crafted({
        coreMessage: "Good light makes long days easier.",
        hook: "Ever squinted at your screen at 6 pm?",
      }),
    );
    const result = await generate({ ...params, copyCraft: true });
    const body = create.mock.calls[0]![0];
    expect(body.instructions).toBe(
      `${DRAFT_INSTRUCTIONS} ${COPY_CRAFT_INSTRUCTION}`,
    );
    expect(body.instructions.endsWith(COPY_CRAFT_INSTRUCTION)).toBe(true);
    // The exact profile CTA is binding; copy craft only leads into it (R40).
    expect(COPY_CRAFT_INSTRUCTION).toContain(
      "and close with the contract's exact intendedPrimaryCta, led into naturally for the channel.",
    );
    expect(COPY_CRAFT_INSTRUCTION).not.toContain("phrased for the channel");
    const schema = body.text.format.schema;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "title",
        "body",
        "claims",
        "coreMessage",
        "hook",
      ]),
    );
    expect(schema.properties.coreMessage).toEqual({ type: "string" });
    expect(schema.properties.hook).toEqual({ type: "string" });
    expect(schema.properties).not.toHaveProperty("creative");
    expect(result.output).toMatchObject({
      coreMessage: "Good light makes long days easier.",
      hook: "Ever squinted at your screen at 6 pm?",
    });
    // Without the fields it asked for, the answer is not usable.
    create.mockResolvedValue(answer);
    await expect(
      generate({ ...params, copyCraft: true }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_NOT_VALID" });
  });

  it("asks for the image copy with a creative", async () => {
    create.mockResolvedValue(crafted({ creative }));
    const result = await generate({ ...params, creative: { limits } });
    const body = create.mock.calls[0]![0];
    expect(body.instructions).toBe(
      `${DRAFT_INSTRUCTIONS} ${CREATIVE_DRAFT_INSTRUCTION}`,
    );
    const schema = body.text.format.schema;
    expect(schema.required).toContain("creative");
    expect(schema.required).not.toContain("coreMessage");
    expect(schema.properties.creative).toEqual({
      type: "object",
      properties: {
        eyebrow: { type: "string" },
        headline: { type: "string" },
        subline: { type: "string" },
        cta: { type: "string" },
      },
      required: ["eyebrow", "headline", "subline", "cta"],
      additionalProperties: false,
    });
    expect(result.output.creative).toEqual(creative);
    create.mockResolvedValue(answer);
    await expect(
      generate({ ...params, creative: { limits } }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_NOT_VALID" });
  });

  it("asks for copy craft first and the creative copy last when both apply", async () => {
    create.mockResolvedValue(
      crafted({ creative, coreMessage: "c", hook: "h" }),
    );
    await generate({ ...params, copyCraft: true, creative: { limits } });
    const body = create.mock.calls[0]![0];
    expect(body.instructions).toBe(
      `${DRAFT_INSTRUCTIONS} ${COPY_CRAFT_INSTRUCTION} ${CREATIVE_DRAFT_INSTRUCTION}`,
    );
    expect(body.text.format.schema.required).toEqual(
      expect.arrayContaining(["coreMessage", "hook", "creative"]),
    );
  });

  it("keeps no copy craft or creative fields it did not ask for", async () => {
    create.mockResolvedValue(
      crafted({ creative, coreMessage: "c", hook: "h" }),
    );
    const result = await generate(params);
    expect(result.output).not.toHaveProperty("creative");
    expect(result.output).not.toHaveProperty("coreMessage");
    expect(result.output).not.toHaveProperty("hook");
    // Never read when not asked for: malformed values change nothing (as before).
    create.mockResolvedValue(
      crafted({ creative: 3, coreMessage: 5, hook: "h".repeat(5000) }),
    );
    expect((await generate(params)).output).toEqual({
      title: "t",
      body: "b",
      claims: [{ text: "c", kind: "style" }],
    });
  });

  it("drops a style claim that is only the creative copy (R83)", async () => {
    const cta = { text: "Shop the lamp", kind: "style" };
    const fact = {
      text: "The lamp dims in three steps",
      kind: "fact",
      factId: "f1",
    };
    create.mockResolvedValue({
      ...answer,
      output_text: JSON.stringify({
        title: "t",
        body: "The lamp dims in three steps. Shop the lamp",
        claims: [
          fact,
          cta,
          // The image copy recorded as a claim: not in the body.
          {
            text: "HOME OFFICE / Calm light for long days / Shop the lamp",
            kind: "style",
          },
          { text: "Calm light for long days.", kind: "style" },
          // Not only image copy: kept for the checks.
          { text: "Calm light for long days / Brightest lamp", kind: "style" },
        ],
        creative,
      }),
    });
    const result = await generate({ ...params, creative: { limits } });
    expect(result.output.claims).toEqual([
      fact,
      cta,
      { text: "Calm light for long days / Brightest lamp", kind: "style" },
    ]);
    expect(create.mock.calls[0]![0].instructions).toContain(
      "never record it in the claims ledger",
    );
  });

  it("drops banner-only style claims through the same rule for creative copy", () => {
    const claims = [
      { text: "Calm light for long days", kind: "style" },
      { text: "Shop the lamp", kind: "style" },
    ];
    expect(
      withoutBannerClaims(claims, creative, "Light for your desk."),
    ).toEqual([]);
  });
});
