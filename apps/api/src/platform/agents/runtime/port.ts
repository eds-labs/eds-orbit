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
  /**
   * The response hit its output limit; `output` holds its visible text and
   * the host's request to continue, and the turn needs another model call.
   */
  truncated?: boolean;
};

/** Orbit-owned: reserves, transmits, settles and records exactly one model request. Never retries. */
export interface BudgetedModel {
  call(request: ModelRequest): Promise<ModelStep>;
}

export type ModelRequest = {
  input: unknown[];
  signal: AbortSignal;
  /**
   * Tool definitions the host loaded earlier in this turn (staged loading,
   * ADR 0022 §6), to append after the turn's fixed tool list. Present only
   * when the host loads tools that way; the fixed list never changes within
   * a turn, so a provider's prompt cache keeps its prefix.
   */
  loadedTools?: unknown[];
};

/** Orbit-owned: runs model-requested tools and tool searches. */
export interface ToolHost {
  /** Runs one tool call; returns the text sent back to the model. */
  execute(call: ToolCallRequest, callIndex: number): Promise<string>;
  /** Answers one tool search; returns the tool definitions the model may load. */
  search(request: ToolSearchRequest, callIndex: number): Promise<unknown[]>;
  /**
   * Provider-neutral staged loading (ADR 0022 §6): the definitions loaded by
   * tool calls so far in this turn, in loading order, append-only. The
   * runtime passes them with every following model call, for OpenAI and
   * Anthropic alike, instead of returning them as `tool_search_output`
   * items (which only the OpenAI Responses API understands).
   */
  loadedTools?(): unknown[];
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
