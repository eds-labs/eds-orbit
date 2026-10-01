import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import { generate, streamChat } from "./index.ts";

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
