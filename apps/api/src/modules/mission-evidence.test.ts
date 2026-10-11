import { describe, expect, it } from "vitest";
import { missionFactKeys } from "./mission-evidence.ts";

describe("mission fact keys", () => {
  it("prefers confirmed fact keys over free-text topics", () => {
    expect(
      missionFactKeys({
        chatProposalId: "proposal",
        allowedTopics: ["User control"],
        factKeys: ["product.user_control", "url.beta_registration"],
      }),
    ).toEqual(["product.user_control", "url.beta_registration"]);
  });

  it("keeps dotted topics for missions confirmed before fact keys existed", () => {
    expect(
      missionFactKeys({
        chatProposalId: "proposal",
        allowedTopics: ["product.user_control", "User control"],
      }),
    ).toEqual(["product.user_control"]);
    expect(
      missionFactKeys({
        chatProposalId: "proposal",
        allowedTopics: ["User control"],
      }),
    ).toBeUndefined();
  });

  it("uses the exact fact keys of an assignment mission", () => {
    // The strategy brief names its facts; without them a copywriter draft
    // retrieves every matching public fact and exceeds the fact context
    // limit (production uLiquid, 2026-10-11: EVIDENCE_INVALID).
    expect(
      missionFactKeys({
        assignmentRunId: "run",
        factKeys: ["product.status", "url.beta_registration"],
      }),
    ).toEqual(["product.status", "url.beta_registration"]);
  });

  it("uses the exact fact keys of a content package mission", () => {
    // Without them a package draft retrieves every public fact and exceeds
    // the fact context limit (production uLiquid, 2026-10-05).
    expect(
      missionFactKeys({
        packageId: "package",
        factKeys: ["product.beta_access.status", "url.beta_registration"],
      }),
    ).toEqual(["product.beta_access.status", "url.beta_registration"]);
  });

  it("ignores fact keys on missions outside a confirmed chat proposal", () => {
    expect(
      missionFactKeys({ factKeys: ["product.user_control"] }),
    ).toBeUndefined();
  });
});
