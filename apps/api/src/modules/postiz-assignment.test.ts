import { describe, expect, it } from "vitest";
import {
  assignedPostizChannels,
  isAssignedPostizChannel,
} from "./postiz-assignment.ts";

const channels = [
  { id: "uliquid-x", name: "uLiquid", disabled: false },
  { id: "familyplan-facebook", name: "FamilyPlan", disabled: false },
  { id: "uliquid-telegram", name: "uLiquid", disabled: true },
];

describe("Postiz project assignment", () => {
  it("fails closed for legacy connectors with no assignment", () => {
    expect(assignedPostizChannels({ channels })).toEqual([]);
    expect(isAssignedPostizChannel({ channels }, "familyplan-facebook")).toBe(
      false,
    );
  });

  it("permits only assigned, currently connected integrations", () => {
    const connector = {
      channels,
      assignedIntegrationIds: ["uliquid-x", "uliquid-telegram"],
    };
    expect(
      assignedPostizChannels(connector).map(
        (channel: { id: string }) => channel.id,
      ),
    ).toEqual(["uliquid-x"]);
    expect(isAssignedPostizChannel(connector, "familyplan-facebook")).toBe(
      false,
    );
    expect(isAssignedPostizChannel(connector, "uliquid-telegram")).toBe(false);
  });
});
