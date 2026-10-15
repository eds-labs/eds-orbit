import { z } from "zod";
import { PROJECT_READ } from "../tenancy/permissions.ts";
import { checkToolResult } from "../assistant/cards.ts";
import {
  defineTool,
  dropNullFields,
  type OrbitTool,
  type ToolContext,
} from "../../modules/agents/tools/registry.ts";
import {
  knowledgeSearch,
  knowledgeSearchResult,
  type SearchBudget,
} from "./search.ts";

/**
 * The one `knowledge_search` tool definition (WP3.2). Callers differ only in
 * where a search's paid query embedding is reserved (`budget`) and in how
 * the tool is offered: the assistant reserves under its chat run, a
 * specialist under its task and assignment run.
 */
export function knowledgeSearchTool(options: {
  budget: (context: ToolContext) => SearchBudget;
  feature?: OrbitTool["feature"];
  deferLoading?: boolean;
}): OrbitTool {
  return defineTool({
    name: "knowledge_search",
    namespace: "knowledge",
    description:
      "Find current model-authorized public Verified Facts and Knowledge with source references. When an exact Verified Fact key is known, pass factKeys to avoid unrelated fact context.",
    // Model-facing shape only; knowledgeSearchInput stays authoritative and
    // enforces the string lengths strict mode cannot express.
    parameters: z
      .object({
        query: z.string(),
        factKeys: z.array(z.string()).max(8).nullable(),
      })
      .strict(),
    risk: "R0_read",
    permission: PROJECT_READ,
    ...(options.feature ? { feature: options.feature } : {}),
    deferLoading: options.deferLoading ?? false,
    async execute(context, args) {
      const budget = options.budget(context);
      const read = await knowledgeSearch(
        context.scope,
        dropNullFields(args),
        budget,
      );
      const checked = checkToolResult(
        knowledgeSearchResult,
        read.result,
        read.cards,
      );
      return { output: checked.result, cards: checked.cards };
    },
  });
}
