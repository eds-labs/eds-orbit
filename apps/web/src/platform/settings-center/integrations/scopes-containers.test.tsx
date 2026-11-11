import { describe, expect, it, vi } from "vitest";

// Every answer a container reads, by its exact path; a path without an entry
// fails, so a test sees the error state instead of a guessed catalog.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const found = path === null ? undefined : answers[path];
      return {
        data: found ?? null,
        error: found === undefined && path ? new Error(`failed ${path}`) : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { manageHref } from "../routes";
import type { Capability, ManagementCapabilities, ManageScope } from "../types";
import { OrganizationCatalog, ProjectCatalog, SystemCatalog } from "./scopes";
import { integrationText, stateLabel } from "./texts";
import type { CatalogEntry, EnvironmentStatus } from "./types";

const entry = (extra: Partial<CatalogEntry> & Pick<CatalogEntry, "id">): CatalogEntry => ({
  label: { en: extra.id, de: extra.id },
  category: "other",
  authType: "api_key",
  scopes: [],
  checkable: true,
  storage: [],
  available: true,
  owner: "platform",
  ...extra,
});
const items = [
  entry({ id: "openai", label: { en: "OpenAI", de: "OpenAI" }, category: "ai", scopes: ["system", "workspace"], storage: ["central"] }),
  entry({ id: "social.account.x", label: { en: "X account", de: "X-Konto" }, category: "social", authType: "oauth_account", scopes: ["project"], storage: ["project"], owner: "social" }),
  entry({ id: "system_mail", label: { en: "System e-mail", de: "System-E-Mail" }, category: "email", authType: "environment", storage: ["environment"] }),
];
const environment: EnvironmentStatus = {
  redis: { configured: false, reachable: false },
  files: { configured: false },
  googleDriveApp: { configured: false },
  aiFallbackKeys: { openai: false, anthropic: false },
  credentialKeys: { ring: false },
  mcp: { oauth: false, gateway: false, dcr: false, tasks: false, proposals: false, projectConfiguration: false, projectAdministration: false },
  connectionsCutover: [],
};
const t = integrationText("en");
const props = (scope: ManageScope, caps?: ManagementCapabilities) => ({
  scope,
  locale: "en" as const,
  identity: {} as Identity,
  caps,
  hrefOf: (area: string, ...rest: string[]) => manageHref(scope, area, ...rest),
});
const reset = (next: Record<string, unknown>) => {
  for (const key of Object.keys(answers)) delete answers[key];
  Object.assign(answers, next);
};

describe("SystemCatalog", () => {
  it("shows the environment panel and the connections on their cards", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/admin/connections": {
        items: [
          { id: "c1", provider: "openai", label: "OpenAI main", state: "verified", checkedAt: null },
          { id: "c2", provider: "openai", label: "OpenAI backup", state: "stored", checkedAt: null },
        ],
      },
      "/admin/overview": { system: { environment } },
    });
    const html = renderToStaticMarkup(<SystemCatalog {...props({ kind: "system" })} />);
    expect(html).toContain(`<h2>${t("environmentTitle")}</h2>`);
    expect(html.indexOf(t("environmentTitle"))).toBeLessThan(html.indexOf("integration-card"));
    expect(html).toContain("OpenAI main");
    expect(html).toContain("OpenAI backup");
    expect(html).toContain(stateLabel("stored", "en"));
    expect(html).toContain('href="/manage/system/integrations/connections"');
    expect(html).toContain("System e-mail");
  });

  it("offers the guided setup only for what the scope can set up", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/admin/connections": { items: [] },
      "/admin/overview": { system: { environment } },
    });
    const admin = { stage: "preview", system: ["system.connections"], account: [], organizations: [], projects: [] } as ManagementCapabilities;
    const html = renderToStaticMarkup(<SystemCatalog {...props({ kind: "system" }, admin)} />);
    const card = (id: string) => html.slice(html.indexOf(`data-provider="${id}"`)).split("</article>")[0]!;
    expect(card("openai")).toContain('href="/manage/system/integrations/setup/openai"');
    expect(card("openai")).toContain(t("setUp"));
    // Set on the server: nothing to set up here.
    expect(card("system_mail")).not.toContain(t("setUp"));
  });

  it("shows the error with a retry when one request fails", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/admin/overview": { system: { environment } },
    });
    const html = renderToStaticMarkup(<SystemCatalog {...props({ kind: "system" })} />);
    expect(html).toContain("failed /admin/connections");
    expect(html).toContain("Try again");
    expect(html).not.toContain("integration-card");
  });
});

describe("OrganizationCatalog", () => {
  it("names the projects using a connection and lists the projects' integrations", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/management/organizations/w1/integrations": {
        connections: [
          {
            id: "c1", provider: "openai", label: "OpenAI", category: "ai", scope: "system", state: "verified", checkedAt: null,
            projects: [{ id: "p1", name: "Alpha", bound: true }, { id: "p2", name: "Beta", bound: false }],
          },
        ],
        projects: [{ id: "p1", name: "Alpha", integrations: [] }],
      },
    });
    const html = renderToStaticMarkup(
      <OrganizationCatalog {...props({ kind: "organization", organizationId: "w1" })} />,
    );
    expect(html).toContain(`${t("usedBy")}: Alpha (${t("bound")}), Beta (${t("grantedNotBound")})`);
    expect(html).toContain(`<h2>${t("projectsTitle")}</h2>`);
    expect(html).toContain("<caption>Alpha</caption>");
    expect(html).toContain('href="/manage/o/w1/integrations/connections"');
    // Installation items never show in an organization.
    expect(html).not.toContain("System e-mail");
  });
});

describe("ProjectCatalog", () => {
  it("links the Social account cards to the module's section while Social is shown", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/management/projects/p1/integrations": {
        items: [
          { id: "a1", provider: "social.account.x", label: "@orbit", category: "social", scope: "project", state: "ready", checkedAt: null, group: null },
        ],
      },
    });
    const shell = {
      integrations: [
        { moduleId: "social", id: "accounts", label: { en: "S", de: "S" }, description: { en: "S", de: "S" }, order: 0, providers: ["social.account.x"], component: () => null },
      ],
    } as unknown as ShellContextValue;
    const scope: ManageScope = { kind: "project", projectId: "p1" };
    const shown = renderToStaticMarkup(
      <ShellContext.Provider value={shell}>
        <ProjectCatalog {...props(scope)} />
      </ShellContext.Provider>,
    );
    expect(shown).toContain("@orbit");
    expect(shown).toContain('href="/manage/p/p1/integrations/social/accounts"');
    const hidden = renderToStaticMarkup(<ProjectCatalog {...props(scope)} />);
    expect(hidden).not.toContain("social/accounts");
    // Nothing on this page manages the accounts then.
    expect(hidden).not.toContain('href="/manage/p/p1/integrations/connections"');
    expect(hidden).toContain(integrationText("en")("managedInModule"));
  });

  it("shows a viewer the states without a set up link, and an owner the link", () => {
    reset({
      "/management/integrations/catalog": { items },
      "/management/projects/p1/integrations": {
        items: [
          { id: "a1", provider: "social.account.x", label: "@orbit", category: "social", scope: "project", state: "ready", checkedAt: null, group: null },
        ],
      },
    });
    const scope: ManageScope = { kind: "project", projectId: "p1" };
    const viewerCaps = ["project.overview", "project.profile", "project.modules", "project.integrations"] as Capability[];
    const asRole = (role: "owner" | "viewer"): ManagementCapabilities => ({
      stage: "preview", system: [], account: [], organizations: [],
      projects: [{ id: "p1", name: "P", workspaceId: "w1", role, capabilities: role === "owner" ? [...viewerCaps, "project.members"] : viewerCaps }],
    });
    const viewer = renderToStaticMarkup(<ProjectCatalog {...props(scope, asRole("viewer"))} />);
    expect(viewer).not.toContain(t("setUp"));
    expect(viewer).not.toContain("/integrations/setup/");
    expect(viewer).toContain("@orbit");
    expect(viewer).toContain(stateLabel("ready", "en"));
    const owner = renderToStaticMarkup(<ProjectCatalog {...props(scope, asRole("owner"))} />);
    expect(owner).toContain('href="/manage/p/p1/integrations/setup/social.account.x"');
  });

  it("links a module's connector provider to connections only while the module contributes it", () => {
    reset({
      "/management/integrations/catalog": {
        items: [entry({ id: "postiz", label: { en: "Postiz", de: "Postiz" }, category: "social", scopes: ["project", "workspace", "system"], storage: ["central", "project"], owner: "marketing" })],
      },
      "/management/projects/p1/integrations": { items: [] },
    });
    const scope: ManageScope = { kind: "project", projectId: "p1" };
    const shell = { connectors: { providers: [{ id: "postiz" }], extras: [] } } as unknown as ShellContextValue;
    const shown = renderToStaticMarkup(
      <ShellContext.Provider value={shell}>
        <ProjectCatalog {...props(scope)} />
      </ShellContext.Provider>,
    );
    expect(shown).toContain('href="/manage/p/p1/integrations/connections"');
    const hidden = renderToStaticMarkup(<ProjectCatalog {...props(scope)} />);
    expect(hidden).not.toContain('href="/manage/p/p1/integrations/connections"');
  });
});
