import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import {
  PLATFORM_TAB_KEYS,
} from "@/platform/settings-center/sections/project";
import { moduleSectionId } from "@/platform/settings-center/registry";

const contributing = webRegistry.modules.filter(
  (m) => (m.aiCeilings ?? []).length > 0,
);

/** The ids the settings center gives a module's settings sections. */
const sectionIds = (moduleId: string) =>
  (webRegistry.modules.find((m) => m.id === moduleId)?.settings ?? []).map(
    (s) => moduleSectionId(moduleId, s.tab.key, PLATFORM_TAB_KEYS),
  );

describe("module AI ceilings", () => {
  it("every ceiling names a module section that exists", () => {
    const named = contributing.flatMap((m) =>
      m.aiCeilings!.map((c) => ({ moduleId: m.id, section: c.section })),
    );
    for (const { moduleId, section } of named) {
      expect(sectionIds(moduleId)).toContain(section);
    }
    expect(named.map((n) => n.section)).toEqual(
      expect.arrayContaining([
        "finance/ai",
        "work/settings",
        "issues/settings",
        "support/settings",
      ]),
    );
  });

  it("keys are unique within a module and labels have both languages", () => {
    expect(contributing.map((m) => m.id).sort()).toEqual([
      "finance",
      "issues",
      "support",
      "work",
    ]);
    for (const m of contributing) {
      const keys = m.aiCeilings!.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const c of m.aiCeilings!) {
        expect(c.label.en.trim()).not.toBe("");
        expect(c.label.de.trim()).not.toBe("");
        expect(typeof c.useCeiling).toBe("function");
      }
    }
  });
});
