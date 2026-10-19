/**
 * Live smoke test of the Anthropic Claude API (MODEL_ROUTING.md, "Anthropic
 * Claude provider"): one Haiku request of at most 64 output tokens, priced
 * at the catalog's suggested rates. It proves the key, the model id, the
 * request shape (cached system prompt, strict output format) and the usage
 * fields; it does not touch Orbit's database or budget. Never run in CI.
 *
 *   read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
 *   node scripts/anthropic-smoke.ts [--model claude-haiku-5-5]
 *
 * The key is read from the environment only and never printed.
 * Exit code: 0 the call succeeded, 1 it failed, 2 bad usage.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicCatalogRateCard,
  computeCost,
} from "../packages/ai/src/index.ts";
import {
  anthropicRequest,
  anthropicStop,
  anthropicText,
  normalizeAnthropicUsage,
} from "../packages/ai/src/providers/anthropic.ts";

const args = process.argv.slice(2);
let model = "claude-haiku-5-5";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) model = args[++i]!;
  else {
    console.error(`Unknown option ${args[i]}`);
    process.exit(2);
  }
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "ANTHROPIC_API_KEY is not set (read -s ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY).",
  );
  process.exit(2);
}
const rateCard = anthropicCatalogRateCard();
if (!rateCard[model]) {
  console.error(
    `No suggested price for ${model}; known: ${Object.keys(rateCard).join(", ")}`,
  );
  process.exit(2);
}

const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 30_000 });
const request = anthropicRequest({
  route: { model, maxOutputTokens: 64, reasoningEffort: "low" },
  instructions:
    'You are a connectivity check. Answer with the JSON object {"ok":true,"model":"<your model family>"} and nothing else.',
  input: [{ role: "user", content: "Ping." }],
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" }, model: { type: "string" } },
    required: ["ok", "model"],
    additionalProperties: false,
  },
});
const startedAt = Date.now();
try {
  const message = await client.messages.create(request);
  const usage = normalizeAnthropicUsage(message.usage);
  const costMicros = computeCost(model, usage, { rateCard });
  console.log(
    JSON.stringify(
      {
        model: message.model,
        stop: anthropicStop(message),
        text: anthropicText(message).slice(0, 200),
        durationMs: Date.now() - startedAt,
        usage,
        costUsd: (costMicros / 1_000_000).toFixed(6),
        pricedAt: rateCard[model]!.verifiedAt,
      },
      null,
      2,
    ),
  );
  process.exit(anthropicStop(message) === "completed" ? 0 : 1);
} catch (error) {
  // Status and type only: the message may quote the request.
  const status = (error as { status?: unknown }).status;
  console.error(
    `Anthropic call failed: ${error instanceof Error ? error.name : "unknown"}${typeof status === "number" ? ` (HTTP ${status})` : ""}`,
  );
  process.exit(1);
}
