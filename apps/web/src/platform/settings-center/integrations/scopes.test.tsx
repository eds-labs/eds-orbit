import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Identity } from "@/lib/api";
import { at } from "@/platform/administration/texts";
import { manageHref } from "../routes";
import type { Capability, ManagementCapabilities, ManageScope } from "../types";
import {
  CATALOG_SECTION,
  EnvironmentPanel,
  environmentRows,
  gate,
  manageHrefOf,
  organizationRecords,
  OrganizationCatalog,
  OrganizationProjects,
  projectRecords,
  ProjectCatalog,
  scopeCatalog,
  setupHrefOf,
  systemRecords,
  SystemCatalog,
  type AdminConnection,
} from "./scopes";
import { integrationText, stateLabel } from "./texts";
import type {
  CatalogEntry,
  EnvironmentStatus,
  OrganizationIntegrations,
  ProjectIntegration,
} from "./types";

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

// Catalog entries as the API emits them (ids and shapes of integration-catalog.ts).
const catalog: CatalogEntry[] = [
  entry({ id: "email", label: { en: "Mailbox", de: "Postfach" }, category: "email", authType: "password", scopes: ["project", "workspace"], storage: ["central", "project"] }),
  entry({ id: "system_mail", category: "email", authType: "environment", storage: ["environment"] }),
  entry({ id: "postiz", label: { en: "Postiz", de: "Postiz" }, category: "social", scopes: ["project", "workspace", "system"], storage: ["central", "project"], owner: "marketing" }),
  entry({ id: "social.account.x", label: { en: "X account", de: "X-Konto" }, category: "social", authType: "oauth_account", scopes: ["project"], storage: ["project"], owner: "social" }),
  entry({ id: "google_drive", label: { en: "Google Drive", de: "Google Drive" }, category: "google", authType: "oauth_account", scopes: ["project"], storage: ["project"] }),
  entry({ id: "openai", label: { en: "OpenAI", de: "OpenAI" }, category: "ai", scopes: ["system", "workspace"], storage: ["central"] }),
  entry({ id: "knowledge_github", category: "development", authType: "oauth_account", scopes: ["project"], storage: ["project"], owner: "knowledge" }),
  entry({ id: "n8n", category: "automation", scopes: ["workspace"], storage: ["central"] }),
  entry({ id: "switched_off", category: "social", scopes: ["project", "system", "workspace"], storage: ["project"], available: false }),
];
const byId = (id: string) => catalog.find((e) => e.id === id)!;
const t = integrationText("en");

const project: ManageScope = { kind: "project", projectId: "p1" };
const organization: ManageScope = { kind: "organization", organizationId: "w1" };
const system: ManageScope = { kind: "system" };
const hrefIn = (scope: ManageScope) => (area: string, ...rest: string[]) =>
  manageHref(scope, area, ...rest);

// Capabilities as apps/api grants them (management/capabilities.ts).
const capsOf = (over: Partial<ManagementCapabilities> = {}): ManagementCapabilities => ({
  stage: "preview", system: [], account: [], organizations: [], projects: [], ...over,
});
const VIEWER_CAPS = ["project.overview", "project.profile", "project.modules", "project.integrations"] as Capability[];
const OWNER_CAPS = [...VIEWER_CAPS, "project.members", "project.ai", "project.data"] as Capability[];
const asProject = (role: "owner" | "editor" | "viewer") =>
  capsOf({ projects: [{ id: "p1", name: "P", workspaceId: "w1", role, capabilities: role === "owner" ? OWNER_CAPS : VIEWER_CAPS }] });
const ORG_OWNER = capsOf({
  organizations: [{ id: "w1", name: "Org", capabilities: ["organization.overview", "organization.members", "organization.connections"] }],
  projects: [{ id: "p1", name: "P", workspaceId: "w1", role: "owner", capabilities: OWNER_CAPS }],
});
const ADMIN_CAPS = capsOf({ system: ["system.overview", "system.connections"] });

describe("setupHrefOf", () => {
  const href = (id: string, scope: ManageScope, caps: ManagementCapabilities | undefined) =>
    setupHrefOf(byId(id), { entries: catalog, scope, hrefOf: hrefIn(scope), caps });

  it("offers set up in a project only to a member with a step of their own", () => {
    for (const id of ["postiz", "social.account.x", "email"]) {
      expect(href(id, project, asProject("viewer"))).toBeNull();
      expect(href(id, project, asProject("editor"))).toBeNull();
      expect(href(id, project, asProject("owner"))).toBe(`/manage/p/p1/integrations/setup/${encodeURIComponent(id)}`);
      expect(href(id, project, ORG_OWNER)).not.toBeNull();
    }
    // Without the capabilities answer nobody is known to own a step.
    expect(href("postiz", project, undefined)).toBeNull();
  });

  it("keeps set up for the holders of the system and organization capability", () => {
    // Derived, not assumed: the capability that shows these sections makes
    // configure and check the member's own.
    expect(href("openai", system, ADMIN_CAPS)).toBe("/manage/system/integrations/setup/openai");
    expect(href("openai", organization, ORG_OWNER)).toBe("/manage/o/w1/integrations/setup/openai");
    expect(href("openai", organization, asProject("owner"))).toBeNull();
    expect(href("openai", system, ORG_OWNER)).toBeNull();
  });

  it("never offers what the scope cannot set up", () => {
    expect(href("system_mail", system, ADMIN_CAPS)).toBeNull();
    expect(href("switched_off", project, ORG_OWNER)).toBeNull();
    expect(href("openai", project, ORG_OWNER)).toBeNull();
  });
});

describe("record builders", () => {
  it("keeps two connections of one provider as two records (system)", () => {
    const connections: AdminConnection[] = [
      { id: "c1", provider: "openai", label: "OpenAI main", state: "verified", checkedAt: "2026-11-10T08:00:00.000Z" },
      { id: "c2", provider: "openai", label: "OpenAI backup", state: "stored", checkedAt: null },
      { id: "c3", provider: "n8n", label: "n8n", state: "needs_attention", checkedAt: null },
    ];
    const records = systemRecords(connections);
    expect(records.get("openai")).toEqual([
      { key: "c1", label: "OpenAI main", state: "verified", checkedAt: "2026-11-10T08:00:00.000Z" },
      { key: "c2", label: "OpenAI backup", state: "stored", checkedAt: null },
    ]);
    expect(records.get("n8n")?.map((r) => r.key)).toEqual(["c3"]);
    expect(records.get("postiz")).toBeUndefined();
  });

  it("gives a mailbox its mail server group as detail (project)", () => {
    const items: ProjectIntegration[] = [
      { id: "m1", provider: "email", label: "support@example.invalid", category: "email", scope: "project", state: "ready", checkedAt: null, group: "mail.example.invalid" },
      { id: "m2", provider: "email", label: "info@example.invalid", category: "email", scope: "central", state: "verified", checkedAt: null, group: null },
      { id: "d1", provider: "google_drive", label: "Google Drive", category: "google", scope: "project", state: "ready", checkedAt: null, group: null },
    ];
    const records = projectRecords(items);
    expect(records.get("email")).toEqual([
      { key: "m1", label: "support@example.invalid", state: "ready", checkedAt: null, detail: "mail.example.invalid" },
      { key: "m2", label: "info@example.invalid", state: "verified", checkedAt: null },
    ]);
    expect(records.get("google_drive")?.[0]).not.toHaveProperty("detail");
  });

  it("names the projects that use an organization connection, bound or granted only", () => {
    const usage: OrganizationIntegrations = {
      connections: [
        {
          id: "c1",
          provider: "postiz",
          label: "Postiz",
          category: "social",
          scope: "workspace",
          state: "ready",
          checkedAt: null,
          projects: [
            { id: "p1", name: "Alpha", bound: true },
            { id: "p2", name: "Beta", bound: false },
          ],
        },
        { id: "c2", provider: "openai", label: "OpenAI", category: "ai", scope: "system", state: "verified", checkedAt: null, projects: [] },
      ],
      projects: [],
    };
    const records = organizationRecords(usage, "en");
    expect(records.get("postiz")?.[0]?.detail).toBe(
      `${t("usedBy")}: Alpha (${t("bound")}), Beta (${t("grantedNotBound")})`,
    );
    expect(records.get("openai")?.[0]?.detail).toBe(`${t("usedBy")}: ${t("none")}`);
    const de = integrationText("de");
    expect(organizationRecords(usage, "de").get("postiz")?.[0]?.detail).toBe(
      `${de("usedBy")}: Alpha (${de("bound")}), Beta (${de("grantedNotBound")})`,
    );
  });
});

describe("scopeCatalog", () => {
  it("is catalogGroups plus the scope's switched-off entries when every record has a card", () => {
    const records = projectRecords([
      { id: "d1", provider: "google_drive", label: "Google Drive", category: "google", scope: "project", state: "ready", checkedAt: null, group: null },
    ]);
    const { groups, unavailable } = scopeCatalog(catalog, "project", records);
    expect(groups.map((g) => g.category)).toEqual(["email", "social", "google", "ai", "automation", "development"]);
    expect(unavailable.map((e) => e.id)).toEqual(["switched_off"]);
  });

  it("gives a record whose provider has no card one, so it never vanishes", () => {
    const records = systemRecords([
      // A provider newer than this build.
      { id: "c9", provider: "future_crm", label: "Future CRM", state: "ready", checkedAt: null },
      // Known, but outside the system scope's catalog (workspace only).
      { id: "c3", provider: "n8n", label: "n8n of an organization", state: "verified", checkedAt: null },
    ]);
    const { groups } = scopeCatalog(catalog, "system", records);
    const ids = groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(ids).toContain("future_crm");
    expect(ids).toContain("n8n");
    const automation = groups.find((g) => g.category === "automation");
    expect(automation?.entries.map((e) => e.id)).toEqual(["n8n"]);
    const other = groups.find((g) => g.category === "other")!;
    const future = other.entries.find((e) => e.id === "future_crm")!;
    expect(future.label).toEqual({ en: "Future CRM", de: "Future CRM" });
    expect(future.available).toBe(true);
    // Categories stay in vocabulary order.
    expect(groups.map((g) => g.category)).toEqual(["email", "social", "ai", "automation", "other"]);
    const html = renderToStaticMarkup(
      <>
        {groups.map((g) => g.entries.map((e) => <span key={e.id}>{e.label.en}</span>))}
      </>,
    );
    expect(html).toContain("Future CRM");
  });
});

describe("manageHrefOf", () => {
  const social = [{ id: "social/accounts", providers: ["social.account.x"] }];
  // Marketing shown: it contributes postiz to the Connectors page.
  const ctx = (
    scope: ManageScope,
    moduleSections: ReadonlyArray<{ id: string; providers?: readonly string[] }> = social,
    connectorProviders: readonly string[] = scope.kind === "project" ? ["postiz"] : [],
  ) => ({ scope, hrefOf: hrefIn(scope), moduleSections, connectorProviders });
  const issuesWebhook = entry({ id: "issues_webhook", category: "development", authType: "webhook_secret", scopes: ["project"], storage: ["project"], owner: "issues" });
  const ownerBot = entry({ id: "telegram_owner_bot", category: "other", authType: "bot_token", scopes: ["project"], storage: ["project"], owner: "platform" });

  it("links each card to the section that manages it", () => {
    expect(manageHrefOf(byId("postiz"), ctx(project))).toBe("/manage/p/p1/integrations/connections");
    expect(manageHrefOf(byId("google_drive"), ctx(project))).toBe("/manage/p/p1/integrations/google-drive");
    expect(manageHrefOf(byId("social.account.x"), ctx(project))).toBe("/manage/p/p1/integrations/social/accounts");
    expect(manageHrefOf(byId("openai"), ctx(project))).toBeNull();
    expect(manageHrefOf(byId("postiz"), ctx(organization))).toBe("/manage/o/w1/integrations/connections");
    expect(manageHrefOf(byId("system_mail"), ctx(system))).toBeNull();
    expect(manageHrefOf(byId("openai"), ctx(system))).toBe("/manage/system/integrations/connections");
  });

  it("links a project card to connections only where the Connectors page manages it", () => {
    // Platform-owned: the Connectors page renders the mailbox and the owner bot itself.
    expect(manageHrefOf(byId("email"), ctx(project))).toBe("/manage/p/p1/integrations/connections");
    expect(manageHrefOf(ownerBot, ctx(project))).toBe("/manage/p/p1/integrations/connections");
    // Managed in the Issues module's settings, not on the Connectors page.
    expect(manageHrefOf(issuesWebhook, ctx(project))).toBeNull();
    // Marketing hidden: the Connectors page does not show postiz.
    expect(manageHrefOf(byId("postiz"), ctx(project, social, []))).toBeNull();
    // Social hidden: no section manages the accounts, and Connectors has no Social provider.
    expect(manageHrefOf(byId("social.account.x"), ctx(project, []))).toBeNull();
    expect(manageHrefOf(byId("knowledge_github"), ctx(project))).toBeNull();
  });

  it("links an organization-only provider in the organization, not in the system", () => {
    expect(manageHrefOf(byId("n8n"), ctx(organization))).toBe("/manage/o/w1/integrations/connections");
    expect(manageHrefOf(byId("n8n"), ctx(system))).toBeNull();
    expect(manageHrefOf(byId("postiz"), ctx(system))).toBe("/manage/system/integrations/connections");
    // Project-only storage is never managed centrally.
    expect(manageHrefOf(byId("social.account.x"), ctx(organization, []))).toBeNull();
  });
  // A null link renders managedInModule and no Manage link: provider-card.test.tsx.
});

const environment: EnvironmentStatus = {
  redis: { configured: true, reachable: false },
  files: { configured: true },
  googleDriveApp: { configured: false },
  aiFallbackKeys: { openai: true, anthropic: false },
  credentialKeys: { ring: true },
  mcp: { oauth: true, gateway: true, dcr: false, tasks: false, proposals: false, projectConfiguration: false, projectAdministration: false },
  connectionsCutover: ["openai", "email"],
};
const allOff: EnvironmentStatus = {
  redis: { configured: false, reachable: false },
  files: { configured: false },
  googleDriveApp: { configured: false },
  aiFallbackKeys: { openai: false, anthropic: false },
  credentialKeys: { ring: false },
  mcp: { oauth: false, gateway: false, dcr: false, tasks: false, proposals: false, projectConfiguration: false, projectAdministration: false },
  connectionsCutover: [],
};

describe("environment panel", () => {
  it("lists the seven rows", () => {
    expect(environmentRows(environment, "en")).toEqual([
      { key: "envRedis", label: t("envRedis"), value: `${t("configured")} · ${t("unreachable")}` },
      { key: "envFiles", label: t("envFiles"), value: t("configured") },
      { key: "envDriveApp", label: t("envDriveApp"), value: t("missing") },
      { key: "envAiKeys", label: t("envAiKeys"), value: `OpenAI: ${t("configured")} · Anthropic: ${t("missing")}` },
      { key: "envKeyRing", label: t("envKeyRing"), value: t("configured") },
      { key: "envMcp", label: t("envMcp"), value: "oauth, gateway" },
      { key: "envCutover", label: t("envCutover"), value: "openai, email" },
    ]);
  });

  it("says none and missing when everything is off", () => {
    const values = environmentRows(allOff, "en").map((r) => r.value);
    expect(values).toEqual([
      `${t("missing")} · ${t("unreachable")}`,
      t("missing"),
      t("missing"),
      `OpenAI: ${t("missing")} · Anthropic: ${t("missing")}`,
      t("missing"),
      t("none"),
      t("none"),
    ]);
  });

  it("does not break on an answer missing parts", () => {
    const partial = { redis: { configured: true, reachable: true } } as unknown as EnvironmentStatus;
    const rows = environmentRows(partial, "en");
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.key === "envMcp")?.value).toBe(t("none"));
    expect(rows.find((r) => r.key === "envFiles")?.value).toBe(t("missing"));
  });

  it("renders a heading, the body and a definition list, in German too", () => {
    const html = renderToStaticMarkup(<EnvironmentPanel environment={environment} locale="en" />);
    expect(html).toContain(`<h2>${t("environmentTitle")}</h2>`);
    expect(html).toContain(t("environmentBody"));
    expect(html).toContain("<dl");
    expect(html.match(/<dt>/g)).toHaveLength(7);
    expect(html).toContain(`<dd>oauth, gateway</dd>`);
    const de = integrationText("de");
    const htmlDe = renderToStaticMarkup(<EnvironmentPanel environment={allOff} locale="de" />);
    expect(htmlDe).toContain(`<h2>${de("environmentTitle")}</h2>`);
    expect(htmlDe).toContain(`<dd>${de("none")}</dd>`);
  });
});

describe("organization projects", () => {
  const usage: OrganizationIntegrations = {
    connections: [],
    projects: [
      {
        id: "p1",
        name: "Alpha",
        integrations: [
          { id: "m1", provider: "email", label: "support@example.invalid", category: "email", scope: "project", state: "needs_attention", checkedAt: "2026-11-10T08:00:00.000Z", group: "mail.example.invalid" },
          { id: "x1", provider: "future_crm", label: "Future CRM", category: "other", scope: "project", state: "weird" as never, checkedAt: null, group: null },
        ],
      },
      { id: "p2", name: "Beta", integrations: [] },
    ],
  };

  it("shows one table per project with provider, state and last check", () => {
    const html = renderToStaticMarkup(
      <OrganizationProjects projects={usage.projects} catalog={catalog} locale="en" />,
    );
    expect(html).toContain(`<h2>${t("projectsTitle")}</h2>`);
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain("<caption>Alpha</caption>");
    expect(html).toContain("<caption>Beta</caption>");
    // The catalog's provider label and the record's own label.
    expect(html).toContain("Mailbox");
    expect(html).toContain("support@example.invalid");
    expect(html).toContain(stateLabel("needs_attention", "en"));
    expect(html).toContain(at("2026-11-10T08:00:00.000Z", "en"));
    // Unknown provider and state render raw.
    expect(html).toContain("Future CRM");
    expect(html).toContain("weird");
    expect(html).toContain(t("neverChecked"));
    // A project without integrations says so.
    expect(html).toContain(t("none"));
  });

  it("says none when the organization has no projects", () => {
    const html = renderToStaticMarkup(<OrganizationProjects projects={[]} catalog={catalog} locale="en" />);
    expect(html).toContain(`<h2>${t("projectsTitle")}</h2>`);
    expect(html).not.toContain("<table");
    expect(html).toContain(`<p>${t("none")}</p>`);
  });
});

describe("gate", () => {
  const ok = { data: {}, error: null, loading: false, refresh: () => {} };
  it("waits for every request and shows the first error with a retry", () => {
    expect(gate([ok, ok])).toBeNull();
    expect(renderToStaticMarkup(<>{gate([ok, { ...ok, data: null, loading: true }])}</>)).toContain('role="status"');
    const failed = { data: null, error: new Error("catalog failed"), loading: false, refresh: () => {} };
    const html = renderToStaticMarkup(<>{gate([{ ...ok, data: null, loading: true }, failed])}</>);
    expect(html).toContain("catalog failed");
    expect(html).toContain("Try again");
    expect(html).not.toContain('role="status"');
  });

  it("retries every failed request", () => {
    const calls: string[] = [];
    const failed = (name: string) => ({ data: null, error: new Error(name), loading: false, refresh: () => calls.push(name) });
    const node = gate([failed("a"), ok, failed("b")]) as { props: { retry(): void } };
    node.props.retry();
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("containers", () => {
  const props = (scope: ManageScope) => ({
    scope,
    locale: "en" as const,
    identity: {} as Identity,
    hrefOf: hrefIn(scope),
  });
  it("show the loading state before any answer, never a guessed catalog", () => {
    for (const html of [
      renderToStaticMarkup(<SystemCatalog {...props(system)} />),
      renderToStaticMarkup(<OrganizationCatalog {...props(organization)} />),
      renderToStaticMarkup(<ProjectCatalog {...props(project)} />),
    ]) {
      expect(html).toContain('role="status"');
      expect(html).not.toContain("integration-card");
    }
  });

  it("name the section in both languages", () => {
    expect(CATALOG_SECTION.label).toEqual({ en: "All integrations", de: "Alle Integrationen" });
    expect(CATALOG_SECTION.description).toEqual({
      en: "Every integration Orbit has code for, with its state here.",
      de: "Jede Integration, für die Orbit Code hat, mit ihrem Zustand hier.",
    });
  });
});
