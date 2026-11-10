import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { validateActiveIndexEvaluation } from "../../../../../../packages/knowledge/src/index.ts";
import { readOperation } from "../../../platform/tasks/operation-tools.ts";
import { PROJECT_READ } from "../../../platform/tenancy/permissions.ts";
import { readiness } from "./readiness.ts";
import { READINESS_BLOCKERS, type BlockerEntry } from "./blocker-catalog.ts";

// The project's readiness as structured blockers for outside agents
// (docs/MCP_PROJECT_ADMINISTRATION.md): for each code its cause, the
// actions it stops, the fix and who can apply it. A blocker clears only
// when its check passes; nothing here changes a check's result.

// On Social a policy channel is a Social account (`social:<accountId>`) or a
// Postiz channel mapped to one; the Postiz wording would point elsewhere.
const ON_SOCIAL: Record<string, Partial<BlockerEntry>> = {
  POLICY_CHANNELS_REQUIRED: {
    fix: "Propose channels (the project's social:<accountId> accounts or mapped Postiz channels) and content types in the policy.",
  },
};

export async function readReadiness(tx: DbTx, scope: Scope) {
  const state = await readiness(tx, scope);
  const backend = state.publishing.backend;
  const affected = new Map<string, string[]>();
  for (const [action, value] of Object.entries(state.actions))
    for (const code of value.blockers)
      affected.set(code, [...(affected.get(code) ?? []), action]);
  for (const code of state.blockers)
    if (!affected.has(code)) affected.set(code, ["live_publishing"]);
  const evaluation = await validateActiveIndexEvaluation(tx, scope).catch(
    (error: { code?: string }) => ({
      valid: false,
      reasons: [error?.code ?? "ACTIVE_INDEX_UNAVAILABLE"],
      indexId: null,
    }),
  );
  return {
    projectId: scope.projectId,
    state: state.state,
    checkedAt: new Date().toISOString(),
    // Where approved posts go: postiz, postiz_draining or social.
    publishingBackend: backend,
    // Every action and whether it can run now.
    actions: state.actions,
    blockers: [...affected.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, actions]) => {
        const catalog = READINESS_BLOCKERS[code];
        const known =
          catalog && backend === "social" && ON_SOCIAL[code]
            ? { ...catalog, ...ON_SOCIAL[code] }
            : catalog;
        return {
          code,
          cause: known?.cause ?? "See the code.",
          affects: actions,
          fix: known?.fix ?? "See Orbit for this blocker.",
          resolution: known?.resolution ?? "orbit",
          automatable: known?.resolution === "mcp",
          tools: known?.tools ?? [],
          check: "failing" as const,
          ...(code === "LIVE_RAG_EVAL_REQUIRED"
            ? { details: { reasons: evaluation.reasons, indexId: evaluation.indexId } }
            : {}),
          ...(code === "PUBLISHING_BACKEND_DRAINING"
            ? { details: { postizBacklog: state.publishing.postizBacklog } }
            : {}),
        };
      }),
    capabilities: state.capabilities,
  };
}

const readinessTool = readOperation({
  name: "project_readiness_get",
  module: "marketing",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the project's readiness: its publishing backend (postiz, postiz_draining or social), every action (drafting, images, Drive, publishing drafts, scheduled and live posts on that backend as publish_*, the Postiz-only postiz_* actions, Matomo) with its state, and each blocker with code, cause, affected actions, the fix, whether an MCP tool can fix it (and which) or it needs Orbit, the administration or the operator, and its check status.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readReadiness(tx, scope),
});

export const readinessAdminTools = [readinessTool];
