import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  grantsAccess,
  needsAdministratorConfirmation,
} from "@/platform/administration/organization-manager";
import { resolveSection, validateSections, visibleSections } from "../registry";
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

  it("passes an id only to users and organizations", () => {
    const all = visibleSections(systemSections, "system", [
      "system.overview",
      "system.users",
      "system.organizations",
      "system.connections",
      "system.ai",
      "system.mcp",
      "system.audit",
    ]);
    expect(all.filter((s) => s.takesId).map((s) => `${s.area}/${s.id}`)).toEqual([
      "users/users",
      "organizations/organizations",
    ]);
    expect(resolveSection(all, "users", ["u1"])).toMatchObject({
      section: { id: "users" },
      id: "u1",
    });
    expect(resolveSection(all, "organizations", ["w1"])).toMatchObject({
      section: { id: "organizations" },
      id: "w1",
    });
    expect(resolveSection(all, "security", ["anything"])).toBeNull();
    expect(resolveSection(all, "security", ["audit", "x"])).toBeNull();
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

  it("confirms only an administrator's change that grants access", () => {
    const kinds = ["organizationRole", "projectRole", "invitation", "removal"] as const;
    expect(kinds.map((kind) => needsAdministratorConfirmation(true, { kind }))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(kinds.map((kind) => needsAdministratorConfirmation(false, { kind }))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("lets each mounted administration view keep its own page head", () => {
    const own = systemSections.filter((s) => s.ownHead).map((s) => `${s.area}/${s.id}`);
    expect(own).not.toContain("ai/overview");
    expect(own).toHaveLength(systemSections.length - 1);
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
