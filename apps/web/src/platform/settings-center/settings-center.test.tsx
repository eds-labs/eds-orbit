import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import type {
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
  ManagementSection,
  SectionProps,
} from "./types";
import { PageHead } from "@/platform/ui/collection";
import { visibleSections } from "./registry";
import { activeQuery, addressKey, SettingsCenterView } from "./settings-center";

const Probe = (props: SectionProps) => (
  <p>
    marker-{props.id ?? "none"}-{props.hrefOf("users", "u1")}
  </p>
);

// A component that brings its own page head, like the administration views.
const OwnHead = () => <PageHead title="Own heading" description="Own text" />;

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
  section("users", "users", { takesId: true }),
  section("users", "invitations", { order: 10 }),
  section("mcp", "mcp", { capability: "system.mcp", advanced: true }),
  section("security", "audit", { component: OwnHead, ownHead: true }),
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

function render(
  target: Partial<ManageTarget>,
  capabilities = caps.system,
  notices?: ReactNode,
) {
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
      notices={notices}
    />,
  );
}

describe("SettingsCenterView", () => {
  it("marks the open section and renders its content", () => {
    const html = render({ area: "users", rest: ["users", "x1"] });
    expect(html).toContain(
      '<a class="settings-nav-link" href="/manage/system/users" aria-current="page">Label users</a>',
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
    expect(html).not.toContain("Choose a section");
  });

  it("links a section named like its area by the short address and marks it there", () => {
    for (const target of [
      { area: "users", rest: [] },
      { area: "users", rest: ["users"] },
      { area: "users", rest: ["x1"] },
    ]) {
      const html = render(target);
      expect(html).toContain(
        '<a class="settings-nav-link" href="/manage/system/users" aria-current="page">Label users</a>',
      );
      expect(html).not.toContain("/manage/system/users/users");
    }
    const invitations = render({ area: "users", rest: ["invitations"] });
    expect(invitations).toContain(
      '<a class="settings-nav-link" href="/manage/system/users/invitations" aria-current="page">Label invitations</a>',
    );
    expect(invitations).toContain('<option value="users">Label users</option>');
  });

  it("shows the overview for a scope without an area", () => {
    const html = render({});
    expect(html.match(/class="panel manage-card"/g)).toHaveLength(4);
    expect(html).toContain("Choose an area. Each one says what it is for.");
    expect(html).toContain('href="/manage/system/users/invitations"');
    expect(html).not.toContain("marker-");
    expect(html).not.toContain('aria-current="page"');
    // The phone select names no section as open.
    expect(html).toContain(
      '<option value="" disabled="" selected="">Choose a section</option>',
    );
  });

  it("shows the not-available notice for a hidden or unknown section", () => {
    const hidden = render({ area: "ai" });
    expect(hidden).toContain("Not available");
    expect(hidden).toContain(
      "This page does not exist or your role does not include it.",
    );
    expect(hidden).not.toContain("marker-");
    expect(hidden).toContain(
      '<option value="" disabled="" selected="">Choose a section</option>',
    );
    // Without the capability the MCP section is hidden, not shown.
    const withoutMcp = render({ area: "mcp" }, ["system.overview", "system.users"]);
    expect(withoutMcp).toContain("Not available");
    expect(withoutMcp).not.toContain("marker-");
  });

  it("leaves the head to a section that renders its own", () => {
    const html = render({ area: "security" });
    expect(html).toContain("<h2>Own heading</h2>");
    expect(html).not.toContain("<h1>Own heading</h1>");
    // The label stays in the navigation only; the frame adds no head for it.
    expect(html).not.toContain("<h2>Label audit</h2>");
    expect(html).not.toContain("About audit");
    expect(html).toContain(">Label audit</a>");
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });

  it("gives a section without its own head the frame's head", () => {
    const html = render({ area: "users" });
    expect(html).toContain("<h2>Label users</h2>");
    expect(html).toContain("<p>About users</p>");
  });

  it("wraps an advanced section in a disclosure", () => {
    const html = render({ area: "mcp" });
    expect(html).toMatch(/<details><summary>Advanced<\/summary><p>marker-none/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(render({ area: "users" })).not.toContain("<details");
  });

  it("shows notices at the top of the content, on a section and on the overview", () => {
    const notice = <p className="probe-notice">notice-marker</p>;
    const content = (html: string) =>
      html.slice(html.indexOf('class="settings-content"'));
    const onSection = content(render({ area: "users" }, caps.system, notice));
    expect(onSection.indexOf("notice-marker")).toBeGreaterThan(-1);
    expect(onSection.indexOf("notice-marker")).toBeLessThan(
      onSection.indexOf("<h2>Label users</h2>"),
    );
    const onOverview = content(render({}, caps.system, notice));
    expect(onOverview.indexOf("notice-marker")).toBeGreaterThan(-1);
    expect(onOverview.indexOf("notice-marker")).toBeLessThan(
      onOverview.indexOf("manage-hint"),
    );
    expect(render({ area: "users" })).not.toContain("notice-marker");
  });
});

describe("activeQuery", () => {
  const at = addressKey({ scope, area: "users", rest: ["users"] });

  it("keeps the query on the address it was typed on", () => {
    expect(activeQuery({ query: "mail", at }, at)).toBe("mail");
  });

  it("ends the search once the address changes", () => {
    const search = { query: "mail", at };
    expect(
      activeQuery(search, addressKey({ scope, area: "users", rest: ["invitations"] })),
    ).toBe("");
    expect(
      activeQuery(
        search,
        addressKey({ scope: { kind: "account" }, area: "users", rest: ["users"] }),
      ),
    ).toBe("");
    expect(activeQuery(search, addressKey({ scope, area: null, rest: [] }))).toBe("");
  });

  it("treats a blank query as no search", () => {
    expect(activeQuery({ query: "   ", at }, at)).toBe("");
  });
});
