import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { validateSections, visibleSections } from "../registry";
import { AiLinkPanel } from "./ai-link";
import { organizationIdOf, organizationSections } from "./organization";

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
    expect(ai.map((s) => s.component.name)).toEqual([
      "UsageSection",
      "AiSection",
    ]);
    expect(ai.map((s) => s.id)).toEqual(["usage", "overview"]);
  });

  it("links the AI panel to the organization's settings page with an encoded id", () => {
    const html = renderToStaticMarkup(
      <AiLinkPanel href="/o/a%2Fb/settings" locale="en" />,
    );
    expect(html).toContain('href="/o/a%2Fb/settings"');
  });

  it("reads the organization from the scope", () => {
    expect(organizationIdOf({ kind: "organization", organizationId: "w1" })).toBe(
      "w1",
    );
    expect(() => organizationIdOf({ kind: "account" })).toThrow();
  });
});
