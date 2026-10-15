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
import { knowledgeSearchTool } from "../../../platform/knowledge/search-tool.ts";

// Model-facing shapes only; runReadTool's own zod inputs stay authoritative
// and enforce the string lengths strict mode cannot express.
function readTool(
  name: string,
  namespace: OrbitTool["namespace"],
  description: string,
  parameters: z.ZodObject,
  deferLoading = false,
): OrbitTool {
  return defineTool({
    name,
    namespace,
    description,
    parameters,
    risk: "R0_read",
    permission: PROJECT_READ,
    deferLoading,
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
  ),
  // The chat reserves a search's query embedding under its run.
  knowledgeSearchTool({
    budget: (context) => ({
      retrievalJobKey: `chat:${context.runId}:knowledge:${context.callIndex}`,
      budgetRunKey: `chat:${context.runId}`,
    }),
  }),
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
