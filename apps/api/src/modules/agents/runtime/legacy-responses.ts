import { DomainError } from "../../../shared.ts";
import type { AgentRuntime } from "./port.ts";

/** The hand-written Responses tool loop that Orbit Chat has always run. */
export const legacyResponsesRuntime: AgentRuntime = {
  name: "legacy_responses",
  async runTurn({ input, model, tools, limits, signal }) {
    let modelCalls = 0;
    let toolCalls = 0;
    while (modelCalls < limits.maxModelCalls) {
      if (signal.aborted) throw new DomainError("CHAT_CANCELED");
      const step = await model.call({ input, signal });
      modelCalls++;
      input.push(...step.output);
      if (!step.toolCalls.length && !step.toolSearches.length) break;
      if (
        toolCalls + step.toolCalls.length + step.toolSearches.length >
          limits.maxToolCalls ||
        modelCalls >= limits.maxModelCalls
      )
        throw new DomainError("CHAT_TOOL_LIMIT");
      // Tool searches are answered first, in the client-executed form (ADR 0007).
      for (const search of step.toolSearches) {
        toolCalls++;
        const found = await tools.search(search, toolCalls);
        input.push({
          type: "tool_search_output",
          call_id: search.callId,
          execution: "client",
          status: "completed",
          tools: found,
        });
      }
      for (const call of step.toolCalls) {
        toolCalls++;
        const output = await tools.execute(call, toolCalls);
        input.push({
          type: "function_call_output",
          call_id: call.callId,
          output,
        });
      }
    }
    return { modelCalls, toolCalls };
  },
};
