/**
 * Action-specific readiness. Each action lists only the blockers that stop
 * that action, so internal drafting is not reported as blocked by publisher
 * or live-write prerequisites. Live actions are never ready in test mode, so
 * mock or test receipts cannot be read as real live capability.
 *
 * Publishing follows the project's backend (ADR 0020, S9/S10): `publish_*`
 * is publishing wherever the project publishes (equal to `postiz_*` on
 * Postiz, Social's checks on Social); `postiz_*` keeps its Postiz meaning
 * and is not configured on Social. While Postiz drains, new work for it is
 * refused (refuseWhileDraining), so its actions are blocked.
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
  // Appended: clients may rely on the order above.
  "publish_draft",
  "publish_schedule",
  "publish_live",
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
  // Google rejected the last refresh; cleared on success or reconnect.
  driveReconnectRequired: boolean;
  // Scheduled or live posts would read Drive-only assets at publish time.
  publishingUsesDriveAssets: boolean;
  postizConnected: boolean;
  postizChannelsAssigned: boolean;
  postizDraftsEnabled: boolean;
  postizWriteVerified: boolean;
  postizChannelWriteVerified: boolean;
  matomoReadVerified: boolean;
  // backend.ts's PublishingBackend, spelled out so this file stays free of
  // imports (the web's wording test reads readinessActions from it).
  publishingBackend: "postiz" | "postiz_draining" | "social";
  // On Social, what stops a Social draft and a post on the policy channels
  // (codes readiness.ts derives from Social's checks); empty otherwise.
  socialDraftBlockers: string[];
  socialPublishBlockers: string[];
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
  const driveReconnect =
    i.driveConnected &&
    i.driveReconnectRequired &&
    "GOOGLE_DRIVE_RECONNECT_REQUIRED";
  const publishDrive = i.publishingUsesDriveAssets && driveReconnect;
  const draining =
    i.publishingBackend === "postiz_draining" && "PUBLISHING_BACKEND_DRAINING";
  const onSocial = i.publishingBackend === "social";
  const postiz = {
    draft: result(
      "external",
      [
        paused,
        ...postizBase,
        !i.postizDraftsEnabled && "POSTIZ_DRAFTS_DISABLED",
        draining,
      ],
      ["POSTIZ_NOT_CONNECTED", "POSTIZ_DRAFTS_DISABLED"],
    ),
    schedule: result(
      "external",
      [paused, ...postizWrite, publishDrive, ...live, draining],
      ["POSTIZ_NOT_CONNECTED"],
    ),
    live: result(
      "external",
      [paused, ...postizWrite, publishDrive, ...live, draining],
      ["POSTIZ_NOT_CONNECTED"],
    ),
  };
  // On Social nothing goes to Postiz: its actions are not configured there.
  const notOnPostiz = () =>
    result(
      "external",
      [paused, "PUBLISHING_BACKEND_SOCIAL"],
      ["PUBLISHING_BACKEND_SOCIAL"],
    );
  // Social's channel checks plus what every post needs (live mode, external
  // writes, Drive images readable at the hand-off).
  const socialPublish = () =>
    result(
      "external",
      [paused, ...i.socialPublishBlockers, publishDrive, ...live],
      ["SOCIAL_DISABLED"],
    );
  const copy = (value: ActionReadiness): ActionReadiness => ({
    ...value,
    blockers: [...value.blockers],
  });
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
        driveReconnect,
      ],
      ["DRIVE_CLIENT_NOT_CONFIGURED", "DRIVE_NOT_CONNECTED"],
    ),
    internal_review: result("internal", [paused]),
    export: result("internal", [paused]),
    postiz_draft: onSocial ? notOnPostiz() : postiz.draft,
    postiz_schedule: onSocial ? notOnPostiz() : postiz.schedule,
    postiz_live: onSocial ? notOnPostiz() : postiz.live,
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
    // Social drafts use the same handoff, so ENABLE_POSTIZ_DRAFTS gates them
    // too (postiz-draft.ts); validation never blocks saving a draft.
    publish_draft: onSocial
      ? result(
          "external",
          [
            paused,
            !i.postizDraftsEnabled && "POSTIZ_DRAFTS_DISABLED",
            ...i.socialDraftBlockers,
          ],
          ["POSTIZ_DRAFTS_DISABLED", "SOCIAL_DISABLED"],
        )
      : copy(postiz.draft),
    publish_schedule: onSocial ? socialPublish() : copy(postiz.schedule),
    publish_live: onSocial ? socialPublish() : copy(postiz.live),
  };
}
