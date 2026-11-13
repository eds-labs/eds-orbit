import { describe, expect, it } from "vitest";
import { resolveSection, validateSections, visibleSections } from "../registry";
import { accountSections } from "./account";

describe("account scope", () => {
  it("registers valid sections", () => {
    expect(() => validateSections(accountSections)).not.toThrow();
    expect(accountSections.every((s) => s.scope === "account")).toBe(true);
  });

  it("shows each section only with its capability", () => {
    const keys = (caps: Parameters<typeof visibleSections>[2]) =>
      visibleSections(accountSections, "account", caps).map((s) => s.id);
    expect(keys([])).toEqual([]);
    expect(keys(["account.apps"])).toEqual(["apps"]);
    expect(keys(["account.profile", "account.assistant"])).toEqual([
      "account",
      "context",
    ]);
  });

  it("names nothing with a segment after a section", () => {
    const all = visibleSections(accountSections, "account", [
      "account.profile",
      "account.apps",
      "account.assistant",
    ]);
    expect(all.some((s) => s.takesId)).toBe(false);
    for (const s of all) {
      expect(resolveSection(all, s.area, [...s.id.split("/"), "extra"])).toBeNull();
      expect(resolveSection(all, s.area, ["unknown"])).toBeNull();
    }
  });

  it("lets the profile and assistant pages keep their own heads", () => {
    const own = accountSections.filter((s) => s.ownHead).map((s) => s.id);
    expect(own).toEqual(["account", "context"]);
  });
});
