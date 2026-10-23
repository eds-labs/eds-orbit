import { describe, expect, it } from "vitest";
import { projectSettingsChange } from "../src/platform/tenancy/project-settings.ts";

const current = { language: "en", contentLanguages: ["en"] };
const base = { name: "Orbit", timezone: "Europe/Berlin" };

describe("project settings change", () => {
  it("keeps working for callers that send only the old language field", () => {
    expect(projectSettingsChange({ ...base, language: "de" }, current)).toEqual(
      {
        ...base,
        language: "de",
        contentLanguages: ["en", "de"],
      },
    );
    expect(
      projectSettingsChange(base, {
        language: "de",
        contentLanguages: ["de", "fr"],
      }),
    ).toEqual({
      ...base,
      language: "de",
      contentLanguages: ["de", "fr"],
    });
  });

  it("takes a normalized language list with its default", () => {
    expect(
      projectSettingsChange(
        {
          ...base,
          contentLanguages: ["DE", "pt_br", "fr"],
          defaultContentLanguage: "PT-BR",
        },
        current,
      ),
    ).toEqual({
      ...base,
      language: "pt-BR",
      contentLanguages: ["de", "pt-BR", "fr"],
    });
  });

  it("refuses a default outside the list, invalid codes and an empty list", () => {
    expect(() =>
      projectSettingsChange(
        { ...base, contentLanguages: ["de"], defaultContentLanguage: "en" },
        current,
      ),
    ).toThrow();
    expect(() =>
      projectSettingsChange(
        { ...base, contentLanguages: ["deutsch"] },
        current,
      ),
    ).toThrow();
    expect(() =>
      projectSettingsChange({ ...base, contentLanguages: [] }, current),
    ).toThrow();
  });

  it("validates links and leaves them alone when absent", () => {
    expect(projectSettingsChange(base, current)).not.toHaveProperty("links");
    expect(
      projectSettingsChange(
        {
          ...base,
          links: [
            {
              type: "discord",
              label: " Community ",
              url: "https://discord.gg/x",
            },
          ],
        },
        current,
      ).links,
    ).toEqual([
      { type: "discord", label: "Community", url: "https://discord.gg/x" },
    ]);
    expect(() =>
      projectSettingsChange(
        {
          ...base,
          links: [
            {
              type: "discord",
              label: "Community",
              url: "https://evil.example",
            },
          ],
        },
        current,
      ),
    ).toThrow();
    expect(() =>
      projectSettingsChange({ ...base, links: [] }, current),
    ).not.toThrow();
  });

  it("refuses unknown fields and invalid timezones", () => {
    expect(() =>
      projectSettingsChange({ ...base, mode: "autopilot" }, current),
    ).toThrow();
    expect(() =>
      projectSettingsChange({ ...base, timezone: "Mars/Base" }, current),
    ).toThrow("INVALID_TIMEZONE");
  });
});
