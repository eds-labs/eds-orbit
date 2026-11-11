import { describe, expect, it, vi } from "vitest";

// Every answer a container reads, by its exact path; a path without an entry
// fails, so a test sees the error state instead of steps from part of the data.
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
// The workbench panels are the existing ones; here they only show which
// provider they were narrowed to.
vi.mock("@/platform/administration/admin-area", () => ({
  Integrations: ({ provider }: { provider?: string }) => (
    <div data-workbench="system" data-provider={provider} />
  ),
}));
vi.mock("@/platform/administration/connections-ui", () => ({
  ConnectionsPanel: ({ provider, base, mode, targets }: { provider?: string; base: string; mode: string; targets: Array<{ id: string }> }) => (
    <div
      data-workbench="organization"
      data-provider={provider}
      data-base={base}
      data-mode={mode}
      data-targets={targets.map((t) => t.id).join(",")}
    />
  ),
}));
vi.mock("@/components/granted-connections", () => ({
  GrantedConnections: ({ provider, connectors }: { provider?: string; connectors: unknown[] }) => (
    <div data-workbench="project" data-provider={provider} data-connectors={connectors.length} />
  ),
}));

import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace-context";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { manageHref } from "../routes";
import { centerText } from "../texts";
import type { ManagementCapabilities, ManageScope, SectionProps } from "../types";
import {
  OrganizationSetup,
  ProjectSetup,
  refreshAll,
  setupLinks,
  setupOffers,
  setupRole,
  setupSteps,
  SetupStepsView,
  SystemSetup,
  type SetupStep,
} from "./setup";
import { integrationText } from "./texts";
import type { CatalogEntry, IntegrationState } from "./types";

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
const postiz = entry({ id: "postiz", label: { en: "Postiz", de: "Postiz" }, category: "social", scopes: ["project", "workspace", "system"], storage: ["central", "project"] });
const openai = entry({ id: "openai", label: { en: "OpenAI", de: "OpenAI" }, category: "ai", scopes: ["system", "workspace"], storage: ["central"] });
const xAccount = entry({ id: "social.account.x", label: { en: "X account", de: "X-Konto" }, category: "social", authType: "oauth_account", scopes: ["project"], storage: ["project"], owner: "social" });
const systemMail = entry({ id: "system_mail", category: "email", authType: "environment", storage: ["environment"] });
const off = entry({ id: "off_provider", scopes: ["system", "workspace", "project"], storage: ["central", "project"], available: false });
const entries = [postiz, openai, xAccount, systemMail, off];

const t = integrationText("en");
const c = centerText("en");
const ids = (list: readonly CatalogEntry[]) => list.map((e) => e.id);

const NONE = { admin: false, organizationOwner: false, projectOwner: false };
const LINKS = { organization: "/manage/o/w1/integrations/setup/postiz", project: null };
const steps = (over: Partial<Parameters<typeof setupSteps>[0]> = {}) =>
  setupSteps({
    scope: "project",
    entry: postiz,
    role: { ...NONE, projectOwner: true },
    states: [],
    granted: false,
    bound: false,
    projectStored: false,
    links: LINKS,
    ...over,
  });
const byId = (list: readonly SetupStep[]) => Object.fromEntries(list.map((s) => [s.id, s]));

describe("setupOffers", () => {
  it("offers per scope only what can be set up there", () => {
    expect(ids(setupOffers(entries, "system"))).toEqual(["postiz", "openai"]);
    expect(ids(setupOffers(entries, "organization"))).toEqual(["postiz", "openai"]);
    expect(ids(setupOffers(entries, "project"))).toEqual(["postiz", "social.account.x"]);
    expect(ids(setupOffers(entries, "account"))).toEqual([]);
    // A project entry stored in the environment is the installation's, not the project's.
    expect(ids(setupOffers([entry({ id: "e", scopes: ["project"], storage: ["environment"] })], "project"))).toEqual([]);
  });
});

describe("setupSteps", () => {
  it("gives each step to its role and links the others", () => {
    const own = byId(steps());
    expect(steps().map((s) => s.id)).toEqual(["choose", "configure", "check", "authorize", "assign", "validate"]);
    expect(own.choose).toMatchObject({ who: "anyone", mine: true, href: null, done: true });
    for (const id of ["configure", "check", "authorize"]) {
      expect(own[id]).toMatchObject({ who: "owner", mine: false, href: LINKS.organization });
    }
    for (const id of ["assign", "validate"]) {
      expect(own[id]).toMatchObject({ who: "projectOwner", mine: true, href: null });
    }
    expect(steps({ role: { ...NONE, organizationOwner: true } }).every((s) => s.mine && s.href === null)).toBe(true);
  });

  it("gives configure and check of a project-only entry to the project owner", () => {
    const own = byId(steps({ entry: xAccount }));
    expect(own.configure).toMatchObject({ who: "projectOwner", mine: true });
    expect(own.check).toMatchObject({ who: "projectOwner", mine: true });
    // Nothing of the organization's to authorize for a project-only entry.
    expect(own.authorize).toBeUndefined();
  });

  it("gives the system's steps to the administrator and the organization's to the owner", () => {
    const system = byId(steps({ scope: "system", role: { ...NONE, admin: true }, links: { organization: null, project: null } }));
    expect([system.configure!.who, system.check!.who, system.authorize!.who]).toEqual(["admin", "admin", "admin"]);
    expect(system.configure!.mine).toBe(true);
    // Project steps have no single project to link to from the system.
    expect(system.assign).toMatchObject({ who: "projectOwner", mine: false, href: null, observable: false });
    const organization = byId(steps({ scope: "organization", role: { ...NONE, organizationOwner: true }, links: { organization: null, project: null } }));
    expect([organization.configure!.who, organization.authorize!.who]).toEqual(["owner", "owner"]);
    expect(organization.assign).toMatchObject({ who: "projectOwner", mine: true });
    // An administrator who does not own the organization has no owner step.
    const admin = byId(steps({ scope: "organization", role: { ...NONE, admin: true } }));
    expect(admin.configure!.mine).toBe(false);
  });

  it("marks steps done from the server's states", () => {
    const verified = byId(steps({ states: ["verified"], granted: true, bound: false }));
    expect(["configure", "check", "authorize"].map((id) => verified[id]!.done)).toEqual([true, true, true]);
    expect(["assign", "validate"].map((id) => verified[id]!.done)).toEqual([false, false]);
    expect(steps({ states: ["ready"], granted: true, bound: true }).every((s) => s.done)).toBe(true);
    const nothing = byId(steps({ states: ["not_set_up"] }));
    expect(nothing.configure!.done).toBe(false);
    const stored = byId(steps({ states: ["stored"] }));
    expect([stored.configure!.done, stored.check!.done]).toEqual([true, false]);
    // A state newer than this build counts as set up, never as checked.
    const unknown = byId(steps({ states: ["brand_new" as IntegrationState] }));
    expect([unknown.configure!.done, unknown.check!.done]).toEqual([true, false]);
  });
});

describe("SetupStepsView", () => {
  const view = (list: readonly SetupStep[], locale: "en" | "de" = "en") =>
    renderToStaticMarkup(
      <SetupStepsView entry={postiz} steps={list} locale={locale} workbench={<p>WORKBENCH</p>} onRefresh={() => {}} />,
    );

  it("marks the first open step as current", () => {
    const html = view(steps({ states: ["verified"] }));
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    const items = html.split("<li").slice(1);
    // choose, configure, check are done; authorize is the first open one.
    expect(items.findIndex((item) => item.includes('aria-current="step"'))).toBe(3);
    expect(view(steps({ states: ["ready"], granted: true, bound: true }))).not.toContain("aria-current");
  });

  it("says in words who does each step and links another role's step by its name", () => {
    const html = view(steps());
    expect(html).toContain("<ol");
    expect(html).toContain("<h2>Postiz</h2>");
    expect(html).toContain(t("stepDone"));
    expect(html).toContain(t("stepYours"));
    expect(html).toContain(`${t("stepOthers")} ${t("whoOwner")}`);
    expect(html).toContain(`href="${LINKS.organization}"`);
    expect(html).toContain(`aria-label="${t("openStep")}: ${t("stepConfigure")}"`);
    expect(html).toContain(t("refreshState"));
    expect(html.indexOf("</ol>")).toBeLessThan(html.indexOf("WORKBENCH"));
    const de = view(steps(), "de");
    expect(de).toContain(integrationText("de")("stepYours"));
    expect(de).toContain(integrationText("de")("whoOwner"));
  });

  it("offers no link for a step whose scope the member cannot open", () => {
    const html = view(steps({ links: { organization: null, project: null } }));
    expect(html).toContain(`${t("stepOthers")} ${t("whoOwner")}`);
    expect(html).not.toContain(t("openStep"));
  });
});

// Realistic entries of ledger P3-R22: what applies and what the scope can see.
const mailbox = entry({ id: "email", label: { en: "Mailbox", de: "Postfach" }, category: "email", authType: "password", scopes: ["project"], storage: ["project"] });
const current = (list: readonly SetupStep[]) => list.findIndex((s) => s.observable && !s.done);

describe("setupSteps: only what applies and what the scope can see", () => {
  it("emits no authorize step for a mailbox after a successful check, and nothing stays open", () => {
    const list = steps({ entry: mailbox, states: ["ready"], projectStored: true, bound: true });
    expect(list.map((s) => s.id)).toEqual(["choose", "configure", "check", "assign", "validate"]);
    expect(list.every((s) => s.observable && s.done)).toBe(true);
    expect(current(list)).toBe(-1);
  });

  it("gives Postiz on the project's own record to the project owner, without an authorize step", () => {
    const own = byId(steps({ projectStored: true, states: ["verified"] }));
    expect(own.authorize).toBeUndefined();
    expect(own.configure).toMatchObject({ who: "projectOwner", mine: true, done: true });
    expect(own.check).toMatchObject({ who: "projectOwner", mine: true, done: true });
  });

  it("leaves assign and validate unobserved in the system, with no current step once its own are done", () => {
    const list = steps({ scope: "system", role: { ...NONE, admin: true }, states: ["verified"], granted: true, links: { organization: null, project: null } });
    const own = byId(list);
    expect(own.assign).toMatchObject({ observable: false, done: false });
    expect(own.validate).toMatchObject({ observable: false, done: false });
    expect([own.configure!.done, own.check!.done, own.authorize!.done]).toEqual([true, true, true]);
    expect(current(list)).toBe(-1);
    // Even a ready record does not make an unobserved step done.
    expect(byId(steps({ scope: "system", role: { ...NONE, admin: true }, states: ["ready"], bound: true })).validate!.done).toBe(false);
  });

  it("observes assign but not validate in the organization", () => {
    const own = byId(steps({ scope: "organization", role: { ...NONE, organizationOwner: true }, states: ["ready"], granted: true, bound: true }));
    expect(own.assign).toMatchObject({ observable: true, done: true });
    expect(own.validate).toMatchObject({ observable: false, done: false });
  });

  it("shows an unobserved step as following in the project, with one or no current step", () => {
    const render = (list: readonly SetupStep[]) =>
      renderToStaticMarkup(<SetupStepsView entry={postiz} steps={list} locale="en" workbench={null} />);
    const system = render(steps({ scope: "system", role: { ...NONE, admin: true }, states: ["verified"], granted: true }));
    const items = system.split("<li").slice(1);
    for (const item of items.slice(4)) {
      expect(item).toContain(t("stepInProject"));
      expect(item).toContain(t("whoProjectOwner"));
      expect(item).not.toContain(t("stepOthers"));
      expect(item).not.toContain("href=");
      expect(item).not.toContain("aria-current");
    }
    expect(system).not.toContain("aria-current");
    const open = render(steps({ scope: "system", role: { ...NONE, admin: true }, states: ["stored"] }));
    expect(open.match(/aria-current="step"/g)).toHaveLength(1);
    expect(render(steps({ entry: mailbox, states: ["ready"], projectStored: true, bound: true }))).not.toContain("aria-current");
    expect(integrationText("de")("stepInProject")).not.toBe(t("stepInProject"));
  });
});

/** The first element in a rendered tree whose props match. */
function findElement(node: ReactNode, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (match(props)) return props;
  return findElement(props.children as ReactNode, match);
}

describe("refresh", () => {
  it("wires the view's refresh control to onRefresh", () => {
    const calls: string[] = [];
    const onRefresh = () => calls.push("refresh");
    const tree = SetupStepsView({ entry: postiz, steps: steps(), locale: "en", workbench: null, onRefresh });
    const control = findElement(tree, (p) => typeof p.onClick === "function");
    expect(control).not.toBeNull();
    (control!.onClick as () => void)();
    expect(calls).toEqual(["refresh"]);
  });

  it("refreshes every resource the steps are built from, skipping absent ones", () => {
    const calls: string[] = [];
    const resource = (name: string) => ({ refresh: () => calls.push(name) });
    refreshAll([resource("records"), resource("connectors")])();
    expect(calls).toEqual(["records", "connectors"]);
    calls.length = 0;
    refreshAll([resource("records"), null])();
    expect(calls).toEqual(["records"]);
  });
});

const caps = (over: Partial<ManagementCapabilities> = {}): ManagementCapabilities => ({
  stage: "preview",
  system: [],
  account: [],
  organizations: [],
  projects: [],
  ...over,
});
const ORG = { id: "w1", name: "Org", capabilities: ["organization.overview", "organization.members", "organization.connections"] as never };
const ownerProject = { id: "p1", name: "P", workspaceId: "w1", role: "owner" as const, capabilities: ["project.overview", "project.integrations", "project.members", "project.ai", "project.data"] as never };
const editorProject = { ...ownerProject, role: "editor" as const, capabilities: ["project.overview", "project.integrations"] as never };
const PROJECT: ManageScope = { kind: "project", projectId: "p1" };
const ORGANIZATION: ManageScope = { kind: "organization", organizationId: "w1" };

describe("setupRole", () => {
  it("derives each role from the capability only that role receives", () => {
    expect(setupRole({ kind: "system" }, caps({ system: ["system.overview", "system.connections"] }))).toEqual({ ...NONE, admin: true });
    expect(setupRole({ kind: "system" }, caps())).toEqual(NONE);
    expect(setupRole(ORGANIZATION, caps({ organizations: [ORG] }))).toEqual({ ...NONE, organizationOwner: true });
    expect(setupRole(ORGANIZATION, caps({ organizations: [{ ...ORG, id: "w2" }] }))).toEqual(NONE);
    // An organization owner is owner of every project of it.
    expect(setupRole(PROJECT, caps({ organizations: [ORG], projects: [ownerProject] }))).toEqual({ ...NONE, organizationOwner: true, projectOwner: true });
    expect(setupRole(PROJECT, caps({ projects: [ownerProject] }))).toEqual({ ...NONE, projectOwner: true });
    expect(setupRole(PROJECT, caps({ projects: [editorProject] }))).toEqual(NONE);
    expect(setupRole(PROJECT, null)).toEqual(NONE);
  });
});

describe("setupLinks", () => {
  it("links the organization's setup of the entry only where the member may open it", () => {
    expect(setupLinks(PROJECT, "a/b", caps({ organizations: [ORG], projects: [ownerProject] }))).toEqual({
      organization: "/manage/o/w1/integrations/setup/a%2Fb",
      project: null,
    });
    expect(setupLinks(PROJECT, "postiz", caps({ projects: [ownerProject] }))).toEqual({ organization: null, project: null });
    expect(setupLinks(ORGANIZATION, "postiz", caps({ organizations: [ORG] }))).toEqual({ organization: null, project: null });
    expect(setupLinks({ kind: "system" }, "postiz", caps({ organizations: [ORG] }))).toEqual({ organization: null, project: null });
  });
});

// ---- Containers ----

const reset = (next: Record<string, unknown>) => {
  for (const key of Object.keys(answers)) delete answers[key];
  Object.assign(answers, next);
};
const identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  projects: [
    { id: "p1", name: "P", workspaceId: "w1" },
    { id: "p9", name: "Other", workspaceId: "w9" },
  ],
  workspaces: [],
} as unknown as Identity;
const props = (scope: ManageScope, id: string | undefined, capabilities: ManagementCapabilities): SectionProps => ({
  scope,
  id,
  locale: "en",
  identity,
  caps: capabilities,
  hrefOf: (area: string, ...rest: string[]) => manageHref(scope, area, ...rest),
});
const ADMIN = caps({ system: ["system.overview", "system.connections"] });
const catalog = { "/management/integrations/catalog": { items: entries } };
const notAvailable = (html: string) => {
  expect(html).toContain(c("notPermittedTitle"));
  expect(html).not.toContain("data-workbench");
  expect(html).not.toContain("<ol");
};
// Unknown, another scope's entry, switched off, and a planned provider without code.
const REFUSED = { system: ["nope", "social.account.x", "off_provider", "tiktok"], organization: ["nope", "social.account.x", "off_provider", "tiktok"], project: ["nope", "openai", "off_provider", "tiktok"] };

describe("SystemSetup", () => {
  const system = {
    ...catalog,
    "/admin/connections": {
      items: [
        { id: "c1", provider: "postiz", label: "Postiz main", state: "verified", checkedAt: null, activeGrants: 2 },
        { id: "c2", provider: "openai", label: "OpenAI", state: "stored", checkedAt: null, activeGrants: 0 },
      ],
    },
  };

  it("lists what can be set up as links when no provider is chosen", () => {
    reset(system);
    const html = renderToStaticMarkup(<SystemSetup {...props({ kind: "system" }, undefined, ADMIN)} />);
    expect(html).toContain(t("chooseProviderHint"));
    expect(html).toContain('href="/manage/system/integrations/setup/postiz"');
    expect(html).toContain('href="/manage/system/integrations/setup/openai"');
    expect(html).not.toContain("setup/system_mail");
    expect(html).not.toContain("data-workbench");
  });

  it("shows the steps from the connections and the narrowed workbench", () => {
    reset(system);
    const html = renderToStaticMarkup(<SystemSetup {...props({ kind: "system" }, "postiz", ADMIN)} />);
    expect(html).toContain('data-workbench="system"');
    expect(html).toContain('data-provider="postiz"');
    const items = html.split("<li").slice(1);
    // Verified and granted: what follows happens in the projects, out of sight here.
    expect(items).toHaveLength(6);
    expect(html).not.toContain("aria-current");
    expect(html.match(new RegExp(t("stepInProject"), "g"))).toHaveLength(2);
  });

  it("refuses an address that is not offered here, without a workbench", () => {
    for (const id of REFUSED.system) {
      reset(system);
      notAvailable(renderToStaticMarkup(<SystemSetup {...props({ kind: "system" }, id, ADMIN)} />));
    }
  });

  it("shows the error with a retry instead of steps from part of the data", () => {
    reset(catalog);
    const html = renderToStaticMarkup(<SystemSetup {...props({ kind: "system" }, "postiz", ADMIN)} />);
    expect(html).toContain("failed /admin/connections");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("data-workbench");
  });
});

describe("OrganizationSetup", () => {
  const organization = {
    ...catalog,
    "/management/organizations/w1/integrations": {
      connections: [
        { id: "c1", provider: "postiz", label: "Postiz", category: "social", scope: "workspace", state: "verified", checkedAt: null, projects: [{ id: "p1", name: "P", bound: true }] },
      ],
      projects: [],
    },
  };
  const owner = caps({ organizations: [ORG] });

  it("shows the steps and the owner's connections narrowed to the provider", () => {
    reset(organization);
    const html = renderToStaticMarkup(<OrganizationSetup {...props(ORGANIZATION, "postiz", owner)} />);
    expect(html).toContain('data-workbench="organization"');
    expect(html).toContain('data-provider="postiz"');
    expect(html).toContain('data-base="/organizations/w1/connections"');
    expect(html).toContain('data-mode="owner"');
    // Only this organization's projects can receive a grant.
    expect(html).toContain('data-targets="p1"');
    // Verified, granted and bound; the validation follows in the project.
    expect(html).not.toContain("aria-current");
    expect(html.match(new RegExp(t("stepInProject"), "g"))).toHaveLength(1);
  });

  it("refuses an address that is not offered here, without a workbench", () => {
    for (const id of REFUSED.organization) {
      reset(organization);
      notAvailable(renderToStaticMarkup(<OrganizationSetup {...props(ORGANIZATION, id, owner)} />));
    }
  });
});

describe("ProjectSetup", () => {
  const project = {
    ...catalog,
    "/management/projects/p1/integrations": {
      items: [
        { id: "i1", provider: "postiz", label: "Postiz", category: "social", scope: "central", state: "ready", checkedAt: null, group: null },
      ],
    },
    "/projects/p1/connectors?revision=3": { items: [{ id: "k1", data: {} }] },
  };
  const shell = {
    integrations: [],
    connectors: { providers: [], extras: [] },
  } as unknown as ShellContextValue;
  const workspace = { project: { id: "p1" }, revision: 3 } as unknown as WorkspaceContextValue;
  const render = (id: string | undefined, capabilities: ManagementCapabilities) =>
    renderToStaticMarkup(
      <ShellContext.Provider value={shell}>
        <WorkspaceContext.Provider value={workspace}>
          <ProjectSetup {...props(PROJECT, id, capabilities)} />
        </WorkspaceContext.Provider>
      </ShellContext.Provider>,
    );

  it("binds a central entry in the granted connections and links the project's own page", () => {
    reset(project);
    const html = render("postiz", caps({ projects: [ownerProject] }));
    expect(html).toContain('data-workbench="project"');
    expect(html).toContain('data-provider="postiz"');
    expect(html).toContain('data-connectors="1"');
    // Project-stored too: the Connectors page manages it.
    expect(html).toContain(`href="${manageHref(PROJECT, "integrations", "connections")}"`);
    expect(html).toContain(t("manage"));
    // Ready and central: every step done.
    expect(html).not.toContain("aria-current");
  });

  it("does not read a disabled central grant as authorized", () => {
    const authorize = (state: string) => {
      reset({
        ...project,
        "/management/projects/p1/integrations": {
          items: [{ id: "i1", provider: "postiz", label: "Postiz", category: "social", scope: "central", state, checkedAt: null, group: null }],
        },
      });
      const html = render("postiz", caps({ organizations: [ORG], projects: [ownerProject] }));
      return html.split("<li").slice(1).find((item) => item.includes(t("stepAuthorize")))!;
    };
    expect(authorize("verified")).toContain(t("stepDone"));
    expect(authorize("disabled")).not.toContain(t("stepDone"));
    expect(authorize("disabled")).toContain(t("stepYours"));
  });

  it("says a module manages a project entry no page here manages", () => {
    reset(project);
    const html = render("social.account.x", caps({ projects: [ownerProject] }));
    expect(html).toContain(t("managedInModule"));
    expect(html).not.toContain("data-workbench");
    expect(html).toContain("<ol");
  });

  it("refuses an address that is not offered here, without a workbench", () => {
    for (const id of REFUSED.project) {
      reset(project);
      notAvailable(render(id, caps({ projects: [ownerProject] })));
    }
  });
});
