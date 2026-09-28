/**
 * Action-specific readiness. Each action lists only the blockers that stop
 * that action, so internal drafting is not reported as blocked by publisher
 * or live-write prerequisites. Live actions are never ready in test mode, so
 * mock or test receipts cannot be read as real live capability.
 */
export const readinessActions = [
  "chat",
  "knowledge_search",
  "text_draft",
  "visual",
  "drive_save",
  "internal_review",
  "export",
  "postiz_draft",
  "postiz_schedule",
  "postiz_live",
  "matomo",
  "blog_live",
  "newsletter_live",
  "ads_live",
] as const;
export type ReadinessAction = (typeof readinessActions)[number];
export type ActionState = "ready" | "blocked" | "not_configured";
export type ActionReadiness = {
  state: ActionState;
  effect: "internal" | "external";
  blockers: string[];
};

export type ReadinessInputs = {
  paused: boolean;
  executionMode: string | undefined;
  externalWritesEnabled: boolean;
  currentPublicKnowledge: boolean;
  activePolicy: boolean;
  paidMandate: boolean;
  policyHasChannelsAndTypes: boolean;
  marketingProfile: boolean;
  textModelVerified: boolean;
  imageKeyConfigured: boolean;
  imagePricingCurrent: boolean;
  imageModelVerified: boolean;
  driveConfigured: boolean;
  driveConnected: boolean;
  driveRootConfigured: boolean;
  postizConnected: boolean;
  postizChannelsAssigned: boolean;
  postizWriteVerified: boolean;
  postizChannelWriteVerified: boolean;
  matomoReadVerified: boolean;
};

function result(
  effect: ActionReadiness["effect"],
  blockers: (string | false)[],
  notConfigured: string[] = [],
): ActionReadiness {
  const codes = [...new Set(blockers.filter((b): b is string => !!b))];
  return {
    state: !codes.length
      ? "ready"
      : codes.some((code) => notConfigured.includes(code))
        ? "not_configured"
        : "blocked",
    effect,
    blockers: codes,
  };
}

export function actionReadiness(
  i: ReadinessInputs,
): Record<ReadinessAction, ActionReadiness> {
  const paused = i.paused && "PROJECT_PAUSED";
  const paidModel = [
    !i.textModelVerified && "VERIFIED_OPENAI_MODELS_REQUIRED",
    !i.activePolicy && "OWNER_POLICY_REQUIRED",
    !i.paidMandate && "APPROVED_PAID_BUDGET_REQUIRED",
  ];
  const live = [
    i.executionMode !== "live" && "EXECUTION_MODE_TEST",
    !i.externalWritesEnabled && "EXTERNAL_WRITES_DISABLED",
  ];
  const postizBase = [
    !i.postizConnected && "POSTIZ_NOT_CONNECTED",
    !i.postizChannelsAssigned && "POSTIZ_CHANNELS_NOT_ASSIGNED",
  ];
  const postizWrite = [
    ...postizBase,
    !i.postizWriteVerified && "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
    !i.postizChannelWriteVerified && "CHANNEL_WRITE_VERIFICATION_REQUIRED",
  ];
  return {
    chat: result(
      "internal",
      [paused, ...paidModel],
      ["VERIFIED_OPENAI_MODELS_REQUIRED"],
    ),
    knowledge_search: result(
      "internal",
      [
        paused,
        !i.currentPublicKnowledge && "CURRENT_PUBLIC_KNOWLEDGE_REQUIRED",
      ],
      ["CURRENT_PUBLIC_KNOWLEDGE_REQUIRED"],
    ),
    text_draft: result(
      "internal",
      [
        paused,
        ...paidModel,
        !i.currentPublicKnowledge && "CURRENT_PUBLIC_KNOWLEDGE_REQUIRED",
        !i.marketingProfile && "MARKETING_PROFILE_REQUIRED",
        !i.policyHasChannelsAndTypes && "POLICY_CHANNELS_REQUIRED",
      ],
      ["VERIFIED_OPENAI_MODELS_REQUIRED", "MARKETING_PROFILE_REQUIRED"],
    ),
    visual: result(
      "internal",
      [
        paused,
        !i.imageKeyConfigured && "IMAGE_KEY_REQUIRED",
        !i.imagePricingCurrent && "IMAGE_PRICING_REQUIRED",
        !i.imageModelVerified && "IMAGE_MODEL_NOT_VERIFIED",
        !i.activePolicy && "OWNER_POLICY_REQUIRED",
        !i.marketingProfile && "MARKETING_PROFILE_REQUIRED",
      ],
      ["IMAGE_KEY_REQUIRED", "IMAGE_PRICING_REQUIRED"],
    ),
    drive_save: result(
      "internal",
      [
        paused,
        !i.driveConfigured && "DRIVE_CLIENT_NOT_CONFIGURED",
        !i.driveConnected && "DRIVE_NOT_CONNECTED",
        !i.driveRootConfigured && "DRIVE_ROOT_REQUIRED",
      ],
      ["DRIVE_CLIENT_NOT_CONFIGURED", "DRIVE_NOT_CONNECTED"],
    ),
    internal_review: result("internal", [paused]),
    export: result("internal", [paused]),
    postiz_draft: result(
      "external",
      [paused, ...postizBase, "POSTIZ_DRAFT_HANDOFF_NOT_AVAILABLE"],
      ["POSTIZ_NOT_CONNECTED", "POSTIZ_DRAFT_HANDOFF_NOT_AVAILABLE"],
    ),
    postiz_schedule: result(
      "external",
      [paused, ...postizWrite, ...live],
      ["POSTIZ_NOT_CONNECTED"],
    ),
    postiz_live: result(
      "external",
      [paused, ...postizWrite, ...live],
      ["POSTIZ_NOT_CONNECTED"],
    ),
    matomo: result(
      "internal",
      [paused, !i.matomoReadVerified && "MATOMO_READ_VERIFICATION_REQUIRED"],
      ["MATOMO_READ_VERIFICATION_REQUIRED"],
    ),
    blog_live: result(
      "external",
      [paused, "BLOG_TARGET_NOT_CONFIGURED"],
      ["BLOG_TARGET_NOT_CONFIGURED"],
    ),
    newsletter_live: result(
      "external",
      [paused, "MAIL_PROVIDER_NOT_CONFIGURED"],
      ["MAIL_PROVIDER_NOT_CONFIGURED"],
    ),
    ads_live: result(
      "external",
      [paused, "ADS_WRITE_MANDATE_NOT_CONFIGURED"],
      ["ADS_WRITE_MANDATE_NOT_CONFIGURED"],
    ),
  };
}
