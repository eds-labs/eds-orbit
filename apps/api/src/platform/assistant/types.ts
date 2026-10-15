import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { ToolFeature } from "../../modules/agents/tools/registry.ts";

/**
 * A module's part of the assistant (WP2.2, plans/orbit-modularization 03
 * §6.4). The platform runs the conversation, offers the tools and composes
 * the prompt; modules contribute fragments, features and proposal checks.
 */
export type AssistantContribution = {
  /** Tool features the module turns on for a run; `all` for the size bound. */
  features(ctx: { toolSearch: boolean; all?: boolean }): ToolFeature[];
  /** Prompt fragments for a run, in order; `all` gives every fragment. */
  instructions(ctx: { toolSearch: boolean; all?: boolean }): string[];
  /** Proposal tools whose invalid input returns to the model with its fields. */
  validationCodes?: Readonly<Record<string, string>>;
};

/**
 * Extra fields of one conversation a module adds to the conversation read
 * (WP2.2), such as its content packages and assignments, keyed by field.
 */
export type ConversationSections = (
  tx: DbTx,
  scope: Scope,
  conversationId: string,
  messages: ReadonlyArray<{ cards: unknown[] }>,
) => Promise<Record<string, unknown>>;
