import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  policy as policySchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { audit, create, data, DomainError, list, update } from "../../../shared.ts";
import { activePolicyRecord } from "../../../platform/ai/spend-mandate.ts";
import { projectReadiness } from "../../../platform/governance/readiness.ts";
import {
  assertSameChanges,
  requireChanges,
  settingChanges,
} from "../../../platform/configuration/changes.ts";
import { projectAdministrationEnabled } from "../../../platform/configuration/configuration.ts";
import {
  approvedOperation,
  readOperation,
} from "../../../platform/tasks/operation-tools.ts";
import { PROJECT_OWN, PROJECT_READ } from "../../../platform/tenancy/permissions.ts";
import {
  assertAssignedSocialChannels,
  assignedSocialChannels,
} from "../publishing/postiz-assignment.ts";

// The Marketing policy over MCP (docs/MCP_PROJECT_ADMINISTRATION.md): the
// owner's mandate for channels, content types, budgets and publishing.
// Every save is a new policy record that replaces the active one, through
// the same path as the policy form. Over MCP the mode is observe or
// assisted only: in assisted mode every post needs the owner's approval of
// its exact package (human_each); autopilot stays an Orbit decision.

const ACTIVATION = ["active", "activatedAt", "activatedBy"];
const POLICY_FIELDS = Object.keys(policySchema.shape) as Array<
  keyof z.infer<typeof policySchema>
>;

/** The policy fields of a stored record, without its activation. */
function policyFields(row: { data: unknown } | null): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data(row)).filter(([key]) => !ACTIVATION.includes(key)),
  );
}

/**
 * Saves a policy as the project's only active one (the policy form and
 * MCP). In live execution, autopilot needs a project without blockers.
 */
export async function savePolicy(tx: DbTx, scope: Scope, raw: unknown) {
  const parsed = policySchema.parse(raw);
  for (const p of await list(tx, scope, "policies"))
    if (data(p).active) await update(tx, scope, p, { ...data(p), active: false });
  await tx.project.update({
    where: { id: scope.projectId },
    data: { mode: parsed.mode },
  });
  const row = await create(tx, scope, "policies", {
    ...parsed,
    active: true,
    activatedBy: scope.userId,
    activatedAt: new Date().toISOString(),
  });
  if (parsed.mode === "autopilot" && loadConfig().EXECUTION_MODE === "live") {
    const state = await projectReadiness(tx, scope);
    if (state.blockers.length)
      throw new DomainError(
        "LIVE_ACTIVATION_BLOCKED:" + state.blockers.join(","),
        409,
      );
  }
  await audit(tx, scope, "policies.create", row.id);
  return row;
}

/**
 * The policy version for optimistic locking: the sum of the stored policy
 * records' versions. Every save adds a record and deactivates the old one,
 * so it only grows; 0 while the project has no policy.
 */
export async function policyVersion(tx: DbTx, scope: Scope) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "policies",
    },
    select: { version: true },
  });
  return rows.reduce((sum, row) => sum + row.version, 0);
}

/** How posts of a policy mode are released. */
export const policyApprovalMode = (mode: unknown) =>
  mode === "assisted"
    ? "human_each"
    : mode === "autopilot"
      ? "automatic"
      : "no_publishing";

const usd = (micros: unknown) =>
  typeof micros === "number" ? (micros / 1e6).toFixed(2) : null;

export async function readPolicy(tx: DbTx, scope: Scope) {
  const row = await activePolicyRecord(tx, scope);
  const policy = row ? policyFields(row) : null;
  const now = Date.now();
  const config = loadConfig();
  return {
    projectId: scope.projectId,
    version: await policyVersion(tx, scope),
    active: Boolean(
      policy &&
        Date.parse(String(policy.startAt)) <= now &&
        Date.parse(String(policy.endAt)) > now,
    ),
    policyId: row?.id ?? null,
    activatedAt: data(row).activatedAt ?? null,
    policy,
    approvalMode: policy ? policyApprovalMode(policy.mode) : null,
    budgetsUsd: policy
      ? {
          daily: usd(policy.dailyBudgetMicros),
          monthly: usd(policy.monthlyBudgetMicros),
          perRun: usd(policy.perRunBudgetMicros),
        }
      : null,
    options: {
      // Postiz channels assigned to this project; a policy may use these only.
      channels: (await assignedSocialChannels(tx, scope)).map((c) => ({
        id: c.id,
        name: c.name ?? null,
        platform: c.identifier ?? null,
      })),
      contentTypes: policySchema.shape.contentTypes.element.options,
      modes: {
        observe: "No external writes; drafts and reviews only.",
        assisted:
          "human_each: every post needs the owner's approval of its exact package before publishing.",
        autopilot: "Not settable over MCP; an Orbit decision.",
      },
    },
    // Deployment switches the policy cannot change (operator settings).
    publishing: {
      executionMode: config.EXECUTION_MODE ?? null,
      externalWritesEnabled: process.env.ENABLE_EXTERNAL_WRITES === "true",
      postizDraftsEnabled: process.env.ENABLE_POSTIZ_DRAFTS === "true",
    },
    notes: {
      version:
        "Pass version as expectedVersion to marketing_policy_update. Every save creates a new policy record.",
      effects:
        "A saved policy invalidates owner approvals of packages made under the previous policy; they must be approved again.",
    },
  };
}

/** Policy fields the client may change; null clears the quiet hours. */
export const policyChange = z
  .object({
    expectedVersion: z.number().int().min(0),
    changes: z
      .object({
        mode: z.enum(["observe", "assisted"]).optional(),
        channels: policySchema.shape.channels.optional(),
        contentTypes: policySchema.shape.contentTypes.optional(),
        allowedOrigins: policySchema.shape.allowedOrigins.optional(),
        startAt: z.iso.datetime().optional(),
        endAt: z.iso.datetime().optional(),
        maxPerDay: policySchema.shape.maxPerDay.optional(),
        minIntervalMinutes: policySchema.shape.minIntervalMinutes.optional(),
        dailyBudgetMicros: policySchema.shape.dailyBudgetMicros.optional(),
        monthlyBudgetMicros: policySchema.shape.monthlyBudgetMicros.optional(),
        perRunBudgetMicros: policySchema.shape.perRunBudgetMicros.optional(),
        approvedPaidTests: z.boolean().optional(),
        quietStart: z.number().int().min(0).max(23).nullable().optional(),
        quietEnd: z.number().int().min(0).max(23).nullable().optional(),
      })
      .strict(),
  })
  .strict();
type PolicyChange = z.infer<typeof policyChange>;

/** The stored policy with the change applied, validated like the form. */
async function proposedPolicy(tx: DbTx, scope: Scope, change: PolicyChange) {
  if ((await policyVersion(tx, scope)) !== change.expectedVersion)
    throw new DomainError("POLICY_VERSION_CONFLICT", 409);
  const current = policyFields(await activePolicyRecord(tx, scope));
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(change.changes))
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  const next = policySchema.parse(merged);
  // Human approval of every post is the floor over MCP.
  if (next.mode === "autopilot")
    throw new DomainError("MCP_AUTOPILOT_NOT_ALLOWED", 409);
  if (next.channels.length)
    await assertAssignedSocialChannels(tx, scope, next.channels);
  const fields = (value: Record<string, unknown>) =>
    Object.fromEntries(POLICY_FIELDS.map((key) => [key, value[key]]));
  const changes = requireChanges(
    settingChanges(fields(current), fields(next)),
  );
  return { next, changes };
}

const getTool = readOperation({
  name: "marketing_policy_get",
  module: "marketing",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the project's active Marketing policy: mode and approval mode (human_each = every post approved by the owner), allowed Postiz channels and content types, budgets (micros and USD), posting limits, quiet hours and allowed link origins, with its version and the assignable channels.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readPolicy(tx, scope),
});

const updateTool = approvedOperation({
  name: "marketing_policy_update",
  // For outside clients (ChatGPT over MCP); the assistant reads only.
  assistant: false,
  module: "marketing",
  feature: "project_administration",
  proposable: projectAdministrationEnabled,
  // The first policy of a project is proposed without one.
  policyRequired: false,
  mcpProjectRequired: true,
  description:
    "Proposes a change to the Marketing policy: changes = {field: value} with only the fields to change, against expectedVersion from marketing_policy_get. mode is observe or assisted (every post needs owner approval); channels must be assigned Postiz channels. A project without a policy proposes all required fields. Owners only.",
  input: policyChange,
  permission: PROJECT_OWN,
  validate: async (tx, scope, args) => {
    await proposedPolicy(tx, scope, args);
  },
  approvalContext: async (tx, scope, args) => ({
    changes: (await proposedPolicy(tx, scope, args)).changes,
  }),
  revalidateContext: async (tx, scope, args, saved) =>
    assertSameChanges(saved, (await proposedPolicy(tx, scope, args)).changes),
  run: async (tx, scope, args) => {
    const { next } = await proposedPolicy(tx, scope, args);
    const row = await savePolicy(tx, scope, next);
    return { policyId: row.id, version: await policyVersion(tx, scope) };
  },
  executionResult: async (_tx, _scope, saved) => saved,
});

export const policyAdminTools = [getTool, updateTool.tool];
export const policyAdminActionTypes = {
  [updateTool.actionType]: updateTool.action,
};
