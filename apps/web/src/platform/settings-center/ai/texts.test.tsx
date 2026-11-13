import { describe, expect, it } from "vitest";
import { AI_TEXTS, aiText } from "./texts";

describe("AI texts", () => {
  it("has German for every English key and no extra key", () => {
    expect(Object.keys(AI_TEXTS.de).sort()).toEqual(
      Object.keys(AI_TEXTS.en).sort(),
    );
    for (const value of Object.values(AI_TEXTS.de))
      expect(value?.trim()).not.toBe("");
    expect(aiText("de")("originProject")).toBe("Dieses Projekt");
    expect(aiText("en")("originProject")).toBe("This project");
  });

  it("does not claim own settings for a project without any (review Minor 6)", () => {
    expect(aiText("en")("defaultsOff")).toBe(
      "Standard models and presets are not switched on for this installation; a project uses its own AI settings, or the profiles and the environment where it has none.",
    );
    expect(aiText("de")("defaultsOff")).toBe(
      "Standard-Modelle und Stufen sind für diese Installation nicht eingeschaltet; ein Projekt nutzt seine eigenen KI-Einstellungen oder, wo es keine hat, die Profile und die Umgebung.",
    );
  });
});
