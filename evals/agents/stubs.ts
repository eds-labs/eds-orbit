/**
 * Stubs the live review eval requires (see live-harness.ts): the copywriter's
 * `generate` and the retrieval `embed` send nothing to a provider. Used from
 * `vi.mock` factories, so this module imports nothing it stubs.
 */
import { vi } from "vitest";

// Body of the copywriter draft that gives the cases their shape.
export const TEMPLATE_BODY =
  "Beta access is open for product teams today. Learn more.";

const usage = (model: string, costMicros: number) => ({
  model,
  inputTokens: 10,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
  costMicros,
});

/**
 * `generate` and `embed` for `packages/ai`. `generate` is the worst-case
 * copywriter: a revision (`revision` in the generation contract) returns the
 * previous body unchanged, ignoring the review's instruction, so the round-2
 * review judges the same text again. Any other draft is the template.
 */
export function draftStubs() {
  return {
    generate: vi.fn(
      async (params: { goal: string; route: { model: string } }) => {
        const contract = JSON.parse(params.goal) as {
          revision?: { previousBody?: string };
        };
        return {
          responseId: "stub_draft",
          output: {
            title: "Beta post",
            body: contract.revision?.previousBody ?? TEMPLATE_BODY,
            claims: [{ text: "Learn more.", kind: "style" }],
          },
          usage: usage(params.route.model, 1),
        };
      },
    ),
    embed: vi.fn(async () => ({
      vectors: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
      usage: { ...usage("text-embedding-3-small", 1), outputTokens: 0 },
    })),
  };
}
