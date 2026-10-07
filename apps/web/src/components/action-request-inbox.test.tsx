import { describe, expect, it } from "vitest";
import { channelLabel } from "./action-request-inbox";

describe("channel label in a decision", () => {
  it("names the channel and its network", () => {
    expect(
      channelLabel({
        channel: "cmufswv",
        channelName: "uLiquid",
        channelPlatform: "x",
      }),
    ).toBe("uLiquid (X)");
    expect(
      channelLabel({
        channel: "cmu9g",
        channelName: "uLiquid Desk",
        channelPlatform: "telegram",
      }),
    ).toBe("uLiquid Desk (Telegram)");
  });

  it("falls back to the ID when the channel is no longer assigned", () => {
    expect(channelLabel({ channel: "cmufswv", channelName: null })).toBe(
      "cmufswv",
    );
  });
});
