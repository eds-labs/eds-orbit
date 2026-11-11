import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { grantsAccess } from "@/platform/administration/organization-manager";
import { validateSections, visibleSections } from "../registry";
import { AiLinkPanel } from "./ai-link";
import { adminLinkInCenter, systemSections } from "./system";

describe("system scope", () => {
  it("registers valid sections", () => {
    expect(() => validateSections(systemSections)).not.toThrow();
    expect(systemSections.every((s) => s.scope === "system")).toBe(true);
  });

  it("shows the connection and AI sections only with their capability", () => {
    const visible = visibleSections(systemSections, "system", [
      "system.overview",
      "system.users",
    ]);
    const keys = visible.map((s) => `${s.area}/${s.id}`);
    expect(keys).toEqual(["overview/status", "users/users", "users/invitations"]);
    expect(keys).not.toContain("integrations/connections");
    expect(keys).not.toContain("ai/overview");

    const all = visibleSections(systemSections, "system", [
      "system.overview",
      "system.users",
      "system.organizations",
      "system.connections",
      "system.ai",
      "system.mcp",
      "system.audit",
    ]).map((s) => `${s.area}/${s.id}`);
    expect(all).toEqual([
      "overview/status",
      "users/users",
      "users/invitations",
      "organizations/organizations",
      "organizations/projects",
      "integrations/connections",
      "ai/overview",
      "mcp/clients",
      "security/audit",
    ]);
  });

  it("links users and organizations inside the center", () => {
    expect(adminLinkInCenter("users", "u1")).toBe("/manage/system/users/u1");
    expect(adminLinkInCenter("organizations", "w1")).toBe(
      "/manage/system/organizations/w1",
    );
    expect(adminLinkInCenter("users")).toBe("/manage/system/users");
    // Sections the center does not address keep their working old page.
    expect(adminLinkInCenter("audit")).toBe("/admin/audit");
  });

  it("asks before a change that grants access, not before a removal", () => {
    expect(grantsAccess({ kind: "organizationRole" })).toBe(true);
    expect(grantsAccess({ kind: "projectRole" })).toBe(true);
    expect(grantsAccess({ kind: "invitation" })).toBe(true);
    expect(grantsAccess({ kind: "removal" })).toBe(false);
  });

  it("points AI settings to the current page, in both languages", () => {
    const en = renderToStaticMarkup(<AiLinkPanel href="/admin/ai" locale="en" />);
    expect(en).toContain("AI standards, models and prices are still edited");
    expect(en).toContain('href="/admin/ai"');
    expect(en).toContain("Open AI settings");
    const de = renderToStaticMarkup(<AiLinkPanel href="/admin/ai" locale="de" />);
    expect(de).toContain("KI-Einstellungen öffnen");
  });
});
