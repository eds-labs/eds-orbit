/**
 * Agent definitions (ADR 0021 §5, plan WP1.5): create, edit the draft,
 * duplicate, activate, pause, resume, disable, read versions. A definition
 * holds the `active` configuration that runs and a `draft` working copy;
 * edits touch only the draft, so an active agent keeps running unchanged
 * while it is edited. Activation is owner-only and hash-bound, and makes
 * the activating owner the agent's sponsor. Every write is audited.
 */
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { requireSpendMandate } from "../../ai/spend-mandate.ts";
import { runtimeOpenAiConfiguration } from "../../ai/openai-configuration.ts";
import { requireEntitlement } from "../../entitlements/entitlements.ts";
import { audit, create, data, DomainError, update } from "../../shared.ts";
import { effectiveRole, moduleScope } from "../../tenancy/module-roles.ts";
import {
  AGENTS_MANAGE,
  AGENTS_READ,
  authorize,
  can,
  PROJECT_READ,
} from "../../tenancy/permissions.ts";
import { triggerableEvent } from "../triggers/declarations.ts";
import { assertGrantable } from "./catalog.ts";
import {
  AGENT_DEFINITIONS,
  AgentConfig,
  AgentDefinition,
  configHash,
} from "./schema.ts";
import { readAgentDefinition } from "./store.ts";
import { agentTemplate, assertTemplateRules } from "./templates.ts";

type Stored = Awaited<ReturnType<typeof readAgentDefinition>>;

/** Refuses AGENT_CONFIG_INVALID with the invalid fields (paths only). */
function parseConfig(raw: unknown): AgentConfig {
  const parsed = AgentConfig.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new DomainError("AGENT_CONFIG_INVALID", 400);
}

/** The modules a definition names in either configuration. */
const definitionModules = (definition: AgentDefinition) => [
  ...new Set([
    ...(definition.active?.modules ?? []),
    ...(definition.draft?.modules ?? []),
  ]),
];

/**
 * Whether the member may see this agent: agents read, plus read access in
 * every module it names (its results can contain module data, plan §2.4).
 */
export function maySeeAgent(scope: Scope, definition: AgentDefinition) {
  if (!can(scope, AGENTS_READ)) return false;
  return definitionModules(definition).every((module) => {
    if (effectiveRole(scope, module) === "none") return false;
    return can(moduleScope(scope, module), PROJECT_READ);
  });
}

/** Reads one agent the member may see; NOT_FOUND-like 404 otherwise. */
export async function readVisibleAgent(tx: DbTx, scope: Scope, id: string) {
  authorize(scope, AGENTS_READ);
  const stored = await readAgentDefinition(tx, scope, id);
  if (!maySeeAgent(scope, stored.definition))
    throw new DomainError("AGENT_NOT_FOUND", 404);
  return stored;
}

/**
 * Checks a configuration against what exists and what the member may grant
 * (plan §2.2 "validation on both sides"): grantable tools in named modules,
 * template guard rules, declared event types, named delegates in this
 * project, an available model, and the entitlements for its modules.
 */
export async function validateConfig(
  tx: DbTx,
  scope: Scope,
  config: AgentConfig,
  self?: string,
) {
  await assertGrantable(tx, scope, config.tools, config.modules);
  assertTemplateRules(config);
  for (const trigger of config.triggers)
    if (trigger.kind === "event") {
      const declared = triggerableEvent(trigger.type);
      if (!declared || (declared.module !== "platform" && !config.modules.includes(declared.module)))
        throw new DomainError("AGENT_CONFIG_INVALID", 400);
      if (!declared.filter.safeParse(trigger.filter).success)
        throw new DomainError("AGENT_CONFIG_INVALID", 400);
    }
  if (config.triggers.filter((t) => t.kind === "manual").length > 1)
    throw new DomainError("AGENT_CONFIG_INVALID", 400);
  if (self && config.delegateTo.includes(self))
    throw new DomainError("AGENT_DELEGATION_CYCLE", 409);
  if (config.delegateTo.length) {
    const found = await tx.entity.count({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: AGENT_DEFINITIONS,
        id: { in: config.delegateTo },
      },
    });
    if (found !== config.delegateTo.length)
      throw new DomainError("AGENT_NOT_FOUND", 404);
  }
  if (config.model.override) {
    const runtime = await runtimeOpenAiConfiguration(tx, scope);
    if (!runtime.verifiedModels.includes(config.model.override))
      throw new DomainError("AGENT_ROUTE_UNAVAILABLE", 409);
    await requireEntitlement(scope.workspaceId, { model: config.model.override });
  }
  await requireEntitlement(
    scope.workspaceId,
    ...config.modules.map((module) => ({ module })),
  );
}

/** Refuses AGENT_ENTITLEMENT when the workspace may not have another agent. */
async function assertAgentCount(tx: DbTx, scope: Scope) {
  const entitlements = await requireEntitlement(scope.workspaceId);
  if (entitlements.agentsMax === null) return;
  // Counted in this project until the entitlements table brings an
  // organization-wide count (plan §2.9).
  const count = await tx.entity.count({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: AGENT_DEFINITIONS },
  });
  if (count >= entitlements.agentsMax) throw new DomainError("AGENT_ENTITLEMENT", 403);
}

export const createAgentInput = z.strictObject({
  templateKey: z.string().max(80).nullable().optional(),
  config: z.unknown().optional(),
});

/**
 * Creates an agent as a draft: from a template's defaults, a full
 * configuration, or both (the configuration wins). Owners only.
 */
export async function createAgent(tx: DbTx, scope: Scope, raw: unknown) {
  authorize(scope, AGENTS_MANAGE, "OWNER_REQUIRED");
  const input = createAgentInput.parse(raw);
  await assertAgentCount(tx, scope);
  const defaults = input.templateKey
    ? { ...agentTemplate(input.templateKey).defaults, templateKey: input.templateKey }
    : {};
  const config = parseConfig({ ...defaults, ...(input.config as object | undefined) });
  await validateConfig(tx, scope, config);
  const definition = AgentDefinition.parse({
    status: "draft",
    active: null,
    draft: config,
    activation: null,
  });
  const row = await create(tx, scope, AGENT_DEFINITIONS, definition);
  await audit(tx, scope, "agent.created", row.id, {
    templateKey: config.templateKey,
    modules: config.modules,
    toolCount: config.tools.length,
    mode: config.mode,
  });
  return readAgentDefinition(tx, scope, row.id);
}

const versioned = z.strictObject({ version: z.int().positive() });

/** Replaces the draft on the version shown (VERSION_CONFLICT otherwise). Owners only. */
export async function updateAgentDraft(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  authorize(scope, AGENTS_MANAGE, "OWNER_REQUIRED");
  const input = versioned.extend({ config: z.unknown() }).parse(raw);
  const stored = await readAgentDefinition(tx, scope, id);
  if (stored.version !== input.version) throw new DomainError("VERSION_CONFLICT", 409);
  if (stored.definition.status === "disabled")
    throw new DomainError("AGENT_NOT_ACTIVE", 409);
  const config = parseConfig(input.config);
  await validateConfig(tx, scope, config, id);
  await update(tx, scope, stored, { ...stored.definition, draft: config });
  await audit(tx, scope, "agent.updated", id, {
    modules: config.modules,
    toolCount: config.tools.length,
    mode: config.mode,
  });
  return readAgentDefinition(tx, scope, id);
}

/** A new draft agent with the draft (or else the active) configuration. Owners only. */
export async function duplicateAgent(tx: DbTx, scope: Scope, id: string) {
  authorize(scope, AGENTS_MANAGE, "OWNER_REQUIRED");
  const source = await readAgentDefinition(tx, scope, id);
  const base = source.definition.draft ?? source.definition.active!;
  return createAgent(tx, scope, {
    config: { ...base, name: `${base.name} (copy)`.slice(0, 80), delegateTo: [] },
  });
}

/**
 * Activates the draft shown to the owner (`version` of the agent and the
 * draft's `configHash`): the draft becomes the active configuration, the
 * owner becomes the sponsor and the activation version counts up. Checked
 * again with the owner's own rights, the trigger entitlements and the
 * project's monthly spending limit across all active agents.
 */
export async function activateAgent(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  authorize(scope, AGENTS_MANAGE, "OWNER_REQUIRED");
  const input = versioned
    .extend({ configHash: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(raw);
  const stored = await readAgentDefinition(tx, scope, id);
  const draft = stored.definition.draft;
  if (stored.version !== input.version || !draft || configHash(draft) !== input.configHash)
    throw new DomainError("AGENT_VERSION_CHANGED", 409);
  await validateConfig(tx, scope, draft, id);
  const kinds = new Set(draft.triggers.map((t) => t.kind));
  await requireEntitlement(
    scope.workspaceId,
    ...[...kinds].map((triggerKind) => ({ triggerKind })),
    ...(kinds.has("schedule") || kinds.has("event") ? (["agentsAutomation"] as const) : []),
  );
  await assertProjectBudget(tx, scope, id, draft.budget.monthlyCeilingMicros);
  const previous = stored.definition.activation;
  const activation = {
    sponsorUserId: scope.userId,
    activatedAt: new Date().toISOString(),
    version: (previous?.version ?? 0) + 1,
    configHash: input.configHash,
  };
  const next = AgentDefinition.parse({
    status: "active",
    active: draft,
    draft: null,
    activation,
  });
  await update(tx, scope, stored, next);
  await audit(tx, scope, "agent.activated", id, {
    version: activation.version,
    configHash: activation.configHash,
    mode: draft.mode,
    triggerKinds: [...kinds],
  });
  return readAgentDefinition(tx, scope, id);
}

/**
 * Refuses AGENT_BUDGET_EXCEEDS_PROJECT when the month ceilings of the
 * project's active agents, with this one, exceed the monthly limit of its
 * spending authority (plan §2.6). A project without an authority refuses
 * with that authority's own code.
 */
async function assertProjectBudget(tx: DbTx, scope: Scope, id: string, ceiling: number) {
  const authority = await requireSpendMandate(tx, scope);
  const rows = await tx.entity.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: AGENT_DEFINITIONS },
  });
  let total = ceiling;
  for (const row of rows) {
    if (row.id === id) continue;
    const parsed = AgentDefinition.safeParse(row.data);
    if (parsed.success && parsed.data.status === "active" && parsed.data.active)
      total += parsed.data.active.budget.monthlyCeilingMicros;
  }
  if (total > authority.limits.monthlyBudgetMicros)
    throw new DomainError("AGENT_BUDGET_EXCEEDS_PROJECT", 409);
}

const TRANSITIONS = {
  pause: { from: ["active", "budget_exhausted"], to: "paused", event: "agent.paused" },
  resume: { from: ["paused", "budget_exhausted"], to: "active", event: "agent.resumed" },
  disable: { from: ["draft", "active", "paused", "budget_exhausted"], to: "disabled", event: "agent.disabled" },
} as const;

/** Pauses, resumes or disables an agent on the version shown. Owners only. */
export async function setAgentStatus(
  tx: DbTx,
  scope: Scope,
  id: string,
  action: keyof typeof TRANSITIONS,
  raw: unknown,
) {
  authorize(scope, AGENTS_MANAGE, "OWNER_REQUIRED");
  const { version } = versioned.parse(raw);
  const stored = await readAgentDefinition(tx, scope, id);
  if (stored.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const step = TRANSITIONS[action];
  if (!(step.from as readonly string[]).includes(stored.definition.status))
    throw new DomainError("AGENT_STATUS_INVALID", 409);
  if (action === "resume" && stored.definition.status === "budget_exhausted")
    await assertProjectBudget(tx, scope, id, stored.definition.active!.budget.monthlyCeilingMicros);
  await update(tx, scope, stored, { ...stored.definition, status: step.to });
  await audit(tx, scope, step.event, id, { from: stored.definition.status });
  return readAgentDefinition(tx, scope, id);
}

/**
 * Marks an agent `budget_exhausted` (its month ceiling is reached); the
 * work-order host calls it, with the sponsor notified by the caller.
 */
export async function exhaustAgentBudget(tx: DbTx, scope: Scope, id: string) {
  const stored = await readAgentDefinition(tx, scope, id);
  if (stored.definition.status !== "active") return;
  await update(tx, scope, stored, { ...stored.definition, status: "budget_exhausted" });
  await audit(tx, scope, "agent.budget_exhausted", id, {});
}

/** The agents the member may see, newest first, with the fields the overview shows. */
export async function listAgents(tx: DbTx, scope: Scope) {
  authorize(scope, AGENTS_READ);
  const rows = await tx.entity.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: AGENT_DEFINITIONS },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const out = [];
  for (const row of rows) {
    const parsed = AgentDefinition.safeParse(row.data);
    if (!parsed.success || !maySeeAgent(scope, parsed.data)) continue;
    out.push(agentView({ id: row.id, version: row.version, definition: parsed.data }));
  }
  return out;
}

/** What the API returns for one agent: the definition and the draft's hash for activation. */
export function agentView(stored: Stored) {
  const { definition } = stored;
  const shown = definition.draft ?? definition.active!;
  return {
    id: stored.id,
    version: stored.version,
    name: shown.name,
    status: definition.status,
    active: definition.active,
    draft: definition.draft,
    activation: definition.activation,
    draftHash: definition.draft ? configHash(definition.draft) : null,
  };
}

/** The stored versions of an agent (entity versions), newest first. */
export async function agentVersions(tx: DbTx, scope: Scope, id: string) {
  await readVisibleAgent(tx, scope, id);
  const rows = await tx.entityVersion.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, entityId: id },
    orderBy: { version: "desc" },
    take: 100,
  });
  return rows.map((row) => {
    const d = data(row) as Record<string, any>;
    return {
      version: row.version,
      status: d.status,
      activationVersion: d.activation?.version ?? null,
      createdAt: row.createdAt,
    };
  });
}

/** One stored version of an agent. */
export async function agentVersion(tx: DbTx, scope: Scope, id: string, version: number) {
  await readVisibleAgent(tx, scope, id);
  const row = await tx.entityVersion.findFirst({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, entityId: id, version },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return { version: row.version, definition: data(row) };
}
