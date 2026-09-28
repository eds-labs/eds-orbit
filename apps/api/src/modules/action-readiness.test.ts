import { describe, expect, it } from "vitest";
import {
  actionReadiness,
  readinessActions,
  type ReadinessInputs,
} from "./action-readiness.ts";

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
  postizConnected: true,
  postizChannelsAssigned: true,
  postizWriteVerified: false,
  postizChannelWriteVerified: false,
  matomoReadVerified: false,
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
      blockers: ["POSTIZ_DRAFT_HANDOFF_NOT_AVAILABLE"],
    });
    expect(actions.blog_live.state).toBe("not_configured");
    expect(actions.newsletter_live.state).toBe("not_configured");
    expect(actions.ads_live.state).toBe("not_configured");
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

  it("blocks every action while the project is paused", () => {
    const actions = actionReadiness({ ...fullyVerified, paused: true });
    for (const action of readinessActions) {
      expect(actions[action].state).not.toBe("ready");
      expect(actions[action].blockers).toContain("PROJECT_PAUSED");
    }
  });
});
