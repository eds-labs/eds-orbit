/**
 * Stubs the live review eval requires (see live-harness.ts): the copywriter
 * draft that shapes the cases and any revision send nothing to a provider.
 * Used from `vi.mock` factories, so this module imports nothing it stubs.
 */
import { vi } from "vitest";

const usage = (model: string, costMicros: number) => ({
  model,
  inputTokens: 10,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
  costMicros,
});

/** `generate` and `embed` for `packages/ai`: one fixed draft and a unit vector. */
export function draftStubs() {
  return {
    generate: vi.fn(async (params: { route: { model: string } }) => ({
      responseId: "stub_draft",
      output: {
        title: "Beta post",
        body: "Beta access is open for product teams today. Learn more.",
        claims: [{ text: "Learn more.", kind: "style" }],
      },
      usage: usage(params.route.model, 1),
    })),
    embed: vi.fn(async () => ({
      vectors: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
      usage: { ...usage("text-embedding-3-small", 1), outputTokens: 0 },
    })),
  };
}

/** `reviseAssignmentDraft`: a round-1 `revise` is recorded as such; the eval never revises. */
export async function revisionStub() {
  const { DomainError } = await import("../../apps/api/src/shared.ts");
  return vi.fn(async () => {
    throw new DomainError("EVAL_REVISION_NOT_RUN");
  });
}
