import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagementSection, SectionMeta, SectionProps } from "./types";
import {
  AREAS,
  adaptIntegrationSections,
  moduleSectionId,
  navGroups,
  resolveSection,
  sectionPath,
  searchSections,
  validateSections,
  visibleSections,
} from "./registry";

const Probe = (props: SectionProps) => <p>{props.id ?? "none"}</p>;

function make(
  scope: ManagementSection["scope"],
  area: string,
  id: string,
  extra: Partial<ManagementSection> = {},
): ManagementSection {
  return {
    id,
    scope,
    area,
    label: { en: id, de: id },
    description: { en: `about ${id}`, de: `über ${id}` },
    order: 0,
    capability:
      scope === "system" ? "system.users" : "organization.members",
    component: Probe,
    ...extra,
  };
}

const a = make("system", "users", "users");

describe("validateSections", () => {
  it("accepts a valid list", () => {
    expect(() => validateSections([a, make("system", "users", "x")])).not.toThrow();
    // The same id in another scope or area is fine.
    expect(() =>
      validateSections([a, make("organization", "members", "users")]),
    ).not.toThrow();
  });

  it("rejects duplicates, unknown areas and bad id segments", () => {
    expect(() => validateSections([a, { ...a }])).toThrow(
      /SETTINGS_SECTIONS_INVALID/,
    );
    expect(() => validateSections([{ ...a, area: "nope" }])).toThrow(
      /SETTINGS_SECTIONS_INVALID/,
    );
    expect(() => validateSections([{ ...a, id: "Bad_Id" }])).toThrow(
      /SETTINGS_SECTIONS_INVALID/,
    );
    expect(() => validateSections([{ ...a, id: "finance/1x" }])).toThrow(
      /SETTINGS_SECTIONS_INVALID/,
    );
  });

  it("lists every problem", () => {
    expect(() =>
      validateSections([{ ...a, area: "nope" }, { ...a, id: "X" }]),
    ).toThrow(/nope.*;.*X/);
  });
});

describe("areas", () => {
  it("follows the agreed order and spacing", () => {
    expect(AREAS.system.map((x) => x.id)).toEqual([
      "overview", "users", "organizations", "integrations", "ai", "mcp", "security",
    ]);
    expect(AREAS.account.map((x) => x.id)).toEqual(["profile", "connections", "assistant"]);
    expect(AREAS.project.map((x) => x.order)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });
});

describe("visibleSections", () => {
  const users = make("system", "users", "users");
  const audit = make("system", "security", "audit", { capability: "system.audit" });
  const orgMembers = make("organization", "members", "members");

  it("keeps the scope's sections the member has the capability for", () => {
    expect(
      visibleSections([users, audit, orgMembers], "system", ["system.users"]).map((s) => s.id),
    ).toEqual(["users"]);
  });

  it("sorts by area order, then section order", () => {
    const late = make("system", "security", "late", { capability: "system.users" });
    const second = make("system", "users", "second", { order: 10 });
    const first = make("system", "users", "first", { order: 0 });
    expect(
      visibleSections([late, second, first], "system", ["system.users"]).map((s) => s.id),
    ).toEqual(["first", "second", "late"]);
  });

  it("renders the component with the props", () => {
    const [s] = visibleSections([users], "system", ["system.users"]);
    const props = {
      scope: { kind: "system" },
      id: "u-1",
      locale: "en",
      identity: { user: { id: "u", name: "n", email: "e" }, projects: [], workspaces: [] },
      hrefOf: () => "/manage",
    } as SectionProps;
    expect(renderToStaticMarkup(s.render(props))).toBe("<p>u-1</p>");
    expect("component" in s).toBe(false);
  });
});

describe("resolveSection", () => {
  it("opens the section named like its area at the area's address", () => {
    const s = [
      { area: "users", id: "invitations", order: 0 },
      { area: "users", id: "users", order: 10, takesId: true as const },
    ];
    expect(resolveSection(s, "users", [])).toMatchObject({ section: { id: "users" } });
    // The long address still works, and the entity id below it.
    expect(resolveSection(s, "users", ["users"])).toMatchObject({ section: { id: "users" } });
    expect(resolveSection(s, "users", ["users", "u1"])).toMatchObject({
      section: { id: "users" },
      id: "u1",
    });
    expect(resolveSection(s, "users", ["invitations"])).toMatchObject({
      section: { id: "invitations" },
    });
  });

  const s = [
    make("system", "users", "users", { order: 0, takesId: true }),
    make("system", "users", "invitations", { order: 10 }),
    make("system", "security", "audit"),
  ];
  const m = [
    make("project", "modules", "switches", { order: 0 }),
    make("project", "modules", "finance/accounts", { order: 20, takesId: true }),
    make("project", "modules", "finance/mailboxes", { order: 10 }),
  ];

  it("opens the first area with no area", () => {
    expect(resolveSection(s, null, [])).toMatchObject({ section: { id: "users" } });
    expect(resolveSection([], null, [])).toBeNull();
  });

  it("selects by exact id, then falls back to the first section", () => {
    expect(resolveSection(s, "users", [])).toMatchObject({
      section: { id: "users" },
      id: undefined,
    });
    expect(resolveSection(s, "users", ["invitations"])).toMatchObject({
      section: { id: "invitations" },
    });
    expect(resolveSection(s, "users", ["u-123"])).toMatchObject({
      section: { id: "users" },
      id: "u-123",
    });
  });

  it("passes a single unknown segment only to the area's lead section if it takes an id", () => {
    // No section named like the area: "invitations" leads and reads no id,
    // so the address names nothing.
    const noId = [
      make("system", "users", "invitations", { order: 0 }),
      make("system", "users", "list", { order: 10, takesId: true }),
    ];
    expect(resolveSection(noId, "users", ["u-123"])).toBeNull();
    // A section named like its area leads it whatever its order (its
    // address is the area's own), so the segment is its entity id.
    const named = [
      make("system", "users", "invitations", { order: 0 }),
      make("system", "users", "users", { order: 10, takesId: true }),
    ];
    expect(resolveSection(named, "users", ["u-123"])).toMatchObject({
      section: { id: "users" },
      id: "u-123",
    });
    expect(resolveSection(m, "modules", ["unknown"])).toBeNull();
  });

  it("passes the segment after a matched section only when it takes an id", () => {
    expect(resolveSection(s, "users", ["users", "u-1"])).toMatchObject({
      section: { id: "users" },
      id: "u-1",
    });
    expect(resolveSection(s, "users", ["invitations", "x"])).toBeNull();
    expect(resolveSection(s, "security", ["audit", "x"])).toBeNull();
    expect(resolveSection(m, "modules", ["finance", "mailboxes", "x"])).toBeNull();
  });

  it("carries the flag through visibleSections", () => {
    const [users, invitations] = visibleSections(s, "system", ["system.users"]);
    expect(users.takesId).toBe(true);
    expect(invitations.takesId).toBeUndefined();
  });

  it("returns null for a deeper unknown path or an unknown area", () => {
    expect(resolveSection(s, "users", ["u-123", "x"])).toBeNull();
    expect(resolveSection(s, "audit", [])).toBeNull();
  });

  it("handles ids with a slash", () => {
    expect(resolveSection(m, "modules", ["finance", "accounts"])).toMatchObject({
      section: { id: "finance/accounts" },
    });
    expect(resolveSection(m, "modules", [])).toMatchObject({
      section: { id: "switches" },
    });
    expect(resolveSection(m, "modules", ["finance"])).toMatchObject({
      section: { id: "finance/mailboxes" },
      id: undefined,
    });
    expect(
      resolveSection(m, "modules", ["finance", "accounts", "acc-1"]),
    ).toMatchObject({ section: { id: "finance/accounts" }, id: "acc-1" });
  });
});

describe("sectionPath", () => {
  it("splits the id after the area", () => {
    expect(sectionPath({ area: "modules", id: "finance/accounts" })).toEqual([
      "modules", "finance", "accounts",
    ]);
    expect(sectionPath({ area: "users", id: "invitations" })).toEqual([
      "users", "invitations",
    ]);
  });

  it("gives a section named like its area the area's own address", () => {
    expect(sectionPath({ area: "users", id: "users" })).toEqual(["users"]);
    expect(sectionPath({ area: "members", id: "members" })).toEqual(["members"]);
  });
});

describe("navGroups", () => {
  const moduleName = (id: string) =>
    id === "finance"
      ? { en: "Finance", de: "Finanzen" }
      : id === "marketing"
        ? { en: "Marketing", de: "Marketing" }
        : undefined;
  const meta = (id: string, area: string, moduleId?: string): SectionMeta => ({
    ...make("project", area, id),
    moduleId,
  });

  it("groups project sections and gives each module its own group", () => {
    const groups = navGroups(
      [
        meta("overview", "overview"),
        meta("switches", "modules"),
        meta("finance/accounts", "modules", "finance"),
        meta("finance/currencies", "modules", "finance"),
        meta("marketing/policy", "modules", "marketing"),
        meta("keys", "integrations"),
      ],
      "project",
      moduleName,
    );
    expect(groups.map((g) => g.id)).toEqual([
      "overview", "modules", "finance", "marketing", "integrations",
    ]);
    expect(groups[2].label).toEqual({ en: "Finance", de: "Finanzen" });
    expect(groups[2].sections.map((x) => x.id)).toEqual([
      "finance/accounts", "finance/currencies",
    ]);
    expect(groups[1].sections.map((x) => x.id)).toEqual(["switches"]);
  });

  it("leaves out empty groups", () => {
    expect(navGroups([], "account", moduleName)).toEqual([]);
  });
});

describe("searchSections", () => {
  const all: SectionMeta[] = [
    { ...make("organization", "members", "members"), label: { en: "Members", de: "Mitglieder" } },
    {
      ...make("project", "modules", "finance/accounts"),
      keywords: { en: "invoice bank", de: "Rechnung" },
    },
  ];

  it("returns nothing for an empty query", () => {
    expect(searchSections(all, "  ")).toEqual([]);
    expect(searchSections(all, "")).toEqual([]);
  });

  it("matches labels in both languages, descriptions and keywords", () => {
    expect(searchSections(all, "MITGLIED").map((x) => x.id)).toContain("members");
    expect(searchSections(all, "invoice").map((x) => x.id)).toContain("finance/accounts");
    expect(searchSections(all, "rechnung").map((x) => x.id)).toEqual(["finance/accounts"]);
    expect(searchSections(all, "über members").map((x) => x.id)).toEqual(["members"]);
    expect(searchSections(all, "zzz")).toEqual([]);
  });
});

describe("moduleSectionId", () => {
  it("derives section ids of module tabs", () => {
    expect(moduleSectionId("work", "work", [])).toBe("work/settings");
    expect(moduleSectionId("finance", "finance-accounts", [])).toBe("finance/accounts");
    expect(moduleSectionId("marketing", "policy", [])).toBe("marketing/policy");
    expect(moduleSectionId("webmail", "integrations", ["integrations"])).toBe("webmail/settings");
  });
});

describe("adaptIntegrationSections", () => {
  const Marker = () => <i>marker</i>;
  const label = { en: "Social accounts", de: "Social-Media-Konten" };
  const description = { en: "about", de: "über" };

  it("adapts module integration sections under Integrations", () => {
    const [s] = adaptIntegrationSections([
      { moduleId: "social", id: "accounts", label, description, order: 0, component: Marker },
    ]);
    expect(s).toMatchObject({ id: "social/accounts", area: "integrations", scope: "project", order: 100 });
    // Without moduleId: navGroups would move it into the module groups.
    expect(s.moduleId).toBeUndefined();
    expect(navGroups([s], "project", () => undefined).map((g) => g.id)).toEqual(["integrations"]);
    expect(resolveSection([s], "integrations", ["social", "accounts"])).toMatchObject({
      section: { id: "social/accounts" },
    });
    expect(resolveSection([s], "integrations", ["social", "nope"])).toBeNull();
    expect(sectionPath(s)).toEqual(["integrations", "social", "accounts"]);
  });

  it("passes ownHead through, orders after the platform's sections and renders the component", () => {
    const sections = adaptIntegrationSections([
      { moduleId: "social", id: "accounts", label, description, order: 5, ownHead: true, component: Marker },
      { moduleId: "beta", id: "x", label, description, order: 0, component: Marker },
    ]);
    expect(sections.map((s) => [s.id, s.order, s.ownHead])).toEqual([
      ["social/accounts", 105, true],
      ["beta/x", 100, undefined],
    ]);
    const props = { scope: { kind: "project", projectId: "p1" }, locale: "en", identity: {}, hrefOf: () => "" } as unknown as SectionProps;
    expect(renderToStaticMarkup(<>{sections[0].render(props)}</>)).toBe("<i>marker</i>");
    expect(adaptIntegrationSections([])).toEqual([]);
  });
});
