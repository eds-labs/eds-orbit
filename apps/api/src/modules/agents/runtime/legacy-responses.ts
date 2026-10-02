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
      if (!step.toolCalls.length) break;
      if (
        toolCalls + step.toolCalls.length > limits.maxToolCalls ||
        modelCalls >= limits.maxModelCalls
      )
        throw new DomainError("CHAT_TOOL_LIMIT");
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
