import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import type { SettingsSection } from "@/platform/shell/types";
import { adaptIntegrationSections, resolveSection, visibleSections } from "./registry";
import { parseManagePath } from "./routes";
import { projectModuleSections, projectSections } from "./sections/project";
import { CAPABILITIES } from "./types";

// The links the API sends to the settings center (fixture of the API test
// center-links.test.ts, rewritten there). Each must end on a real section of
// the registry, so a renamed or removed section fails here, not in the field.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../api/tests/fixtures/center-links.json", import.meta.url),
    "utf8",
  ),
) as Array<{ producer: string; link: string }>;

/** The project sections an owner sees with every module shown (as redirects.test.tsx). */
function ownerSections() {
  const caps = CAPABILITIES.filter((c) => c.startsWith("project."));
  const contributed = webRegistry.modules.flatMap((m) =>
    (m.settings ?? []).map((s) => ({
      section: { ...s, tab: { ...s.tab, group: s.tab.group ?? m.id } },
      shown: { content: null } as ReturnType<SettingsSection["useSection"]>,
    })),
  );
  const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
  return [
    ...visibleSections(projectSections, "project", caps),
    ...projectModuleSections(contributed, modules).sections,
    ...adaptIntegrationSections(
      webRegistry.modules.flatMap((m) =>
        (m.integrations ?? []).map((c) => ({ ...c, moduleId: m.id })),
      ),
    ),
  ];
}

describe("links the API sends to the settings center", () => {
  it("lists links", () => {
    expect(fixture.length).toBeGreaterThan(0);
  });

  it.each(fixture.map((f) => [f.producer, f.link] as const))(
    "%s resolves to a section: %s",
    (_producer, link) => {
      const path = new URL(link, "https://orbit.invalid").pathname;
      const [head, ...parts] = path.split("/").filter(Boolean).map(decodeURIComponent);
      expect(head).toBe("manage");
      const target = parseManagePath(parts);
      expect(target?.scope?.kind).toBe("project");
      const found = resolveSection(ownerSections(), target!.area, target!.rest);
      expect(found, link).not.toBeNull();
      // The section's own address, not a fallback to the area's first section.
      expect(found!.section.area).toBe(target!.area);
    },
  );
});
