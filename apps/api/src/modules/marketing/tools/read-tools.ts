import { z } from "zod";
import { PROJECT_READ } from "../../../platform/tenancy/permissions.ts";
import {
  runReadTool,
  validateReadToolResult,
} from "../assistant/chat-tools.ts";
import {
  defineTool,
  dropNullFields,
  type OrbitTool,
  type ToolContext,
} from "../../agents/tools/registry.ts";
import { assistantKnowledgeSearch } from "../../../platform/knowledge/search-tool.ts";
import { readinessActions } from "../readiness/action-readiness.ts";

// MCP exposure (Track M WP-M3): only `project_status` opts in, as
// `marketing_project_status`. Its output schema below pins every key
// runReadTool returns, so nothing added to that result later reaches an
// outside client unreviewed; the assistant's own schema (chat-tools.ts) and
// its output are unchanged, and the chat cards never leave the assistant.
//
// Double-parse review: the SDK parses a call's arguments, then the adapter
// parses them again with `parameters` before `execute`. The tool takes none,
// so there is no transform or non-idempotent default for the second parse to
// change.
//
// Review note (WP-M5): the result shows what a project member sees in the UI,
// including the AI spend limits (modelBudget) and the titles of up to 15
// drafts; it holds no credentials, post text or customer data.

const isoTime = z.iso.datetime();
const code = z.string().min(1).max(80);
const limitedCodes = z.array(code).max(30);
const microUnits = z.number().int().nonnegative();

const actionReadinessOutput = z
  .object({
    state: z.enum(["ready", "blocked", "not_configured"]),
    effect: z.enum(["internal", "external"]),
    blockers: limitedCodes,
  })
  .strict();

/** The shape of `project_status` for an MCP client: closed, arrays bounded. */
export const projectStatusOutput = z
  .object({
    project: z
      .object({
        id: z.uuid(),
        name: z.string(),
        timezone: z.string(),
        language: z.string(),
        contentLanguages: z.array(z.string()).max(20),
        mode: z.string(),
        paused: z.boolean(),
      })
      .strict(),
    now: isoTime,
    marketingProfile: z
      .object({
        version: z.number().int().positive(),
        language: z.enum(["en", "de"]),
        primaryCtas: z.array(z.string().min(1).max(200)).min(1).max(20),
        officialLinks: z
          .array(
            z
              .object({
                label: z.string().min(1).max(120),
                url: z.url(),
                factId: z.uuid(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .nullable(),
    // The connector's assigned, enabled Postiz channels (names clipped to 120).
    availableChannels: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(120),
            provider: z.string().max(50),
          })
          .strict(),
      )
      .max(200),
    policy: z
      .object({
        id: z.uuid(),
        version: z.number().int().positive(),
        channels: z.array(z.string().max(80)).max(20),
        contentTypes: z
          .array(
            z.enum(["social", "blog", "newsletter", "script", "community"]),
          )
          .max(5),
        modelBudget: z
          .object({
            currency: z.literal("USD"),
            approvedPaidTests: z.boolean(),
            mandateActiveNow: z.boolean(),
            dailyLimitMicros: microUnits,
            monthlyLimitMicros: microUnits,
            perRunLimitMicros: microUnits,
            startAt: isoTime,
            endAt: isoTime,
            scope: z.literal(
              "AI provider spend limits, not a campaign or advertising budget",
            ),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    approvals: z
      .array(
        z
          .object({
            id: z.uuid(),
            contentId: z.uuid(),
            status: z.literal("pending"),
          })
          .strict(),
      )
      .max(15),
    drafts: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: z.string().max(120),
            status: z.enum(["draft", "review_required"]),
          })
          .strict(),
      )
      .max(15),
    // The marketing readiness provider's state, blockers and per-action
    // readiness (its `capabilities` are not part of project_status).
    readiness: z
      .object({
        state: z.enum([
          "live_ready",
          "test_ready",
          "draft_ready",
          "not_configured",
        ]),
        blockers: limitedCodes,
        actions: z
          .object(
            Object.fromEntries(
              readinessActions.map((action) => [action, actionReadinessOutput]),
            ) as Record<
              (typeof readinessActions)[number],
              typeof actionReadinessOutput
            >,
          )
          .strict(),
      })
      .strict(),
  })
  .strict();

// Model-facing shapes only; runReadTool's own zod inputs stay authoritative
// and enforce the string lengths strict mode cannot express.
function readTool(
  name: string,
  namespace: OrbitTool["namespace"],
  description: string,
  parameters: z.ZodObject,
  deferLoading = false,
  mcp?: { outputSchema: z.ZodObject },
): OrbitTool {
  return defineTool({
    name,
    namespace,
    description,
    parameters,
    risk: "R0_read",
    permission: PROJECT_READ,
    deferLoading,
    ...(mcp
      ? {
          exposure: { assistant: true, mcp: true },
          outputSchema: mcp.outputSchema,
        }
      : {}),
    async execute(context: ToolContext, args: unknown) {
      const read = await runReadTool(context.scope, name, dropNullFields(args));
      const checked = validateReadToolResult(name, read.result, read.cards);
      return { output: checked.result, cards: checked.cards };
    },
  });
}

export const readTools: readonly OrbitTool[] = [
  readTool(
    "project_status",
    "project",
    "Read the current project, policy, open approvals, blockers, and available channels.",
    z.object({}).strict(),
    false,
    { outputSchema: projectStatusOutput },
  ),
  // The platform's search, listed here to keep its place in the tool list.
  assistantKnowledgeSearch,
  readTool(
    "approved_assets",
    "assets",
    "Find approved brand assets in this project. Empty query lists all. Return metadata, never asset bytes or credentials.",
    z.object({ query: z.string().nullable() }).strict(),
    true,
  ),
  readTool(
    "analytics_memory",
    "analytics",
    "Summarize existing metrics, insights, and confirmed preferences as observations, not verified product facts.",
    z.object({ campaign: z.string().nullable() }).strict(),
    true,
  ),
];
