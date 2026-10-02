// Provider-neutral agent runtime port (ADR 0005). No SDK or provider types here.

export type ToolCallRequest = {
  callId: string;
  name: string;
  arguments: string;
};

export type ModelStep = { output: unknown[]; toolCalls: ToolCallRequest[] };

/** Orbit-owned: reserves, transmits, settles and records exactly one model request. Never retries. */
export interface BudgetedModel {
  call(request: { input: unknown[]; signal: AbortSignal }): Promise<ModelStep>;
}

/** Orbit-owned: runs one model-requested tool call; returns the text sent back to the model. */
export interface ToolHost {
  execute(call: ToolCallRequest, callIndex: number): Promise<string>;
}

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
