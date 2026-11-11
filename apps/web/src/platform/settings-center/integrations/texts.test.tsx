import { describe, expect, it } from "vitest";
import {
  INTEGRATION_AUTH_TYPES,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATES,
} from "./types";
import {
  authTypeLabel,
  categoryLabel,
  INTEGRATION_TEXTS,
  integrationText,
  stateLabel,
  storageLabel,
} from "./texts";

describe("integration texts", () => {
  it("has German for every English key and no extra key", () => {
    expect(Object.keys(INTEGRATION_TEXTS.de).sort()).toEqual(
      Object.keys(INTEGRATION_TEXTS.en).sort(),
    );
    for (const value of Object.values(INTEGRATION_TEXTS.de)) {
      expect(value.trim()).not.toBe("");
    }
    expect(integrationText("de")("manage")).not.toBe(integrationText("en")("manage"));
    expect(integrationText("de")("none")).not.toBe("none");
  });

  it("labels every state, category and auth type in both languages", () => {
    const groups: Array<[readonly string[], (v: never, l: "en" | "de") => string]> = [
      [INTEGRATION_STATES, stateLabel as never],
      [INTEGRATION_CATEGORIES, categoryLabel as never],
      [INTEGRATION_AUTH_TYPES, authTypeLabel as never],
      [["central", "project", "environment"], storageLabel as never],
    ];
    for (const [values, label] of groups) {
      for (const value of values) {
        for (const locale of ["en", "de"] as const) {
          const text = label(value as never, locale);
          expect(text.trim()).not.toBe("");
          expect(text).not.toBe(value);
        }
      }
    }
    expect(stateLabel("needs_attention", "de")).not.toBe(stateLabel("needs_attention", "en"));
  });
});
