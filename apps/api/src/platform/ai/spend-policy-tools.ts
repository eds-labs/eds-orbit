import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import {
  assertSameChanges,
  requireChanges,
  settingChanges,
} from "../configuration/changes.ts";
import { projectAdministrationEnabled } from "../configuration/configuration.ts";
import { approvedOperation, readOperation } from "../tasks/operation-tools.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import { activeSpendPolicyRecord } from "./spend-mandate.ts";
import {
  readSpendPolicy,
  saveSpendPolicy,
  spendPolicyFields,
  spendPolicyInput,
} from "./spend-policy.ts";

// The AI spending authority over MCP (ADR 0015). It replaces the budget part
// of marketing_policy_update, so a project without Marketing can set it.
// Proposals need no active policy (there may be none yet); the owner
// approves each one in Orbit.

const LIMITS = [
  "profile",
  "approvedPaidUse",
  "dailyBudgetMicros",
  "monthlyBudgetMicros",
  "perRunBudgetMicros",
  "endAt",
] as const;

const change = z
  .object({
    expectedVersion: z.number().int().min(0),
    policy: spendPolicyInput,
  })
  .strict();

/** The version of the active record, 0 without one. */
async function currentVersion(tx: DbTx, scope: Scope) {
  return (await activeSpendPolicyRecord(tx, scope))?.version ?? 0;
}

async function proposed(
  tx: DbTx,
  scope: Scope,
  args: z.infer<typeof change>,
) {
  if ((await currentVersion(tx, scope)) !== args.expectedVersion)
    throw new DomainError("SPEND_POLICY_VERSION_CONFLICT", 409);
  const record = (await readSpendPolicy(tx, scope)).record as Record<
    string,
    unknown
  > | null;
  const next = spendPolicyFields(args.policy);
  const before = Object.fromEntries(
    LIMITS.map((k) => [k, record?.[k] ?? null]),
  );
  // The window of a profile moves with the approval time; compare its length.
  const after = Object.fromEntries(
    LIMITS.map((k) => [
      k,
      k === "endAt" && args.policy.profile !== "custom"
        ? `+${Math.round((Date.parse(next.endAt) - Date.parse(next.startAt)) / 86_400_000)}d`
        : next[k],
    ]),
  );
  return requireChanges(settingChanges(before, after));
}

const getTool = readOperation({
  name: "ai_spend_policy_get",
  module: "platform",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the project's AI spending authority: the active limits (daily, monthly, per run, window, paid use allowed), where they come from (platform record or the legacy marketing policy), this month's and today's spend and the standard profiles. Owners only.",
  input: z.object({}).strict(),
  permission: PROJECT_OWN,
  run: (tx, scope) => readSpendPolicy(tx, scope),
});

const update = approvedOperation({
  riskClass: "F2",
  name: "ai_spend_policy_update",
  assistant: false,
  module: "platform",
  feature: "project_administration",
  proposable: projectAdministrationEnabled,
  policyRequired: false,
  mcpProjectRequired: true,
  description:
    "Proposes the project's AI spending authority against expectedVersion from ai_spend_policy_get (record version, 0 without one): policy = {profile: off|test|normal} or {profile: custom, startAt, endAt, approvedPaidUse, dailyBudgetMicros, monthlyBudgetMicros, perRunBudgetMicros}. Owners approve it in Orbit.",
  input: change,
  permission: PROJECT_OWN,
  validate: async (tx, scope, args) => {
    await proposed(tx, scope, args);
  },
  approvalContext: async (tx, scope, args) => ({
    changes: await proposed(tx, scope, args),
  }),
  revalidateContext: async (tx, scope, args, saved) =>
    assertSameChanges(saved, await proposed(tx, scope, args)),
  run: async (tx, scope, args) => {
    await proposed(tx, scope, args);
    const row = await saveSpendPolicy(tx, scope, args.policy);
    return { id: row.id, version: row.version };
  },
  executionResult: async (_tx, _scope, saved) => saved,
});

export const spendPolicyTools = [getTool, update.tool];
export const spendPolicyActionTypes = { [update.actionType]: update.action };
