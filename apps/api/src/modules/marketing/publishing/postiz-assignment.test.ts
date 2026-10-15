import { describe, expect, it } from "vitest";
import {
  assignedPostizChannels,
  isAssignedPostizChannel,
  postizHealthStatus,
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

describe("Postiz health check status", () => {
  it("keeps write_verified when a sandbox write was verified", () => {
    // A read-only health check refreshed channels and dropped the write
    // proof, blocking every publication (production uLiquid, 2026-10-12).
    expect(
      postizHealthStatus({
        status: "write_verified",
        writeVerifiedIntegrationIds: ["x-1"],
      }),
    ).toBe("write_verified");
    expect(
      postizHealthStatus({
        status: "read_verified",
        writeVerifiedIntegrationIds: ["x-1"],
      }),
    ).toBe("write_verified");
  });

  it("reports read_verified without a verified sandbox write", () => {
    expect(postizHealthStatus({ status: "configured" })).toBe("read_verified");
    expect(
      postizHealthStatus({
        status: "read_verified",
        writeVerifiedIntegrationIds: [],
      }),
    ).toBe("read_verified");
  });
});
