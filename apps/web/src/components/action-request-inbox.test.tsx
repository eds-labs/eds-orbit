import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  channelLabel,
  mcpClientHost,
  RequestedViaMcp,
} from "./action-request-inbox";

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

describe("MCP origin of a decision (WP-M4)", () => {
  const mcp = (clientId: string) => ({
    kind: "mcp",
    userId: "u",
    clientId,
  });

  it("names the host of the client id", () => {
    expect(mcpClientHost(mcp("https://claude.ai/oauth/metadata.json"))).toBe(
      "claude.ai",
    );
  });

  it("falls back to the raw id when it is not a URL and shows nothing for other requesters", () => {
    expect(mcpClientHost(mcp("legacy-client"))).toBe("legacy-client");
    expect(mcpClientHost({ kind: "user", userId: "u" })).toBeNull();
    expect(mcpClientHost({ kind: "agent", userId: "u" })).toBeNull();
    expect(mcpClientHost({ kind: "mcp", userId: "u" })).toBeNull();
  });

  it("renders the label as text only, in both languages", () => {
    const requester = mcp("https://client.example/<script>alert(1)</script>");
    expect(
      renderToStaticMarkup(
        <RequestedViaMcp requestedBy={requester} de={false} />,
      ),
    ).toContain("via MCP client client.example");
    expect(
      renderToStaticMarkup(<RequestedViaMcp requestedBy={requester} de />),
    ).toContain("über MCP-Client client.example");
    expect(
      renderToStaticMarkup(
        <RequestedViaMcp requestedBy={mcp("javascript:alert(1)")} de={false} />,
      ),
    ).not.toContain("<script");
    expect(
      renderToStaticMarkup(
        <RequestedViaMcp requestedBy={{ kind: "user", userId: "u" }} de />,
      ),
    ).toBe("");
  });
});
