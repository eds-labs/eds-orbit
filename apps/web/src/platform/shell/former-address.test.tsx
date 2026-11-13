import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { centerText } from "@/platform/settings-center/texts";
import { OldAddressScreen } from "./former-address";

// What an old settings address shows when it cannot lead to the settings
// center (P54-D3): never the old page.

const render = (kind: "closed" | "failed", locale: "en" | "de") =>
  renderToStaticMarkup(<OldAddressScreen kind={kind} locale={locale} onRetry={() => {}} />);

describe("OldAddressScreen", () => {
  it("says a closed area is not available and links to the start page", () => {
    for (const locale of ["en", "de"] as const) {
      const t = centerText(locale);
      const html = render("closed", locale);
      expect(html, locale).toContain(t("notPermittedTitle"));
      expect(html, locale).toContain(t("oldAddressClosedBody"));
      expect(html, locale).toContain(`href="/"`);
      expect(html, locale).toContain(t("oldAddressHome"));
      expect(html, locale).not.toContain("<button");
    }
    expect(render("closed", "en")).toContain("Not available");
    expect(render("closed", "en")).toContain("You cannot open this area.");
    expect(render("closed", "en")).toContain("Go to the start page");
    expect(render("closed", "de")).toContain("Nicht verfügbar");
    expect(render("closed", "de")).toContain("Diesen Bereich kannst du nicht öffnen.");
    expect(render("closed", "de")).toContain("Zur Startseite");
  });

  it("says the settings could not be loaded and offers to try again", () => {
    for (const locale of ["en", "de"] as const) {
      const t = centerText(locale);
      const html = render("failed", locale);
      expect(html, locale).toContain(t("oldAddressFailed"));
      expect(html, locale).toMatch(new RegExp(`<button[^>]*>${t("oldAddressRetry")}</button>`));
    }
    expect(render("failed", "en")).toContain("Settings could not be loaded.");
    expect(render("failed", "en")).toContain("Try again");
    expect(render("failed", "de")).toContain("Die Einstellungen konnten nicht geladen werden.");
    expect(render("failed", "de")).toContain("Erneut versuchen");
  });

  it("calls onRetry from the button", () => {
    let retried = 0;
    const element = OldAddressScreen({ kind: "failed", locale: "en", onRetry: () => retried++ });
    // Find the button's click handler in the element tree.
    const find = (node: unknown): (() => void) | null => {
      if (!node || typeof node !== "object") return null;
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return null;
      if (typeof props.onClick === "function") return props.onClick as () => void;
      const children = props.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    find(element)?.();
    expect(retried).toBe(1);
  });
});
