import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagementCapabilities } from "./types";
import { ScopeSwitcher, scopeOptions } from "./scope-switcher";

const none: ManagementCapabilities = {
  stage: "on",
  system: [],
  account: [],
  organizations: [],
  projects: [],
};

describe("scopeOptions", () => {
  it("offers the system only to administrators and the account only while it exists", () => {
    expect(scopeOptions(none, "en")).toEqual([]);
    const admin = {
      ...none,
      system: ["system.overview" as const],
      account: ["account.profile" as const],
    };
    expect(scopeOptions(admin, "en")).toEqual([
      {
        label: null,
        options: [
          { key: "system", label: "Whole system", href: "/manage/system" },
          { key: "me", label: "My account", href: "/manage/me" },
        ],
      },
    ]);
    expect(
      scopeOptions({ ...none, account: ["account.profile"] }, "de"),
    ).toEqual([
      {
        label: null,
        options: [{ key: "me", label: "Mein Konto", href: "/manage/me" }],
      },
    ]);
  });

  it("groups projects under their organization and lists no organization the member does not own", () => {
    const caps: ManagementCapabilities = {
      ...none,
      organizations: [
        { id: "w1", name: "Acme", capabilities: ["organization.overview"] },
      ],
      projects: [
        { id: "p1", name: "Alpha", workspaceId: "w1", role: "owner", capabilities: ["project.overview"] },
        { id: "p2", name: "Beta", workspaceId: "w2", role: "viewer", capabilities: ["project.overview"] },
        { id: "p3", name: "Gamma", workspaceId: "w1", role: "editor", capabilities: ["project.overview"] },
      ],
    };
    expect(scopeOptions(caps, "en")).toEqual([
      {
        label: "Organizations",
        options: [{ key: "o:w1", label: "Acme", href: "/manage/o/w1" }],
      },
      {
        label: "Acme",
        options: [
          { key: "p:p1", label: "Alpha", href: "/manage/p/p1" },
          { key: "p:p3", label: "Gamma", href: "/manage/p/p3" },
        ],
      },
      {
        label: "Projects",
        options: [{ key: "p:p2", label: "Beta", href: "/manage/p/p2" }],
      },
    ]);
  });

  it("renders a labelled select with the current scope selected", () => {
    const caps: ManagementCapabilities = {
      ...none,
      system: ["system.overview"],
      organizations: [
        { id: "w1", name: "Acme", capabilities: ["organization.overview"] },
      ],
    };
    const html = renderToStaticMarkup(
      <ScopeSwitcher
        caps={caps}
        current={{ kind: "organization", organizationId: "w1" }}
        locale="en"
        onSelect={() => {}}
      />,
    );
    const id = /<label for="([^"]+)" class="field-label">Applies to<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<select class="input" id="${id}"`);
    expect(html).toContain('<optgroup label="Organizations">');
    expect(html).toContain('<option value="o:w1" selected="">Acme</option>');
    expect(html).toContain('<option value="system">Whole system</option>');
  });
});
