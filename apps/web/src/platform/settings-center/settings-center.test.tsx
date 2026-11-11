import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import type {
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
  ManagementSection,
  SectionProps,
} from "./types";
import { visibleSections } from "./registry";
import { SettingsCenterView } from "./settings-center";

const Probe = (props: SectionProps) => (
  <p>
    marker-{props.id ?? "none"}-{props.hrefOf("users", "u1")}
  </p>
);

const section = (
  area: string,
  id: string,
  extra: Partial<ManagementSection> = {},
): ManagementSection => ({
  id,
  scope: "system",
  area,
  label: { en: `Label ${id}`, de: `Titel ${id}` },
  description: { en: `About ${id}`, de: `Über ${id}` },
  order: 0,
  capability: "system.users",
  component: Probe,
  ...extra,
});

const all = [
  section("overview", "status", { capability: "system.overview" }),
  section("users", "users"),
  section("users", "invitations", { order: 10 }),
  section("mcp", "mcp", { capability: "system.mcp", advanced: true }),
];
const caps: ManagementCapabilities = {
  stage: "on",
  system: ["system.overview", "system.users", "system.mcp"],
  account: [],
  organizations: [],
  projects: [],
};
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  projects: [],
  workspaces: [],
  systemAdmin: true,
};
const scope: ManageScope = { kind: "system" };

function render(target: Partial<ManageTarget>, capabilities = caps.system) {
  return renderToStaticMarkup(
    <SettingsCenterView
      scope={scope}
      scopeName="Whole system"
      sections={visibleSections(all, "system", capabilities)}
      target={{ scope, area: null, rest: [], ...target }}
      caps={caps}
      identity={identity}
      locale="en"
      moduleName={() => undefined}
      navigate={() => {}}
      backHref="/"
      backLabel="Back to Orbit"
    />,
  );
}

describe("SettingsCenterView", () => {
  it("marks the open section and renders its content", () => {
    const html = render({ area: "users", rest: ["users", "x1"] });
    expect(html).toContain(
      '<a class="settings-nav-link" href="/manage/system/users/users" aria-current="page">Label users</a>',
    );
    expect(html).not.toContain(
      'href="/manage/system/users/invitations" aria-current',
    );
    expect(html).toContain("marker-x1-/manage/system/users/u1");
    expect(html).toContain("<h2>Label users</h2>");
    expect(html).toContain('<p class="page-eyebrow">Administration &amp; settings</p>');
    expect(html).toContain("<h1>Whole system</h1>");
    expect(html).toContain('<a class="back-link" href="/">← Back to Orbit</a>');
    expect(html).toMatch(/<label for="manage-search" class="field-label">Search settings<\/label>/);
    expect(html).toContain('type="search"');
  });

  it("shows the overview for a scope without an area", () => {
    const html = render({});
    expect(html.match(/class="panel manage-card"/g)).toHaveLength(3);
    expect(html).toContain("Choose an area. Each one says what it is for.");
    expect(html).toContain('href="/manage/system/users/invitations"');
    expect(html).not.toContain("marker-");
    expect(html).not.toContain('aria-current="page"');
  });

  it("shows the not-available notice for a hidden or unknown section", () => {
    const hidden = render({ area: "ai" });
    expect(hidden).toContain("Not available");
    expect(hidden).toContain(
      "This page does not exist or your role does not include it.",
    );
    expect(hidden).not.toContain("marker-");
    // Without the capability the MCP section is hidden, not shown.
    const withoutMcp = render({ area: "mcp" }, ["system.overview", "system.users"]);
    expect(withoutMcp).toContain("Not available");
    expect(withoutMcp).not.toContain("marker-");
  });

  it("wraps an advanced section in a disclosure", () => {
    const html = render({ area: "mcp" });
    expect(html).toMatch(/<details><summary>Advanced<\/summary><p>marker-none/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(render({ area: "users" })).not.toContain("<details");
  });
});
