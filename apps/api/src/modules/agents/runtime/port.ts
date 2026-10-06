// Provider-neutral agent runtime port (ADR 0005). No SDK or provider types here.

export type ToolCallRequest = {
  callId: string;
  name: string;
  arguments: string;
};

/** A client-executed tool search (ADR 0007); `arguments` is passed on as the model sent it. */
export type ToolSearchRequest = { callId: string; arguments: unknown };

export type ModelStep = {
  output: unknown[];
  toolCalls: ToolCallRequest[];
  toolSearches: ToolSearchRequest[];
};

/** Orbit-owned: reserves, transmits, settles and records exactly one model request. Never retries. */
export interface BudgetedModel {
  call(request: { input: unknown[]; signal: AbortSignal }): Promise<ModelStep>;
}

/** Orbit-owned: runs model-requested tools and tool searches. */
export interface ToolHost {
  /** Runs one tool call; returns the text sent back to the model. */
  execute(call: ToolCallRequest, callIndex: number): Promise<string>;
  /** Answers one tool search; returns the tool definitions the model may load. */
  search(request: ToolSearchRequest, callIndex: number): Promise<unknown[]>;
}

/** `maxToolCalls` counts tool calls and tool searches together. */
export type RuntimeLimits = { maxModelCalls: number; maxToolCalls: number };

export type TurnInput = {
  input: unknown[];
  model: BudgetedModel;
  tools: ToolHost;
  limits: RuntimeLimits;
  signal: AbortSignal;
};

export type TurnResult = { modelCalls: number; toolCalls: number };

/** Runs one chat turn's model/tool loop; budget, policy and persistence stay with the host. */
export interface AgentRuntime {
  readonly name: "legacy_responses";
  runTurn(turn: TurnInput): Promise<TurnResult>;
}
