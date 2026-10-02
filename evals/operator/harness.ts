import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Orbit Core operator eval cases: recorded model steps, server outcomes checked. */
const toolCall = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
const step = z.union([
  z.object({ tools: z.array(toolCall).min(1) }).strict(),
  z.object({ text: z.string().min(1) }).strict(),
]);
export const operatorCase = z
  .object({
    id: z.string().regex(/^JC\d{2}-[a-z0-9-]+$/),
    acceptance: z.array(z.string().regex(/^JC\d{2}$/)).min(1),
    role: z.enum(["owner", "editor", "viewer"]),
    contentPackages: z.boolean(),
    injectedDocument: z.string().min(1).optional(),
    input: z.string().min(1),
    expected: z.string().min(1),
    forbidden: z.string().min(1),
    toolsAllowed: z.array(z.string()),
    risk: z.string().min(1),
    steps: z.array(step).min(1).max(6),
    checks: z
      .object({
        runStatus: z.enum(["succeeded", "blocked", "failed"]),
        packages: z.number().int().min(0),
        package: z
          .object({
            status: z.string(),
            channels: z.array(z.string()),
            image: z.boolean(),
            audience: z.string().optional(),
            targetAction: z.string().optional(),
            language: z.string().optional(),
            plannedSlot: z.boolean().optional(),
          })
          .strict()
          .optional(),
        missions: z.number().int().min(0),
        publications: z.number().int().min(0),
        toolErrors: z.array(z.string()),
        offeredIncludes: z.array(z.string()).optional(),
        offeredExcludes: z.array(z.string()).optional(),
        offeredExact: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorCase = z.infer<typeof operatorCase>;

const dataset = z
  .object({
    version: z.literal(1),
    description: z.string(),
    cases: z.array(operatorCase).min(1),
  })
  .strict();

export function loadCases(path = "evals/operator/cases-v1.json") {
  const raw = readFileSync(path, "utf8");
  return {
    cases: dataset.parse(JSON.parse(raw)).cases,
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Replaces date placeholders with project-local dates (Europe/Berlin fixture). */
export function expandArguments(
  value: unknown,
  timezone: string,
  now = new Date(),
): unknown {
  if (typeof value === "string" && value === "{{dateInSevenDays}}")
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
      new Date(now.valueOf() + 7 * 86400000),
    );
  if (Array.isArray(value))
    return value.map((item) => expandArguments(item, timezone, now));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandArguments(item, timezone, now),
      ]),
    );
  return value;
}

/** Responses stream events for one recorded step. */
export function streamEvents(
  recorded: OperatorCase["steps"][number],
  index: number,
  timezone: string,
) {
  const usage = { input_tokens: 100, output_tokens: 20 };
  if ("text" in recorded)
    return [
      { type: "response.output_text.delta", delta: recorded.text },
      {
        type: "response.completed",
        response: {
          id: `resp_eval_${index}`,
          usage,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: recorded.text }],
            },
          ],
        },
      },
    ];
  return [
    {
      type: "response.completed",
      response: {
        id: `resp_eval_${index}`,
        usage,
        output: recorded.tools.map((call, position) => ({
          type: "function_call",
          call_id: `call_${index}_${position}`,
          name: call.name,
          arguments: JSON.stringify(expandArguments(call.arguments, timezone)),
        })),
      },
    },
  ];
}

/** Error codes the server returned to the model as tool outputs. */
export function toolErrorCodes(input: unknown) {
  const codes = new Set<string>();
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== "function_call_output") continue;
    try {
      const parsed = JSON.parse(String(item.output));
      if (typeof parsed?.error === "string") codes.add(parsed.error);
    } catch {
      // Non-JSON output carries no error code.
    }
  }
  return [...codes];
}
