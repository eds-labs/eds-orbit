import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TelegramPanel, type TelegramStatus } from "./telegram-connection";

const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0123456";
const render = (status: TelegramStatus, linkCode = true) =>
  renderToStaticMarkup(
    <TelegramPanel
      status={status}
      link={
        linkCode
          ? { linkCode: "Kx7_code", expiresAt: "2026-10-09T12:10:00.000Z" }
          : null
      }
      de
      timezone="Europe/Berlin"
      pending={false}
      error=""
      onConnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

describe("TelegramPanel", () => {
  it("never renders a token", () => {
    // Even a response that wrongly carried the token must not show it.
    const html = render({
      status: "linked",
      linkedAt: "2026-10-09T12:00:00.000Z",
      token: TOKEN,
    } as TelegramStatus);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("AAsynthetic");
    const input = html.match(/<input[^>]*name="token"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="password"');
    expect(input).toMatch(/autocomplete="off"/i);
    // Never prefilled.
    expect(input).not.toContain("value=");
  });

  it("shows the link code with its expiry and the /start instruction", () => {
    const html = render({ status: "pending", linkedAt: null });
    expect(html).toContain("/start Kx7_code");
    expect(html).toContain("Wartet auf /start");
    expect(html).toContain("Trennen");
  });

  it("shows a linked bot with its time and no code once linked", () => {
    const html = render(
      { status: "linked", linkedAt: "2026-10-09T12:00:00.000Z" },
      false,
    );
    expect(html).toContain("Verbunden seit");
    expect(html).not.toContain("/start");
  });
});
