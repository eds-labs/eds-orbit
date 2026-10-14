import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { ProjectHome } from "./home";
import { NotFound } from "./not-found";
import { OrganizationPicker, ProjectPicker } from "./pickers";
import { navOrder, projectHref, routeTable } from "./routes";
import { ShellContext, type ShellContextValue } from "./shell-context";

const table = routeTable(webRegistry);
const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [
    { id: "w1", name: "Org one", role: "owner" },
    { id: "w2", name: "Org two", role: "viewer" },
  ],
  projects: [
    project,
    { ...project, id: "p2", workspaceId: "w2", name: "Other", role: "viewer" },
  ],
};

function shell(enabled: Record<string, boolean>): ShellContextValue {
  const nav = navOrder(table.routes.filter((r) => r.nav));
  return {
    table,
    platformNav: nav.filter((r) => !r.moduleId),
    modules: webRegistry.modules.map((m) => ({
      ...m,
      enabled: enabled[m.id] ?? true,
      nav: nav.filter((r) => r.moduleId === m.id),
    })),
    // The module sections fetch data; the shell test renders a stand-in.
    homeSections: [
      { moduleId: "marketing", component: () => <p>marketing section</p> },
    ],
    hrefOf: (key) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    chat: [],
    actionRequests: {},
    settings: [],
    setupLinks: [],
    connectors: { providers: [], extras: [] },
  };
}

function home(locale: Locale, enabled: Record<string, boolean> = {}) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell(enabled)}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: true,
          isOwner: true,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        <ProjectHome />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

describe("Project home", () => {
  it("links every page of every enabled module and of the platform", () => {
    const html = home("en");
    expect(html).toContain("<h1>Synthetic project</h1>");
    for (const route of table.routes.filter((r) => r.nav && r.segments.length))
      expect(html, route.key).toContain(`href="${projectHref("p1", route)}"`);
    expect(html).toContain('data-module="knowledge"');
    expect(html).toContain('data-module="marketing"');
    expect(html).toContain("marketing section");
    expect(html).toContain('for="home-assistant-input"');
  });

  it("hides the tile of a module that is turned off", () => {
    const html = home("de", { marketing: false });
    expect(html).not.toContain("/marketing/missions");
    expect(html).toContain('href="/p/p1/knowledge"');
    expect(html).toContain("Assistent fragen");
  });
});

describe("Pickers", () => {
  const t = (k: keyof typeof labels.en) => labels.en[k];
  it("lists organizations with their project counts", () => {
    const html = renderToStaticMarkup(
      <OrganizationPicker identity={identity} t={t} />,
    );
    expect(html).toContain('href="/o/w1"');
    expect(html).toContain('href="/o/w2"');
    expect(html).toContain("Projects: 1");
  });

  it("lists the organization's projects and lets owners create one", () => {
    const create = { onSubmit: async () => {}, pending: false, error: null };
    const owner = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="w1"
        t={t}
        create={create}
      />,
    );
    expect(owner).toContain('href="/p/p1"');
    expect(owner).not.toContain('href="/p/p2"');
    expect(owner).toContain("New project");
    const viewer = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="w2"
        t={t}
        create={create}
      />,
    );
    expect(viewer).toContain('href="/p/p2"');
    expect(viewer).not.toContain("New project");
    const unknown = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="nope"
        t={t}
        create={create}
      />,
    );
    expect(unknown).toContain("Page not found");
  });

  it("says why a project cannot be opened", () => {
    const de = (k: keyof typeof labels.de) => labels.de[k];
    expect(renderToStaticMarkup(<NotFound t={de} project />)).toContain(
      "Projekt nicht verfügbar",
    );
  });
});
