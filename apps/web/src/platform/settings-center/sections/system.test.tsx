import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  grantsAccess,
  needsAdministratorConfirmation,
} from "@/platform/administration/organization-manager";
import { resolveSection, sectionPath, validateSections, visibleSections } from "../registry";
import type { Identity } from "@/lib/api";
import type { ManagementCapabilities } from "../types";
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
    expect(keys.some((k) => k.startsWith("ai/"))).toBe(false);

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
      "integrations/integrations",
      "integrations/setup",
      "integrations/connections",
      "ai/standard",
      "ai/models",
      "ai/advanced",
      "mcp/clients",
      "security/audit",
    ]);
  });

  it("opens the area on the catalog and keeps the connections reachable", () => {
    const list = visibleSections(systemSections, "system", ["system.connections"]);
    const lead = resolveSection(list, "integrations", []);
    expect(lead?.section.id).toBe("integrations");
    expect(sectionPath(lead!.section)).toEqual(["integrations"]);
    expect(resolveSection(list, "integrations", ["connections"])?.section.id).toBe("connections");
    expect(list.find((s) => s.id === "integrations")?.label.en).toBe("All integrations");
    // Without the capability there is no catalog either.
    expect(visibleSections(systemSections, "system", ["system.users"]).some((s) => s.area === "integrations")).toBe(false);
  });

  it("opens a provider's setup by address and refuses an unknown one", () => {
    const list = visibleSections(systemSections, "system", ["system.connections"]);
    expect(resolveSection(list, "integrations", ["setup", "postiz"])).toMatchObject({ section: { id: "setup" }, id: "postiz" });
    expect(resolveSection(list, "integrations", ["setup"])).toMatchObject({ section: { id: "setup" }, id: undefined });
    expect(resolveSection(list, "integrations", ["setup", "postiz", "extra"])).toBeNull();
    expect(list.find((s) => s.id === "setup")?.label).toEqual({ en: "Set up an integration", de: "Integration einrichten" });
  });

  it("passes an id only to users, organizations and the setup", () => {
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
      "integrations/setup",
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
    // Nor have the AI panels; the frame shows each section's head.
    for (const id of ["standard", "models", "advanced"]) expect(own).not.toContain(`ai/${id}`);
    // The catalog has no page head of its own; the frame shows the section's.
    expect(own).not.toContain("integrations/integrations");
    // Nor has the guided setup; its step list sits under the section head.
    expect(own).not.toContain("integrations/setup");
    expect(own).toHaveLength(systemSections.length - 5);
  });

  it("registers standard, models and advanced, and no link panel", () => {
    const list = visibleSections(systemSections, "system", ["system.ai"]);
    expect(list.map((s) => `${s.area}/${s.id}`)).toEqual(["ai/standard", "ai/models", "ai/advanced"]);
    expect(list.filter((s) => s.advanced).map((s) => s.id)).toEqual(["advanced"]);
    expect(resolveSection(list, "ai", [])?.section.id).toBe("standard");
    expect(resolveSection(list, "ai", ["overview"])).toBeNull();
    expect(list.find((s) => s.id === "models")?.label).toEqual({ en: "Models and prices", de: "Modelle und Preise" });
  });

  it("shows the catalog notice only while the catalog is off", () => {
    const models = systemSections.find((s) => s.area === "ai" && s.id === "models")!;
    const render = (aiCatalog: boolean, locale: "en" | "de" = "en") =>
      renderToStaticMarkup(
        <models.component
          scope={{ kind: "system" }}
          locale={locale}
          identity={{} as Identity}
          caps={{ flags: { connections: true, aiCatalog, aiDefaults: true, aiOrgBudget: true } } as ManagementCapabilities}
          hrefOf={() => ""}
        />,
      );
    expect(render(false)).toContain("The central price catalog is not switched on for this installation");
    expect(render(false, "de")).toContain("Der zentrale Preiskatalog ist für diese Installation nicht eingeschaltet");
    expect(render(true)).not.toContain("price catalog is not switched on");
  });
});
