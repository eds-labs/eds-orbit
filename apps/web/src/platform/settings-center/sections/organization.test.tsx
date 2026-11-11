import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import { resolveSection, sectionPath, validateSections, visibleSections } from "../registry";
import { AiLinkPanel } from "./ai-link";
import {
  organizationIdOf,
  organizationPaths,
  organizationSections,
  SummaryPanel,
} from "./organization";
import { accountSections } from "./account";

const keys = (caps: Parameters<typeof visibleSections>[2]) =>
  visibleSections(organizationSections, "organization", caps).map(
    (s) => `${s.area}/${s.id}`,
  );

describe("organization scope", () => {
  it("registers valid sections", () => {
    expect(() => validateSections(organizationSections)).not.toThrow();
    expect(organizationSections.every((s) => s.scope === "organization")).toBe(
      true,
    );
  });

  it("shows integrations and AI only with their capabilities", () => {
    const base = keys(["organization.overview", "organization.members"]);
    expect(base).toEqual(["overview/summary", "members/members"]);
    expect(keys(["organization.connections"])).toEqual([
      "integrations/integrations",
      "integrations/setup",
      "integrations/connections",
    ]);
    expect(keys(["organization.ai"])).toEqual(["ai/usage", "ai/overview"]);
  });

  it("shows knowledge only with organization.knowledge and apps only with organization.apps", () => {
    expect(keys(["organization.knowledge"])).toEqual(["knowledge/shares"]);
    expect(keys(["organization.apps"])).toEqual(["policies/apps"]);
    expect(keys([])).toEqual([]);
  });

  it("offers no AI form", () => {
    const ai = organizationSections.filter((s) => s.area === "ai");
    expect(ai.map((s) => s.id)).toEqual(["usage", "overview"]);
    const forbidden = ["standard", "budget", "models", "advanced", "profile", "defaults"];
    for (const s of [...organizationSections, ...accountSections])
      expect(forbidden).not.toContain(s.id);
    // The pointer panel is the only AI content besides the read-only usage.
    const html = renderToStaticMarkup(
      <AiLinkPanel href={organizationPaths("x").aiSettings} locale="en" />,
    );
    expect(html).not.toContain("<form");
  });

  it("links the AI panel to the organization's settings page with an encoded id", () => {
    const ai = organizationSections.find(
      (s) => s.area === "ai" && s.id === "overview",
    )!;
    const html = renderToStaticMarkup(
      <ai.component
        scope={{ kind: "organization", organizationId: "a/b" }}
        locale="en"
        identity={{} as Identity}
        hrefOf={() => ""}
      />,
    );
    expect(html).toContain(`href="${organizationPaths("a/b").aiSettings}"`);
    expect(html).toContain('href="/o/a%2Fb/settings"');
  });

  it("opens the area on the catalog and keeps the connections reachable", () => {
    const list = visibleSections(organizationSections, "organization", ["organization.connections"]);
    const lead = resolveSection(list, "integrations", []);
    expect(lead?.section.id).toBe("integrations");
    expect(sectionPath(lead!.section)).toEqual(["integrations"]);
    expect(resolveSection(list, "integrations", ["connections"])?.section.id).toBe("connections");
  });

  it("opens a provider's setup by address and refuses an unknown one", () => {
    const list = visibleSections(organizationSections, "organization", ["organization.connections"]);
    expect(resolveSection(list, "integrations", ["setup", "postiz"])).toMatchObject({ section: { id: "setup" }, id: "postiz" });
    expect(resolveSection(list, "integrations", ["setup"])).toMatchObject({ section: { id: "setup" }, id: undefined });
    expect(resolveSection(list, "integrations", ["setup", "postiz", "extra"])).toBeNull();
    expect(list.find((s) => s.id === "setup")?.label).toEqual({ en: "Set up an integration", de: "Integration einrichten" });
  });

  it("reads the organization from the scope", () => {
    expect(organizationIdOf({ kind: "organization", organizationId: "w1" })).toBe(
      "w1",
    );
    expect(() => organizationIdOf({ kind: "account" })).toThrow();
  });
});

describe("organization paths", () => {
  it("encode the scope's id in every request path and link", () => {
    const paths = organizationPaths("w 1/x");
    const values = Object.values(paths);
    expect(values.length).toBeGreaterThanOrEqual(6);
    for (const v of values) {
      expect(v).toContain("w%201%2Fx");
      expect(v).not.toContain("w 1/x");
    }
    expect(paths.grants).toBe("/workspaces/w%201%2Fx/mcp-grants");
    expect(paths.agents).toBe("/o/w%201%2Fx/agents");
    expect(paths.aiSettings).toBe("/o/w%201%2Fx/settings");
  });
});

describe("organization summary", () => {
  it("shows name, counts and the two links", () => {
    const html = renderToStaticMarkup(
      <SummaryPanel
        name="Synthetic org"
        members={3}
        projects={2}
        membersHref="/manage/o/w1/members"
        agentsHref="/o/w%201/agents"
        locale="en"
      />,
    );
    expect(html).toContain("Synthetic org");
    expect(html).toContain("Members: 3");
    expect(html).toContain("Projects: 2");
    expect(html).toContain('href="/manage/o/w1/members"');
    expect(html).toContain('href="/o/w%201/agents"');
  });
});
