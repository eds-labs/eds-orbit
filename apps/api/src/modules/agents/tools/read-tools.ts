import { z } from "zod";
import { runReadTool, validateReadToolResult } from "../../chat-tools.ts";
import {
  defineTool,
  dropNullFields,
  type OrbitTool,
  type ToolContext,
} from "./registry.ts";

const everyone = ["viewer", "editor", "owner"] as const;

// Model-facing shapes only; runReadTool's own zod inputs stay authoritative
// and enforce the string lengths strict mode cannot express.
function readTool(
  name: string,
  namespace: OrbitTool["namespace"],
  description: string,
  parameters: z.ZodObject,
): OrbitTool {
  return defineTool({
    name,
    namespace,
    description,
    parameters,
    risk: "R0_read",
    roles: everyone,
    deferLoading: false,
    async execute(context: ToolContext, args: unknown) {
      const read = await runReadTool(
        context.scope,
        name,
        dropNullFields(args),
        name === "knowledge_search"
          ? {
              retrievalJobKey: `chat:${context.runId}:knowledge:${context.callIndex}`,
              budgetRunKey: `chat:${context.runId}`,
            }
          : undefined,
      );
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
  ),
  readTool(
    "knowledge_search",
    "knowledge",
    "Find current model-authorized public Verified Facts and Knowledge with source references. When an exact Verified Fact key is known, pass factKeys to avoid unrelated fact context.",
    z
      .object({
        query: z.string(),
        factKeys: z.array(z.string()).max(8).nullable(),
      })
      .strict(),
  ),
  readTool(
    "approved_assets",
    "assets",
    "Find approved brand assets in this project. Empty query lists all. Return metadata, never asset bytes or credentials.",
    z.object({ query: z.string().nullable() }).strict(),
  ),
  readTool(
    "analytics_memory",
    "analytics",
    "Summarize existing metrics, insights, and confirmed preferences as observations, not verified product facts.",
    z.object({ campaign: z.string().nullable() }).strict(),
  ),
];
