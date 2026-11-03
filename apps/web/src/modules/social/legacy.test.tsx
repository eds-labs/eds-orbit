import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MigrationPanel, type MigrationView } from "./legacy";

// Moving a project from Postiz to Social (ADR 0020, S10): channel mapping,
// what Postiz still holds, the history mirror and the backend switch.

const view = (over: Partial<MigrationView> = {}): MigrationView => ({
  backend: "postiz",
  channels: [
    { integrationId: "x-int", name: "Synthetic X", platform: "x", accountId: "a-x", suggestedAccountId: null },
    { integrationId: "tg-int", name: "Synthetic Telegram", platform: "telegram", accountId: null, suggestedAccountId: "a-tg" },
    { integrationId: "li-int", name: "Synthetic LinkedIn", platform: null, accountId: null, suggestedAccountId: null },
  ],
  accounts: [
    { accountId: "a-x", platform: "x", handle: "@orbit_x", displayName: "Orbit X", status: "active", legacyPostizIntegrationId: "x-int" },
    { accountId: "a-tg", platform: "telegram", handle: "Orbit channel", displayName: "Orbit channel", status: "active", legacyPostizIntegrationId: null },
  ],
  inventory: { backend: "postiz", channels: { assigned: 3, mapped: 1 }, publications: { published: 4 }, postizDrafts: {}, openExceptions: {}, blockingSwitch: 0, readyToSwitch: true },
  ...over,
});
const render = (v: MigrationView, owner = true, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <MigrationPanel view={v} owner={owner} locale={locale} busy={false} mirror={null} onMap={() => {}} onBackend={() => {}} onMirror={() => {}} />,
  );
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*>${name}</button>`))?.[0];

describe("Postiz migration panel", () => {
  it("lists the Postiz channels with their account, a suggestion and the unsupported ones", () => {
    const html = render(view());
    expect(html).toContain("Move from Postiz");
    expect(html).toContain("Synthetic X");
    expect(html).toContain("@orbit_x");
    expect(html).toContain("Suggested: Orbit channel");
    expect(html).toContain("Orbit X (@orbit_x)");
    expect(html).toContain("Synthetic LinkedIn");
    expect(html).toContain("not available in Social yet");
    expect(html).toContain("Marketing publishes through Postiz");
  });

  it("offers draining first and the switch only when Postiz holds nothing and every channel is mapped", () => {
    expect(button(render(view()), "Stop new posts to Postiz")).toBeDefined();
    // One channel of a supported platform is not mapped: no switch yet.
    expect(button(render(view({ backend: "postiz_draining" })), "Switch to Social")).toContain("disabled");
    // LinkedIn is assigned but Social cannot post there: no switch either.
    expect(render(view({ backend: "postiz_draining" }))).toContain("remove from Marketing&#x27;s channels what Social cannot post to yet: Synthetic LinkedIn");
    const ready = view({
      backend: "postiz_draining",
      channels: view()
        .channels.filter((c) => c.platform)
        .map((c) => (c.integrationId === "tg-int" ? { ...c, accountId: "a-tg", suggestedAccountId: null } : c)),
    });
    expect(button(render(ready), "Switch to Social")).not.toContain("disabled");
    const busy = { ...ready, inventory: { ...ready.inventory, blockingSwitch: 2, readyToSwitch: false } };
    expect(render(busy)).toContain("Postiz still has 2 posts or drafts to settle");
    expect(button(render(busy), "Switch to Social")).toContain("disabled");
    expect(button(render(view({ backend: "social" })), "Back to Postiz")).toBeDefined();
  });

  it("shows the mirror's counts and leaves the controls to the owner", () => {
    const html = renderToStaticMarkup(
      <MigrationPanel
        view={view()}
        owner
        locale="en"
        busy={false}
        mirror={{ dryRun: true, created: 4, updated: 0, unchanged: 0, unmapped: 1, byStatus: { published: 3, draft: 1 } }}
        onMap={() => {}}
        onBackend={() => {}}
        onMirror={() => {}}
      />,
    );
    expect(html).toContain("4 to copy, 0 to update, 1 on unmapped channels");
    expect(button(html, "Copy history")).toBeDefined();
    const viewer = render(view(), false);
    expect(button(viewer, "Stop new posts to Postiz")).toBeUndefined();
    expect(viewer).not.toContain("<select");
    expect(render(view(), true, "de")).toContain("Umzug von Postiz");
  });
});
