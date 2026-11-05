/**
 * Agent templates (ADR 0021 §4.4): module-contributed starting points for
 * an agent definition. A template proposes defaults and pins guard rules
 * that are applied again on every save and every run; a user cannot remove
 * them. Example: a Support template never offers the customer reply tool
 * outside proposal mode.
 */
import { DomainError } from "../../shared.ts";
import { registeredAgentTemplates } from "../../modules/contributions.ts";
import type { AgentConfig } from "./schema.ts";

export type AgentTemplateGuard = {
  /** Tools the agent must keep. */
  requiredTools?: readonly string[];
  /** Tools the agent may never have. */
  forbiddenTools?: readonly string[];
  /** The highest mode the agent may run in. */
  maxMode?: AgentConfig["mode"];
  /** Instructions the platform puts before the user's, shown read-only. */
  lockedInstructions?: string;
};

export type AgentTemplate = {
  /** `<module>.<name>`, lower case. */
  key: string;
  title: { en: string; de: string };
  summary: { en: string; de: string };
  /** Defaults of a new agent created from the template. */
  defaults: Partial<AgentConfig>;
  guard: AgentTemplateGuard;
};

const MODES: readonly AgentConfig["mode"][] = ["read", "draft", "execute"];

/** The registered template of `key`, or AGENT_TEMPLATE_RULE when unknown. */
export function agentTemplate(key: string) {
  const template = registeredAgentTemplates().find((t) => t.key === key);
  if (!template) throw new DomainError("AGENT_TEMPLATE_RULE", 409);
  return template;
}

/**
 * Refuses AGENT_TEMPLATE_RULE when a configuration breaks its template's
 * guard rules (or names an unknown template). Called on save, on activation
 * and before every run.
 */
export function assertTemplateRules(config: AgentConfig) {
  if (!config.templateKey) return;
  const { guard } = agentTemplate(config.templateKey);
  const tools = new Set(config.tools);
  if (guard.requiredTools?.some((tool) => !tools.has(tool)))
    throw new DomainError("AGENT_TEMPLATE_RULE", 409);
  if (guard.forbiddenTools?.some((tool) => tools.has(tool)))
    throw new DomainError("AGENT_TEMPLATE_RULE", 409);
  if (guard.maxMode && MODES.indexOf(config.mode) > MODES.indexOf(guard.maxMode))
    throw new DomainError("AGENT_TEMPLATE_RULE", 409);
}

/** The locked instructions of the configuration's template, or "". */
export function templateInstructions(config: AgentConfig) {
  return config.templateKey ? (agentTemplate(config.templateKey).guard.lockedInstructions ?? "") : "";
}
