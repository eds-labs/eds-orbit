// Test support only: shared contract cases every AgentRuntime adapter must pass.
// Never import this module from production code.
import { describe, expect, it } from "vitest";
import { DomainError } from "../../../shared.ts";
import type {
  AgentRuntime,
  BudgetedModel,
  ModelStep,
  RuntimeLimits,
  ToolCallRequest,
  ToolHost,
} from "./port.ts";

const call = (callId: string, name = "project_status"): ToolCallRequest => ({
  callId,
  name,
  arguments: "{}",
});
const functionCall = (request: ToolCallRequest) => ({
  type: "function_call",
  call_id: request.callId,
  name: request.name,
  arguments: request.arguments,
});
const toolStep = (...calls: ToolCallRequest[]): ModelStep => ({
  output: calls.map(functionCall),
  toolCalls: calls,
});
const answer = (text: string): ModelStep => ({
  output: [{ type: "message", role: "assistant", content: text }],
  toolCalls: [],
});
const user = { role: "user", content: "What is the project status?" };

function scriptedModel(steps: Array<ModelStep | Error>) {
  const seen: unknown[][] = [];
  const model: BudgetedModel = {
    async call({ input }) {
      seen.push([...input]);
      const step = steps[seen.length - 1] ?? steps[steps.length - 1];
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { model, seen };
}

function recordingTools(onExecute?: (call: ToolCallRequest) => void) {
  const executed: Array<{ callId: string; callIndex: number }> = [];
  const tools: ToolHost = {
    async execute(request, callIndex) {
      executed.push({ callId: request.callId, callIndex });
      onExecute?.(request);
      return `output:${request.callId}`;
    },
  };
  return { tools, executed };
}

const limits: RuntimeLimits = { maxModelCalls: 6, maxToolCalls: 8 };
const toolNames = ["project_status", "knowledge_search"];

export function describeRuntimeContract(name: string, runtime: AgentRuntime) {
  describe(`AgentRuntime contract: ${name}`, () => {
    it("stops after one model call without tool calls", async () => {
      const { model, seen } = scriptedModel([answer("Done.")]);
      const { tools, executed } = recordingTools();
      const result = await runtime.runTurn({
        input: [user],
        model,
        tools,
        limits,
        toolNames,
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ modelCalls: 1, toolCalls: 0 });
      expect(seen).toEqual([[user]]);
      expect(executed).toEqual([]);
    });

    it("feeds each tool output back in order with its call_id", async () => {
      const first = call("call-a");
      const second = call("call-b", "knowledge_search");
      const { model, seen } = scriptedModel([
        toolStep(first, second),
        answer("Done."),
      ]);
      const { tools, executed } = recordingTools();
      await runtime.runTurn({
        input: [user],
        model,
        tools,
        limits,
        toolNames,
        signal: new AbortController().signal,
      });
      expect(executed.map((entry) => entry.callId)).toEqual([
        "call-a",
        "call-b",
      ]);
      expect(seen[1]).toEqual([
        user,
        functionCall(first),
        functionCall(second),
        {
          type: "function_call_output",
          call_id: "call-a",
          output: "output:call-a",
        },
        {
          type: "function_call_output",
          call_id: "call-b",
          output: "output:call-b",
        },
      ]);
    });

    it("numbers tool calls 1..n across model calls", async () => {
      const { model } = scriptedModel([
        toolStep(call("a"), call("b")),
        toolStep(call("c")),
        answer("Done."),
      ]);
      const { tools, executed } = recordingTools();
      const result = await runtime.runTurn({
        input: [user],
        model,
        tools,
        limits,
        toolNames,
        signal: new AbortController().signal,
      });
      expect(executed).toEqual([
        { callId: "a", callIndex: 1 },
        { callId: "b", callIndex: 2 },
        { callId: "c", callIndex: 3 },
      ]);
      expect(result).toEqual({ modelCalls: 3, toolCalls: 3 });
    });

    it("refuses a step whose tool calls would exceed the tool-call limit", async () => {
      const { model, seen } = scriptedModel([
        toolStep(call("a"), call("b")),
        toolStep(call("c")),
        answer("Done."),
      ]);
      const { tools, executed } = recordingTools();
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          toolNames,
          limits: { maxModelCalls: 6, maxToolCalls: 2 },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("CHAT_TOOL_LIMIT");
      expect(seen).toHaveLength(2);
      expect(executed.map((entry) => entry.callId)).toEqual(["a", "b"]);
    });

    it("refuses tool calls requested by the last allowed model call", async () => {
      const { model, seen } = scriptedModel([
        toolStep(call("a")),
        toolStep(call("b")),
      ]);
      const { tools, executed } = recordingTools();
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          toolNames,
          limits: { maxModelCalls: 2, maxToolCalls: 8 },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("CHAT_TOOL_LIMIT");
      expect(seen).toHaveLength(2);
      expect(executed.map((entry) => entry.callId)).toEqual(["a"]);
    });

    it("never calls the model more than the model-call limit", async () => {
      const { model, seen } = scriptedModel([toolStep(call("again"))]);
      const { tools } = recordingTools();
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          toolNames,
          limits: { maxModelCalls: 3, maxToolCalls: 100 },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("CHAT_TOOL_LIMIT");
      expect(seen).toHaveLength(3);
    });

    it("cancels before a model call when the signal is aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { model, seen } = scriptedModel([answer("Done.")]);
      const { tools } = recordingTools();
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          limits,
          toolNames,
          signal: controller.signal,
        }),
      ).rejects.toThrow("CHAT_CANCELED");
      expect(seen).toHaveLength(0);
    });

    it("cancels before the next model call when aborted during a tool call", async () => {
      const controller = new AbortController();
      const { model, seen } = scriptedModel([
        toolStep(call("a")),
        answer("Done."),
      ]);
      const { tools, executed } = recordingTools(() => controller.abort());
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          limits,
          toolNames,
          signal: controller.signal,
        }),
      ).rejects.toThrow("CHAT_CANCELED");
      expect(seen).toHaveLength(1);
      expect(executed).toHaveLength(1);
    });

    it("propagates a tool host error without further tool or model calls", async () => {
      const { model, seen } = scriptedModel([
        toolStep(call("search", "knowledge_search"), call("after")),
        answer("Done."),
      ]);
      const { tools, executed } = recordingTools((request) => {
        if (request.name === "knowledge_search")
          throw new DomainError("RETRIEVAL_UNAVAILABLE");
      });
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          limits,
          toolNames,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RETRIEVAL_UNAVAILABLE");
      expect(seen).toHaveLength(1);
      expect(executed.map((entry) => entry.callId)).toEqual(["search"]);
    });

    it("propagates a model error without retrying the request", async () => {
      const { model, seen } = scriptedModel([new Error("USAGE_UNKNOWN")]);
      const { tools, executed } = recordingTools();
      await expect(
        runtime.runTurn({
          input: [user],
          model,
          tools,
          limits,
          toolNames,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("USAGE_UNKNOWN");
      expect(seen).toHaveLength(1);
      expect(executed).toEqual([]);
    });
  });
}
