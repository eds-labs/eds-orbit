import { DomainError } from "../shared.ts";

/**
 * What an organization may use (ADR 0021, agent platform plan §2.9). Phase 1
 * has no table and no plan catalogue (D-12): every workspace gets the code
 * default, which allows everything. The port exists so enforcement points
 * call one function now and a later billing or licence source replaces only
 * the resolver.
 */
export type AgentTriggerKind = "manual" | "schedule" | "event";

export type Entitlements = {
  /** Agents across the organization's projects; null is unlimited. */
  agentsMax: number | null;
  /** Agents may run without a person starting them (schedule, event). */
  agentsAutomation: boolean;
  agentTriggerKinds: ReadonlySet<AgentTriggerKind>;
  /** Modules agents may use; null allows every module. */
  modulesAllowed: ReadonlySet<string> | null;
  /** Models agents may use; null allows every catalogue model. */
  modelsAllowed: ReadonlySet<string> | null;
  assistantPersonal: boolean;
  assistantVoice: boolean;
  integrationsAdvanced: boolean;
};

/** The entitlements that are a yes or no. */
export type BooleanEntitlement = {
  [K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];

export const AGENT_TRIGGER_KINDS: readonly AgentTriggerKind[] = [
  "manual",
  "schedule",
  "event",
];

/** The code default: unlimited and everything allowed. */
export function defaultEntitlements(): Entitlements {
  return {
    agentsMax: null,
    agentsAutomation: true,
    agentTriggerKinds: new Set(AGENT_TRIGGER_KINDS),
    modulesAllowed: null,
    modelsAllowed: null,
    assistantPersonal: true,
    assistantVoice: true,
    integrationsAdvanced: true,
  };
}

export type EntitlementsResolver = (
  workspaceId: string,
) => Promise<Entitlements> | Entitlements;

const codeDefault: EntitlementsResolver = () => defaultEntitlements();
let resolver: EntitlementsResolver = codeDefault;

/** The organization's entitlements (Phase 1: always the code default). */
export async function entitlementsFor(
  workspaceId: string,
): Promise<Entitlements> {
  return await resolver(workspaceId);
}

/**
 * Replaces the resolver; for tests only. Pass nothing to restore the code
 * default.
 */
export function setEntitlementsResolver(next?: EntitlementsResolver) {
  resolver = next ?? codeDefault;
}

/**
 * What an enforcement point checks: a yes-or-no entitlement, a trigger kind,
 * a module or a model.
 */
export type EntitlementRequirement =
  | BooleanEntitlement
  | { triggerKind: AgentTriggerKind }
  | { module: string }
  | { model: string };

/** Whether `entitlements` allow `requirement`. */
export function entitled(
  entitlements: Entitlements,
  requirement: EntitlementRequirement,
): boolean {
  if (typeof requirement === "string") return entitlements[requirement];
  if ("triggerKind" in requirement)
    return entitlements.agentTriggerKinds.has(requirement.triggerKind);
  if ("module" in requirement)
    return (
      entitlements.modulesAllowed === null ||
      entitlements.modulesAllowed.has(requirement.module)
    );
  return (
    entitlements.modelsAllowed === null ||
    entitlements.modelsAllowed.has(requirement.model)
  );
}

/**
 * Throws AGENT_ENTITLEMENT (403) unless the workspace is entitled to every
 * requirement. Returns the entitlements so a caller can check more without a
 * second lookup.
 */
export async function requireEntitlement(
  workspaceId: string,
  ...requirements: EntitlementRequirement[]
): Promise<Entitlements> {
  const entitlements = await entitlementsFor(workspaceId);
  for (const requirement of requirements)
    if (!entitled(entitlements, requirement))
      throw new DomainError("AGENT_ENTITLEMENT", 403);
  return entitlements;
}
