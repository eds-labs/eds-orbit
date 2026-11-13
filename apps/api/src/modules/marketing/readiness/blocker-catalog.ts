// Every readiness blocker code with its cause, fix and who can apply it
// (docs/MCP_PROJECT_ADMINISTRATION.md). Kept free of imports so the web's
// wording test can check that each code has German and English text.

export type Resolution =
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

export type BlockerEntry = {
  cause: string;
  fix: string;
  resolution: Resolution;
  tools?: string[];
};

export const READINESS_BLOCKERS: Record<string, BlockerEntry> = {
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
    tools: [
      "knowledge_sources",
      "knowledge_import_url",
      "knowledge_verify_fact",
    ],
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
    fix: "Select verified, priced models; a missing key is granted in Administration & settings → Whole system → Integrations → Central connections or added in Administration & settings → AI → Providers and keys.",
    resolution: "mcp",
    tools: ["ai_models_get", "ai_models_update"],
  },
  IMAGE_KEY_REQUIRED: {
    cause: "No key for image generation.",
    fix: "Grant an OpenAI image connection to the project or add a key in Administration & settings → AI → Providers and keys.",
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
    cause:
      "Postiz draft delivery is switched off for this deployment (ENABLE_POSTIZ_DRAFTS).",
    fix: "The operator enables Postiz drafts.",
    resolution: "operator",
  },
  PUBLISHER_WRITE_VERIFICATION_REQUIRED: {
    cause: "No Postiz connection has a verified write.",
    fix: "Run a write verification: one real test post on a sandbox account, prepared and approved in Orbit. Not available over MCP.",
    resolution: "orbit",
  },
  CHANNEL_WRITE_VERIFICATION_REQUIRED: {
    cause: "A policy channel is not write-verified on this publisher instance.",
    fix: "Write-verify each policy channel in Orbit with an approved test post.",
    resolution: "orbit",
  },
  PUBLISHING_BACKEND_DRAINING: {
    cause:
      "The project drains Postiz (publishing backend postiz_draining): Postiz finishes what it holds and nothing new is handed to it; details.postizBacklog counts what it still holds unsettled.",
    fix: "Wait until the Postiz backlog is settled, then an owner switches the project to Social in the Marketing settings (or back to Postiz).",
    resolution: "orbit",
  },
  PUBLISHING_BACKEND_SOCIAL: {
    cause: "The project publishes through Social; Postiz actions are not used.",
    fix: "Use the publish_* actions. Only a rollback to Postiz in the Marketing settings makes the postiz_* actions apply again.",
    resolution: "orbit",
  },
  SOCIAL_DISABLED: {
    cause:
      "The project publishes through Social, but the Social module is off for the installation (ORBIT_SOCIAL) or the project.",
    fix: "An owner enables the Social module for the project; the operator enables ORBIT_SOCIAL.",
    resolution: "orbit",
  },
  SOCIAL_CHANNEL_NOT_MAPPED: {
    cause:
      "A policy channel has no connected Social account: neither a social:<accountId> account nor an account mapped to the Postiz channel.",
    fix: "Connect the account in Social and map the Postiz channel in the Marketing settings, or propose the account's social:<accountId> channel in the policy.",
    resolution: "orbit",
  },
  SOCIAL_ACCOUNT_NOT_ACTIVE: {
    cause: "The Social account behind a policy channel is not active.",
    fix: "An owner reconnects the account in Social.",
    resolution: "orbit",
  },
  SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED: {
    cause:
      "Posting has not been verified on the Social account behind a policy channel.",
    fix: "Verify posting on the account in Social: one real test post, approved in Orbit. Not available over MCP.",
    resolution: "orbit",
  },
  SOCIAL_PLATFORM_NOT_AVAILABLE: {
    cause:
      "Posting to the platform of a policy channel is not switched on for this deployment (ORBIT_SOCIAL_PLATFORMS).",
    fix: "The operator adds the platform to ORBIT_SOCIAL_PLATFORMS.",
    resolution: "operator",
  },
  SOCIAL_MEDIA_PUBLIC_REQUIRED: {
    cause:
      "Instagram needs public media links, which are switched off for this deployment (ORBIT_SOCIAL_MEDIA_PUBLIC).",
    fix: "The operator enables public media links for Social.",
    resolution: "operator",
  },
  EXTERNAL_WRITES_DISABLED: {
    cause:
      "External writes are switched off for this deployment (ENABLE_EXTERNAL_WRITES).",
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
