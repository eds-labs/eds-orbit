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
