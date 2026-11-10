import { describe, expect, it } from "vitest";
import {
  actionReadiness,
  readinessActions,
  type ReadinessInputs,
} from "./action-readiness.ts";
import { READINESS_BLOCKERS } from "./blocker-catalog.ts";

// Mirrors the accepted uLiquid Phase 6 state: internal drafting works while
// publishing prerequisites are intentionally missing.
const draftOnly: ReadinessInputs = {
  paused: false,
  executionMode: "test",
  externalWritesEnabled: false,
  currentPublicKnowledge: true,
  activePolicy: true,
  paidMandate: true,
  policyHasChannelsAndTypes: true,
  marketingProfile: true,
  textModelVerified: true,
  imageKeyConfigured: false,
  imagePricingCurrent: false,
  imageModelVerified: false,
  driveConfigured: true,
  driveConnected: true,
  driveRootConfigured: true,
  driveReconnectRequired: false,
  publishingUsesDriveAssets: false,
  postizConnected: true,
  postizChannelsAssigned: true,
  postizDraftsEnabled: false,
  postizWriteVerified: false,
  postizChannelWriteVerified: false,
  matomoReadVerified: false,
  publishingBackend: "postiz",
  socialDraftBlockers: [],
  socialPublishBlockers: [],
};
const fullyVerified: ReadinessInputs = {
  ...draftOnly,
  imageKeyConfigured: true,
  imagePricingCurrent: true,
  imageModelVerified: true,
  postizWriteVerified: true,
  postizChannelWriteVerified: true,
  matomoReadVerified: true,
};

describe("action-specific readiness", () => {
  it("reports every action with its effect", () => {
    const actions = actionReadiness(draftOnly);
    expect(Object.keys(actions)).toEqual([...readinessActions]);
    expect(actions.text_draft.effect).toBe("internal");
    expect(actions.postiz_live.effect).toBe("external");
  });

  it("does not block internal drafting on publisher or live-write prerequisites", () => {
    const actions = actionReadiness(draftOnly);
    for (const action of [
      "chat",
      "knowledge_search",
      "text_draft",
      "internal_review",
      "export",
      "drive_save",
    ] as const)
      expect(actions[action]).toMatchObject({ state: "ready", blockers: [] });
    expect(actions.postiz_live.blockers).toEqual(
      expect.arrayContaining([
        "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
        "EXECUTION_MODE_TEST",
        "EXTERNAL_WRITES_DISABLED",
      ]),
    );
    expect(actions.visual).toMatchObject({ state: "not_configured" });
    expect(actions.visual.blockers).toContain("IMAGE_KEY_REQUIRED");
  });

  it("never reports live publishing as ready in test mode", () => {
    const actions = actionReadiness({
      ...fullyVerified,
      externalWritesEnabled: true,
    });
    expect(actions.postiz_live).toMatchObject({
      state: "blocked",
      blockers: ["EXECUTION_MODE_TEST"],
    });
    expect(actions.postiz_schedule.blockers).toEqual(["EXECUTION_MODE_TEST"]);
    expect(
      actionReadiness({
        ...fullyVerified,
        executionMode: "live",
        externalWritesEnabled: true,
      }).postiz_live,
    ).toMatchObject({ state: "ready", blockers: [] });
  });

  it("keeps unavailable integrations explicit", () => {
    const actions = actionReadiness({
      ...fullyVerified,
      executionMode: "live",
      externalWritesEnabled: true,
    });
    expect(actions.postiz_draft).toMatchObject({
      state: "not_configured",
      blockers: ["POSTIZ_DRAFTS_DISABLED"],
    });
    expect(actions.blog_live.state).toBe("not_configured");
    expect(actions.newsletter_live.state).toBe("not_configured");
    expect(actions.ads_live.state).toBe("not_configured");
  });

  it("allows Postiz drafts with their own switch while live posts stay off", () => {
    const actions = actionReadiness({
      ...draftOnly,
      postizDraftsEnabled: true,
    });
    expect(actions.postiz_draft).toMatchObject({
      state: "ready",
      effect: "external",
      blockers: [],
    });
    expect(actions.postiz_live.state).toBe("blocked");
    expect(actions.postiz_schedule.state).toBe("blocked");
  });

  it("separates missing setup from temporary blockers", () => {
    const actions = actionReadiness({
      ...draftOnly,
      textModelVerified: false,
      paidMandate: false,
    });
    expect(actions.chat.state).toBe("not_configured");
    expect(actions.text_draft.blockers).toEqual([
      "VERIFIED_OPENAI_MODELS_REQUIRED",
      "APPROVED_PAID_BUDGET_REQUIRED",
    ]);
    expect(
      actionReadiness({ ...draftOnly, paidMandate: false }).text_draft,
    ).toMatchObject({
      state: "blocked",
      blockers: ["APPROVED_PAID_BUDGET_REQUIRED"],
    });
  });

  it("blocks Drive saves and Drive-backed publishing after a rejected token refresh", () => {
    const live = {
      ...fullyVerified,
      executionMode: "live",
      externalWritesEnabled: true,
      driveReconnectRequired: true,
    };
    const inlineOnly = actionReadiness(live);
    expect(inlineOnly.drive_save).toMatchObject({
      state: "blocked",
      blockers: ["GOOGLE_DRIVE_RECONNECT_REQUIRED"],
    });
    // Posts with inline assets do not read Drive, so they stay publishable.
    expect(inlineOnly.postiz_live).toMatchObject({ state: "ready" });
    expect(inlineOnly.postiz_schedule).toMatchObject({ state: "ready" });
    const driveBacked = actionReadiness({
      ...live,
      publishingUsesDriveAssets: true,
    });
    for (const action of ["postiz_live", "postiz_schedule"] as const)
      expect(driveBacked[action]).toMatchObject({
        state: "blocked",
        blockers: ["GOOGLE_DRIVE_RECONNECT_REQUIRED"],
      });
    expect(driveBacked.text_draft.state).toBe("ready");
    expect(driveBacked.postiz_draft.blockers).not.toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
  });

  it("reports a missing connection instead of a reconnect without a token", () => {
    const actions = actionReadiness({
      ...draftOnly,
      driveConnected: false,
      driveReconnectRequired: true,
      publishingUsesDriveAssets: true,
    });
    expect(actions.drive_save).toMatchObject({
      state: "not_configured",
      blockers: ["DRIVE_NOT_CONNECTED"],
    });
    expect(actions.postiz_live.blockers).not.toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
  });

  it("blocks every action while the project is paused", () => {
    for (const publishingBackend of [
      "postiz",
      "postiz_draining",
      "social",
    ] as const) {
      const actions = actionReadiness({
        ...fullyVerified,
        paused: true,
        publishingBackend,
      });
      for (const action of readinessActions) {
        expect(actions[action].state).not.toBe("ready");
        expect(actions[action].blockers).toContain("PROJECT_PAUSED");
      }
    }
  });
});

describe("publishing readiness per backend (ADR 0020, S9/S10)", () => {
  const live = {
    ...fullyVerified,
    executionMode: "live",
    externalWritesEnabled: true,
    postizDraftsEnabled: true,
  };
  const publishing = [
    "publish_draft",
    "publish_schedule",
    "publish_live",
  ] as const;
  const postizActions = [
    "postiz_draft",
    "postiz_schedule",
    "postiz_live",
  ] as const;

  it("appends the publish_* actions after the existing ones", () => {
    expect([...readinessActions]).toEqual([
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
      "publish_draft",
      "publish_schedule",
      "publish_live",
    ]);
  });

  it("postiz: publish_* equals postiz_* and the Postiz results stay as before", () => {
    for (const inputs of [draftOnly, fullyVerified, live]) {
      const actions = actionReadiness(inputs);
      expect(actions.publish_draft).toEqual(actions.postiz_draft);
      expect(actions.publish_schedule).toEqual(actions.postiz_schedule);
      expect(actions.publish_live).toEqual(actions.postiz_live);
    }
    // Pinned: the draft-only state reads exactly as before the backend split.
    expect(actionReadiness(draftOnly)).toMatchObject({
      postiz_draft: {
        state: "not_configured",
        effect: "external",
        blockers: ["POSTIZ_DRAFTS_DISABLED"],
      },
      postiz_schedule: {
        state: "blocked",
        effect: "external",
        blockers: [
          "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
          "CHANNEL_WRITE_VERIFICATION_REQUIRED",
          "EXECUTION_MODE_TEST",
          "EXTERNAL_WRITES_DISABLED",
        ],
      },
    });
    const ready = actionReadiness(live);
    for (const action of [...postizActions, ...publishing])
      expect(ready[action]).toMatchObject({ state: "ready", blockers: [] });
  });

  it("postiz_draining: Postiz and publish actions are blocked by the drain", () => {
    const actions = actionReadiness({
      ...live,
      publishingBackend: "postiz_draining",
    });
    for (const action of [...postizActions, ...publishing])
      expect(actions[action]).toMatchObject({
        state: "blocked",
        blockers: ["PUBLISHING_BACKEND_DRAINING"],
      });
    // The Postiz checks still apply to what Postiz finishes.
    const unverified = actionReadiness({
      ...draftOnly,
      publishingBackend: "postiz_draining",
    });
    expect(unverified.publish_schedule.blockers).toEqual([
      "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
      "CHANNEL_WRITE_VERIFICATION_REQUIRED",
      "EXECUTION_MODE_TEST",
      "EXTERNAL_WRITES_DISABLED",
      "PUBLISHING_BACKEND_DRAINING",
    ]);
    expect(unverified.text_draft.state).toBe("ready");
  });

  it("social: Social's blockers decide publish_*, postiz_* are not configured", () => {
    const social = {
      ...live,
      publishingBackend: "social" as const,
      // No Postiz at all: none of its codes may show up on Social.
      postizConnected: false,
      postizChannelsAssigned: false,
      postizWriteVerified: false,
      postizChannelWriteVerified: false,
    };
    const ready = actionReadiness(social);
    for (const action of publishing)
      expect(ready[action]).toMatchObject({ state: "ready", blockers: [] });
    for (const action of postizActions)
      expect(ready[action]).toEqual({
        state: "not_configured",
        effect: "external",
        blockers: ["PUBLISHING_BACKEND_SOCIAL"],
      });
    const blocked = actionReadiness({
      ...social,
      executionMode: "test",
      publishingUsesDriveAssets: true,
      driveReconnectRequired: true,
      socialDraftBlockers: ["SOCIAL_CHANNEL_NOT_MAPPED"],
      socialPublishBlockers: [
        "SOCIAL_CHANNEL_NOT_MAPPED",
        "SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED",
      ],
    });
    expect(blocked.publish_draft).toMatchObject({
      state: "blocked",
      blockers: ["SOCIAL_CHANNEL_NOT_MAPPED"],
    });
    expect(blocked.publish_schedule).toMatchObject({
      state: "blocked",
      blockers: [
        "SOCIAL_CHANNEL_NOT_MAPPED",
        "SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED",
        "GOOGLE_DRIVE_RECONNECT_REQUIRED",
        "EXECUTION_MODE_TEST",
      ],
    });
    expect(blocked.publish_live).toEqual(blocked.publish_schedule);
    for (const action of readinessActions)
      for (const code of [
        "POSTIZ_NOT_CONNECTED",
        "POSTIZ_CHANNELS_NOT_ASSIGNED",
        "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
        "CHANNEL_WRITE_VERIFICATION_REQUIRED",
      ])
        expect(blocked[action].blockers).not.toContain(code);
    const off = actionReadiness({
      ...social,
      postizDraftsEnabled: false,
      socialDraftBlockers: ["SOCIAL_DISABLED"],
      socialPublishBlockers: ["SOCIAL_DISABLED"],
    });
    expect(off.publish_draft).toMatchObject({
      state: "not_configured",
      blockers: ["POSTIZ_DRAFTS_DISABLED", "SOCIAL_DISABLED"],
    });
    expect(off.publish_live).toMatchObject({
      state: "not_configured",
      blockers: ["SOCIAL_DISABLED"],
    });
  });

  it("describes every code it can raise in the blocker catalog", () => {
    const worst: ReadinessInputs = {
      paused: true,
      executionMode: "test",
      externalWritesEnabled: false,
      currentPublicKnowledge: false,
      activePolicy: false,
      paidMandate: false,
      policyHasChannelsAndTypes: false,
      marketingProfile: false,
      textModelVerified: false,
      imageKeyConfigured: false,
      imagePricingCurrent: false,
      imageModelVerified: false,
      driveConfigured: false,
      driveConnected: true,
      driveRootConfigured: false,
      driveReconnectRequired: true,
      publishingUsesDriveAssets: true,
      postizConnected: false,
      postizChannelsAssigned: false,
      postizDraftsEnabled: false,
      postizWriteVerified: false,
      postizChannelWriteVerified: false,
      matomoReadVerified: false,
      publishingBackend: "postiz",
      socialDraftBlockers: [],
      socialPublishBlockers: [],
    };
    const codes = new Set<string>();
    for (const publishingBackend of [
      "postiz",
      "postiz_draining",
      "social",
    ] as const)
      for (const value of Object.values(
        actionReadiness({ ...worst, publishingBackend }),
      ))
        value.blockers.forEach((code) => codes.add(code));
    expect([...codes].filter((code) => !READINESS_BLOCKERS[code])).toEqual([]);
  });
});
