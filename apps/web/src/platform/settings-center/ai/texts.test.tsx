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
});
