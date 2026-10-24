import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { validateActiveIndexEvaluation } from "../../../../../../packages/knowledge/src/index.ts";
import { readOperation } from "../../../platform/tasks/operation-tools.ts";
import { PROJECT_READ } from "../../../platform/tenancy/permissions.ts";
import { readiness } from "./readiness.ts";

// The project's readiness as structured blockers for outside agents
// (docs/MCP_PROJECT_ADMINISTRATION.md): for each code its cause, the
// actions it stops, the fix and who can apply it. A blocker clears only
// when its check passes; nothing here changes a check's result.

type Resolution =
  /** An MCP administration tool can fix it with the owner's approval. */
  | "mcp"
  /** An owner step in Orbit that MCP cannot take (consent, real test post). */
  | "orbit"
  /** A system administrator or organization owner in the administration. */
  | "administration"
  /** A deployment setting the operator changes. */
  | "operator"
  /** Not supported by Orbit yet. */
  | "unavailable";

const BLOCKERS: Record<
  string,
  { cause: string; fix: string; resolution: Resolution; tools?: string[] }
> = {
  PROJECT_PAUSED: {
    cause: "The project is paused.",
    fix: "An owner resumes the project in Orbit.",
    resolution: "orbit",
  },
  CURRENT_PUBLIC_KNOWLEDGE_REQUIRED: {
    cause:
      "No active public source synced within its maximum age, or no verified public fact valid now.",
    fix: "Import or resync an official source and verify at least one public fact.",
    resolution: "mcp",
    tools: ["knowledge_sources", "knowledge_import_url", "knowledge_verify_fact"],
  },
  OWNER_POLICY_REQUIRED: {
    cause: "No active Marketing policy covers the current time.",
    fix: "Propose a policy (mode assisted, channels, content types, window, budgets).",
    resolution: "mcp",
    tools: ["marketing_policy_get", "marketing_policy_update"],
  },
  APPROVED_PAID_BUDGET_REQUIRED: {
    cause:
      "The active policy does not approve paid tests or has a zero daily, monthly or per-run budget.",
    fix: "Propose approvedPaidTests and budgets in the policy; the owner approves the amounts.",
    resolution: "mcp",
    tools: ["marketing_policy_update"],
  },
  POLICY_CHANNELS_REQUIRED: {
    cause: "The active policy lists no channels or no content types.",
    fix: "Propose assigned Postiz channels and content types in the policy.",
    resolution: "mcp",
    tools: ["marketing_policy_update"],
  },
  MARKETING_PROFILE_REQUIRED: {
    cause: "The project has no Marketing profile.",
    fix: "Propose the profile with all required fields.",
    resolution: "mcp",
    tools: ["project_configuration_get", "project_configuration_update"],
  },
  VERIFIED_OPENAI_MODELS_REQUIRED: {
    cause: "No usable text key or no verified models for the project.",
    fix: "Select verified, priced models; a missing key is granted in the administration or added in Settings → AI.",
    resolution: "mcp",
    tools: ["ai_models_get", "ai_models_update"],
  },
  IMAGE_KEY_REQUIRED: {
    cause: "No key for image generation.",
    fix: "Grant an OpenAI image connection to the project or add a key in Settings → AI.",
    resolution: "administration",
  },
  IMAGE_PRICING_REQUIRED: {
    cause: "No per-image cost ceiling with a price verification date.",
    fix: "Propose imageGeneration.maxCostMicrosPerImage and pricingVerifiedAt.",
    resolution: "mcp",
    tools: ["ai_models_update"],
  },
  IMAGE_MODEL_NOT_VERIFIED: {
    cause: "The image model is not among the verified models.",
    fix: "Add the image model to verifiedModels.",
    resolution: "mcp",
    tools: ["ai_models_update"],
  },
  LIVE_RAG_EVAL_REQUIRED: {
    cause:
      "The active knowledge index has no current, passed, paid live evaluation with receipts.",
    fix: "Build an embedding index, run the live evaluation (60–120 cases) and activate the passed index.",
    resolution: "mcp",
    tools: ["knowledge_evaluation_get", "knowledge_evaluate"],
  },
  POSTIZ_NOT_CONNECTED: {
    cause: "No verified Postiz connection in the project.",
    fix: "Give the project channels of the organization's Postiz connection, or attach a granted one, then verify it.",
    resolution: "mcp",
    tools: ["integrations_get", "integrations_configure", "integration_verify"],
  },
  POSTIZ_CHANNELS_NOT_ASSIGNED: {
    cause: "No Postiz channel is assigned to the project.",
    fix: "Assign channels (postiz_claim_channels for organization connections, postiz_assign_channels for the project's own).",
    resolution: "mcp",
    tools: ["integrations_get", "integrations_configure"],
  },
  POSTIZ_DRAFTS_DISABLED: {
    cause: "Postiz draft delivery is switched off for this deployment (ENABLE_POSTIZ_DRAFTS).",
    fix: "The operator enables Postiz drafts.",
    resolution: "operator",
  },
  PUBLISHER_WRITE_VERIFICATION_REQUIRED: {
    cause: "No Postiz connection has a verified write.",
    fix: "Run a write verification: one real test post on a sandbox account, prepared and approved in Orbit. Not available over MCP.",
    resolution: "orbit",
  },
  CHANNEL_WRITE_VERIFICATION_REQUIRED: {
    cause:
      "A policy channel is not write-verified on this publisher instance.",
    fix: "Write-verify each policy channel in Orbit with an approved test post.",
    resolution: "orbit",
  },
  EXTERNAL_WRITES_DISABLED: {
    cause: "External writes are switched off for this deployment (ENABLE_EXTERNAL_WRITES).",
    fix: "The operator enables external writes when live publishing is authorized.",
    resolution: "operator",
  },
  EXECUTION_MODE_TEST: {
    cause: "The deployment runs in test mode.",
    fix: "The operator switches EXECUTION_MODE to live when authorized.",
    resolution: "operator",
  },
  DRIVE_CLIENT_NOT_CONFIGURED: {
    cause: "Google Drive OAuth is not configured for this deployment.",
    fix: "The operator sets the Google Drive client.",
    resolution: "operator",
  },
  DRIVE_NOT_CONNECTED: {
    cause: "No Google Drive account is connected to the project.",
    fix: "The owner connects Google Drive in Orbit (Google consent in a browser).",
    resolution: "orbit",
  },
  DRIVE_ROOT_REQUIRED: {
    cause: "No enabled Drive root folder.",
    fix: "Choose the root folder in Orbit; a folder named like the project is chosen automatically on connect.",
    resolution: "orbit",
  },
  GOOGLE_DRIVE_RECONNECT_REQUIRED: {
    cause: "Google rejected the last token refresh.",
    fix: "The owner reconnects Google Drive in Orbit.",
    resolution: "orbit",
  },
  MATOMO_READ_VERIFICATION_REQUIRED: {
    cause: "No read-verified Matomo connection.",
    fix: "Attach the granted Matomo connection with the site id, then verify it.",
    resolution: "mcp",
    tools: ["integrations_get", "integrations_configure", "integration_verify"],
  },
  BLOG_TARGET_NOT_CONFIGURED: {
    cause: "Live blog publishing has no supported target.",
    fix: "Not supported yet; blog drafts work.",
    resolution: "unavailable",
  },
  MAIL_PROVIDER_NOT_CONFIGURED: {
    cause: "Newsletters have no supported mail provider.",
    fix: "Not supported yet; newsletter drafts work.",
    resolution: "unavailable",
  },
  ADS_WRITE_MANDATE_NOT_CONFIGURED: {
    cause: "Ads have no write mandate.",
    fix: "Not supported yet.",
    resolution: "unavailable",
  },
};

export async function readReadiness(tx: DbTx, scope: Scope) {
  const state = await readiness(tx, scope);
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
    // Every action and whether it can run now.
    actions: state.actions,
    blockers: [...affected.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, actions]) => {
        const known = BLOCKERS[code];
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
    "Reads the project's readiness: every action (drafting, images, Drive, Postiz drafts and publishing, Matomo) with its state, and each blocker with code, cause, affected actions, the fix, whether an MCP tool can fix it (and which) or it needs Orbit, the administration or the operator, and its check status.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readReadiness(tx, scope),
});

export const readinessAdminTools = [readinessTool];
