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

  it("ignores fact keys on missions outside a confirmed chat proposal", () => {
    expect(
      missionFactKeys({ factKeys: ["product.user_control"] }),
    ).toBeUndefined();
  });
});
