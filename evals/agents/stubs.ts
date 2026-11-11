/**
 * Stubs the live review eval requires (see live-harness.ts): the copywriter's
 * `generate` and the retrieval `embed` send nothing to a provider. Used from
 * `vi.mock` factories, so this module imports nothing it stubs.
 */
import { vi } from "vitest";

// Body of the copywriter draft that gives the English cases their shape.
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
 * The hook of a post written with copy craft: the first sentence of its
 * first line, at most 160 characters. The harness gives every creative case
 * the hook of its body, and the stubbed revision derives the same one from
 * the unchanged body, so round 2 judges exactly what round 1 judged.
 */
export function hookOf(body: string) {
  const line = body.trim().split("\n")[0]!.trim();
  return (line.match(/^.+?[.?!](?=\s|$)/u)?.[0] ?? line).slice(0, 160);
}

type Contract = {
  language?: string;
  product?: string;
  campaign?: { intendedPrimaryCta?: string } | null;
  copyCraft?: true;
  creative?: unknown;
  revision?: {
    previousBody?: string;
    previousCreative?: Record<string, string>;
  };
};

/**
 * `generate` and `embed` for `packages/ai`. `generate` is the worst-case
 * copywriter: a revision (`revision` in the generation contract) returns the
 * previous body and image copy unchanged, ignoring the review's instruction,
 * so the round-2 review judges the same text again. Any other draft is the
 * template: the English one, or for a brand in another language its first
 * fact and CTA. A contract with copy craft (Creative Studio) gets the core
 * message (the product and its first fact) and the body's hook; one with a
 * creative gets image copy (its CTA is set by Orbit).
 */
export function draftStubs() {
  return {
    generate: vi.fn(
      async (params: {
        goal: string;
        route: { model: string };
        evidence?: { facts?: Array<{ value?: unknown }> };
      }) => {
        const contract = JSON.parse(params.goal) as Contract;
        const cta = contract.campaign?.intendedPrimaryCta ?? "Learn more.";
        const fact = String(params.evidence?.facts?.[0]?.value ?? "");
        const body =
          contract.revision?.previousBody ??
          (contract.language && contract.language !== "en"
            ? `${fact.charAt(0).toUpperCase()}${fact.slice(1)}. ${cta}`
            : TEMPLATE_BODY);
        return {
          responseId: "stub_draft",
          output: {
            title: contract.language === "de" ? "Beitrag" : "Beta post",
            body,
            claims: [{ text: cta, kind: "style" }],
            ...(contract.copyCraft
              ? {
                  coreMessage: `${contract.product ?? "Brand"}: ${fact}.`,
                  hook: hookOf(body),
                }
              : {}),
            ...(contract.creative
              ? {
                  creative: {
                    eyebrow: "",
                    subline: "",
                    cta: "",
                    ...(contract.revision?.previousCreative ?? {
                      headline: fact.slice(0, 40).trim(),
                    }),
                  },
                }
              : {}),
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
