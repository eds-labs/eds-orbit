import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import { GenerationOutputError, generate, streamChat } from "./index.ts";

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
    ["MODEL_OUTPUT_INVALID", '{"title":"t","body":'],
    ["MODEL_OUTPUT_INVALID", JSON.stringify({ title: "t", body: "b" })],
    [
      "INSUFFICIENT_EVIDENCE",
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
