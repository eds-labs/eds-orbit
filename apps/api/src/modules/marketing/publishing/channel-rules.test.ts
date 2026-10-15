import { describe, expect, it } from "vitest";
import { finalPostText } from "./channel-rules.ts";

const url = "https://desk.uliquid.vip/en/register";

describe("final post text", () => {
  it("appends the target URL to a body without hashtags", () => {
    expect(finalPostText("Create your beta account", url)).toBe(
      `Create your beta account\n${url}`,
    );
  });

  it("puts the target URL before a closing hashtag line", () => {
    // Production uLiquid, 2026-10-15: the link came after the hashtags;
    // the reference posts lead with the call to action and its link.
    const body = "Beta access is open.\n\nCreate your beta account\n\n#BetaAccess #CryptoTrading";
    const text = finalPostText(body, url);
    expect(text).toBe(
      `Beta access is open.\n\nCreate your beta account\n${url}\n\n#BetaAccess #CryptoTrading`,
    );
    expect(text.length).toBe(body.length + 1 + url.length);
  });

  it("leaves a body alone that already contains the URL", () => {
    const body = `Join us\n${url}\n\n#uLiquid`;
    expect(finalPostText(body, url)).toBe(body);
  });

  it("keeps a body that is only hashtags and adds the URL after it", () => {
    expect(finalPostText("#uLiquid", url)).toBe(`#uLiquid\n${url}`);
  });
});
