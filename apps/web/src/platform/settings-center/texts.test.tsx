import { describe, expect, it } from "vitest";
import { labels } from "@/lib/i18n";
import { AREAS } from "./registry";
import { areaLabel, CENTER_TEXTS, centerText } from "./texts";

describe("settings center texts", () => {
  it("has German for every English key and no extra key", () => {
    expect(Object.keys(CENTER_TEXTS.de).sort()).toEqual(
      Object.keys(CENTER_TEXTS.en).sort(),
    );
    for (const value of Object.values(CENTER_TEXTS.de)) {
      expect(value.trim()).not.toBe("");
    }
    expect(centerText("de")("scopeLabel")).toBe("Gilt für");
    expect(labels.de.manageTitle).toBe("Verwaltung & Einstellungen");
  });

  it("labels every area of AREAS in both languages", () => {
    for (const [scope, areas] of Object.entries(AREAS)) {
      for (const area of areas) {
        const label = areaLabel(scope as keyof typeof AREAS, area.id);
        expect(label.en.trim()).not.toBe("");
        expect(label.de.trim()).not.toBe("");
      }
    }
    expect(areaLabel("system", "ai")).toEqual({ en: "AI", de: "KI" });
    // An unknown area keeps its id rather than showing nothing.
    expect(areaLabel("account", "nope")).toEqual({ en: "nope", de: "nope" });
  });
});
