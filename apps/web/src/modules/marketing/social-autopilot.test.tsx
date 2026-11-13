import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@/lib/i18n";
import { SOCIAL_AUTOPILOT_PLACE } from "@/lib/exception-text";
import {
  SOCIAL_AUTOPILOT_ANCHOR,
  SocialAutopilotConfirm,
  SocialAutopilotPanel,
  socialAutopilotBody,
  type MarketingSettingsView,
} from "./social-autopilot";

// The owner's per-project switch "Autopilot through Social" (plan
// 2026-11-10) under the publishing rules.

const view = (
  settings: Partial<MarketingSettingsView["settings"]> = {},
): MarketingSettingsView => ({
  settings: { publishingBackend: "social", ...settings },
  version: 4,
});
const panel = (
  v: MarketingSettingsView | null,
  owner = true,
  locale: Locale = "de",
  error: string | null = null,
) =>
  renderToStaticMarkup(
    <SocialAutopilotPanel
      view={v}
      owner={owner}
      locale={locale}
      busy={false}
      error={error}
      onTurnOn={() => {}}
      onTurnOff={() => {}}
    />,
  );
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("Autopilot through Social", () => {
  it("shows the state on Social with the owner's switch, off when the setting is absent", () => {
    const off = panel(view());
    expect(off).toContain("Autopilot über Social");
    expect(off).toContain(`id="${SOCIAL_AUTOPILOT_ANCHOR}"`);
    expect(off).toContain(">Aus<");
    expect(buttons(off)).toEqual(["Einschalten"]);
    const on = panel(view({ socialAutopilot: true }), true, "en");
    expect(on).toContain("Autopilot through Social");
    expect(on).toContain(">On<");
    expect(buttons(on)).toEqual(["Turn off"]);
    expect(
      buttons(panel(view({ socialAutopilot: false }), true, "en")),
    ).toEqual(["Turn on"]);
  });

  it("is read-only for editors and viewers", () => {
    const html = panel(view({ socialAutopilot: true }), false);
    expect(html).toContain(">An<");
    expect(buttons(html)).toEqual([]);
    expect(html).toContain("Nur ein Owner kann das ändern.");
  });

  it("is not shown for Postiz or while Postiz drains, nor without settings", () => {
    expect(panel(view({ publishingBackend: "postiz" }))).toBe("");
    expect(
      panel(
        view({ publishingBackend: "postiz_draining", socialAutopilot: true }),
      ),
    ).toBe("");
    expect(panel(null)).toBe("");
    // A response without settings (such as a mocked list) renders nothing.
    expect(panel({ items: [] } as unknown as MarketingSettingsView)).toBe("");
  });

  it("shows a refused change", () => {
    expect(panel(view(), true, "en", "Refused.")).toContain("Refused.");
  });

  it("asks for an explicit checkbox before turning on and says what still applies", () => {
    const html = renderToStaticMarkup(
      <SocialAutopilotConfirm
        locale="de"
        pending={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Autopilot über Social einschalten?");
    expect(html).toContain("ohne Freigabe jedes einzelnen Posts");
    expect(html).toContain("ohne Stopp-Fenster");
    for (const rule of [
      "KI-Budget",
      "Kanäle",
      "Ruhezeiten",
      "Tageslimits",
      "Sperrzeiten",
      "geprüfte Social-Konten",
      "Live-Evaluation",
    ])
      expect(html).toContain(rule);
    expect(html).toContain("diesen Schalter ausschalten");
    expect(html).toContain("Projekt pausieren");
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toContain("required");
    expect(checkbox).not.toContain("checked");
    // Submit stays disabled until the box is ticked.
    const submit = html.match(
      /<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*<\/button>/,
    )?.[0];
    expect(submit).toContain("disabled");
    expect(submit).toContain("Autopilot über Social einschalten");
    expect(
      renderToStaticMarkup(
        <SocialAutopilotConfirm
          locale="en"
          pending={false}
          error={null}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      ),
    ).toContain("without a stop window");
  });

  it("sends the whole settings with the switch and the version", () => {
    expect(socialAutopilotBody(view(), true)).toEqual({
      settings: { publishingBackend: "social", socialAutopilot: true },
      version: 4,
    });
    expect(socialAutopilotBody(view({ socialAutopilot: true }), false)).toEqual(
      {
        settings: { publishingBackend: "social", socialAutopilot: false },
        version: 4,
      },
    );
  });

  it("is where the exception text links to", () => {
    expect(SOCIAL_AUTOPILOT_PLACE.hash).toBe(`#${SOCIAL_AUTOPILOT_ANCHOR}`);
  });
});
