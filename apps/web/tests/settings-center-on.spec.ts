import { test, expect, type Page, type Request } from "./fixtures";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { SEED, signIn } from "./settings-center-helpers";

// The settings center with ORBIT_SETTINGS_CENTER=on (phase 5) in the
// browser: every old settings address leads to its section of the center,
// the navigation offers one entry "Administration & settings", a member who
// may not open the target lands on what they may open, the public keys
// moved to the public access section, and the Social accounts page states
// its accounts and links to the center.
//
// The whole file skips unless /api/me reports `settingsCenter: "on"`. Each
// scenario gates on the flags, capabilities and module switches it needs and
// creates its fixtures only after its gate passed, so a skipped run leaves
// nothing behind.
//
// What the file creates and puts back:
// - a second person (organization member, editor of the seeded project)
//   through an invitation link without system mail; at the end, also after
//   a failed assertion, it is removed from the project and the organization,
//   a pending invitation is revoked and the account is deactivated (where the
//   seeded owner is a system administrator), all found by this run's
//   address; memberships and invitations of an interrupted run are removed
//   before a new one is invited.
// Nothing else is written: opening old addresses must not write (one
// scenario asserts it), and no provider is reached.

const STATE = resolve(".runtime/settings-center-on-state.json");
const SECOND_PREFIX = "on-editor-";
const RUN = Date.now().toString(36);
// This run's second person; afterAll finds every trace of it by this address.
const SECOND_EMAIL = `${SECOND_PREFIX}${RUN}@example.invalid`;

type Caps = {
  stage: string;
  flags?: { connections: boolean };
  system: string[];
  account: string[];
  organizations: Array<{ id: string; name: string; capabilities: string[] }>;
  projects: Array<{ id: string; name: string; workspaceId: string; capabilities: string[] }>;
};
type ModuleList = { switchable: boolean; modules: Array<{ id: string; enabled: boolean }> };

let stage: string | undefined;
let caps: Caps;
let userId = "";
let origin = "";
let modules: ModuleList | undefined;
// Set once this run invited the second person; afterAll then removes it.
let secondInvited = false;
let secondContext: import("@playwright/test").BrowserContext | undefined;

/** The seeded project: the redirects are walked in it. */
const projectId = () => (JSON.parse(readFileSync(SEED, "utf8")) as { projectId: string }).projectId;
const projectCaps = () => caps.projects.find((p) => p.id === projectId())?.capabilities ?? [];
const org = () => {
  const workspaceId = caps.projects.find((p) => p.id === projectId())?.workspaceId;
  return caps.organizations.find((o) => o.id === workspaceId) ?? caps.organizations[0];
};
const moduleOn = (id: string) => Boolean(modules?.modules.some((m) => m.id === id && m.enabled));

const sectionNav = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

/**
 * Old address → center address for the seeded owner, from the rows of
 * apps/web/src/platform/settings-center/redirects.test.tsx. A row is listed
 * only where the member can open its target section (or, for the two account
 * rows, its fallback), so every row asserts one exact address.
 */
function redirectRows(): Array<[string, string]> {
  const p = projectId();
  const o = org().id;
  const sys = (c: string) => caps.system.includes(c);
  const orgCan = (c: string) => org().capabilities.includes(c);
  const projectCan = (c: string) => projectCaps().includes(c);
  const rows: Array<[string, string, boolean]> = [
    ["/admin", "/manage/system/overview", sys("system.overview")],
    ["/admin/integrations", "/manage/system/integrations", sys("system.connections")],
    ["/admin/ai", "/manage/system/ai", sys("system.ai")],
    ["/admin/mcp", "/manage/system/mcp", sys("system.mcp")],
    ["/admin/audit", "/manage/system/security/audit", sys("system.audit")],
    ["/admin/users", "/manage/system/users", sys("system.users")],
    [`/admin/users/${userId}`, `/manage/system/users/${userId}`, sys("system.users")],
    ["/admin/invitations", "/manage/system/users/invitations", sys("system.users")],
    ["/admin/organizations", "/manage/system/organizations", sys("system.organizations")],
    [`/admin/organizations/${o}`, `/manage/system/organizations/${o}`, sys("system.organizations")],
    ["/admin/projects", "/manage/system/organizations/projects", sys("system.organizations")],
    // P5-R1: the old shell ignored an id below a section that takes none.
    ["/admin/ai/x", "/manage/system/ai", sys("system.ai")],
    [`/o/${o}/settings`, `/manage/o/${o}/overview`, orgCan("organization.overview")],
    [
      `/o/${o}/settings#assistant-budget`,
      `/manage/o/${o}/ai/budget#assistant-budget`,
      orgCan("organization.ai"),
    ],
    ["/account", "/manage/me/profile", caps.account.includes("account.profile")],
    // Without the assistant area the member lands on the account's first
    // area: the fallback of decision P5-D5.
    [
      "/account/assistant",
      caps.account.includes("account.assistant") ? "/manage/me/assistant" : "/manage/me/profile",
      caps.account.includes("account.profile"),
    ],
    [`/p/${p}/settings`, `/manage/p/${p}/overview`, projectCan("project.overview")],
    [`/p/${p}/settings?section=project`, `/manage/p/${p}/overview`, projectCan("project.overview")],
    [`/p/${p}/settings?section=nothing-here`, `/manage/p/${p}/overview`, projectCan("project.overview")],
    [`/p/${p}/settings?section=members`, `/manage/p/${p}/members`, projectCan("project.members")],
    [`/p/${p}/settings?section=integrations`, `/manage/p/${p}/integrations`, projectCan("project.integrations")],
    [`/p/${p}/settings?section=ai`, `/manage/p/${p}/ai`, projectCan("project.ai")],
    [`/p/${p}/settings?section=retention`, `/manage/p/${p}/data`, projectCan("project.data")],
    [`/p/${p}/settings?section=modules`, `/manage/p/${p}/modules`, projectCan("project.modules")],
    // Without the connected-apps area: the account's first area (P5-D5).
    [
      `/p/${p}/settings?section=apps`,
      caps.account.includes("account.apps") ? "/manage/me/connections" : "/manage/me/profile",
      caps.account.includes("account.profile"),
    ],
    [
      `/p/${p}/settings?section=brand`,
      `/manage/p/${p}/modules/marketing/brand`,
      projectCan("project.modules") && moduleOn("marketing"),
    ],
    [
      `/p/${p}/settings?section=policy`,
      `/manage/p/${p}/modules/marketing/policy`,
      projectCan("project.modules") && moduleOn("marketing"),
    ],
    // P5-R2: the connections section mounts the panel the old page showed.
    [`/p/${p}/connectors`, `/manage/p/${p}/integrations/connections`, projectCan("project.integrations")],
  ];
  return rows.filter(([, , open]) => open).map(([from, to]) => [from, to]);
}

/**
 * How many rows the walk must have, tallied per capability apart from the
 * table: a row lost from the table (or a gate that drops more than it should)
 * changes the walk but not this number.
 */
function expectedRowCount(): number {
  const has = (list: readonly string[], c: string) => (list.includes(c) ? 1 : 0);
  const sys = (c: string) => has(caps.system, c);
  const project = (c: string) => has(projectCaps(), c);
  return (
    sys("system.overview") +
    sys("system.connections") +
    2 * sys("system.ai") +
    sys("system.mcp") +
    sys("system.audit") +
    3 * sys("system.users") +
    3 * sys("system.organizations") +
    has(org().capabilities, "organization.overview") +
    has(org().capabilities, "organization.ai") +
    3 * has(caps.account, "account.profile") +
    3 * project("project.overview") +
    project("project.members") +
    2 * project("project.integrations") +
    project("project.ai") +
    project("project.data") +
    project("project.modules") +
    (moduleOn("marketing") ? 2 * project("project.modules") : 0)
  );
}

/**
 * A client navigation through the app's own router, as a <Link> click does:
 * the URL is written to the history only when the navigation commits, unlike
 * page.goto (a cold load) or history.pushState (written before the router
 * renders).
 */
const routerPush = (page: Page, href: string) =>
  page.evaluate((to) => {
    const next = (window as unknown as { next?: { router?: { push(href: string): void } } }).next;
    if (!next?.router) throw new Error("the app router is not exposed");
    next.router.push(to);
  }, href);

/** The address bar's path, search and hash. */
const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search + url.hash;
};

/** Records every API request that is no read; the walk must leave it empty. Only `/api/` requests are seen. */
function recordWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(r.method()))
      writes.push(`${r.method()} ${url.pathname}`);
  });
  return writes;
}

test.describe("settings center with the flag on", () => {
  test.skip(!existsSync(SEED), "needs the seeded e2e installation");
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: STATE });

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    origin = new URL(baseURL!).origin;
    // A fresh context: the describe's storageState does not exist yet.
    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await signIn(page);
      const me = await page.request.get("/api/me").then((r) => r.json());
      stage = me.settingsCenter;
      userId = me.user.id;
      if (stage === "on") {
        caps = await page.request.get("/api/management/capabilities").then((r) => r.json());
        modules = await page.request
          .get(`/api/projects/${encodeURIComponent(projectId())}/modules`)
          .then((r) => (r.ok() ? r.json() : undefined));
      }
      await context.storageState({ path: STATE });
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!secondInvited) return;
    await secondContext?.close().catch(() => {});
    const context = await browser.newContext({ baseURL, storageState: STATE });
    const request = context.request;
    const o = org().id;
    // Every step is attempted on its own; failures are reported together. The
    // second person is found by this run's address, not by what the scenario
    // recorded, so an accept interrupted halfway is cleaned up too.
    const errors: unknown[] = [];
    const attempt = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
      } catch (error) {
        errors.push(new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    const ok = async (response: import("@playwright/test").APIResponse, what: string) => {
      if (!response.ok()) throw new Error(`${what}: ${response.status()}`);
    };
    try {
      let detail:
        | { members: Array<{ id: string; email: string }>; invitations?: Array<{ id: string; email: string }> }
        | undefined;
      await attempt("organization read", async () => {
        const response = await request.get(`/api/organizations/${o}`);
        await ok(response, "organization read");
        detail = await response.json();
      });
      for (const m of detail?.members.filter((m) => m.email === SECOND_EMAIL) ?? []) {
        await attempt("project membership removed", async () => {
          const response = await request.delete(
            `/api/organizations/${o}/projects/${projectId()}/members/${m.id}`,
            { headers: { origin } },
          );
          if (response.status() !== 404) await ok(response, "project membership removed");
        });
        await attempt("organization membership removed", async () =>
          ok(
            await request.delete(`/api/organizations/${o}/members/${m.id}`, { headers: { origin } }),
            "organization membership removed",
          ),
        );
      }
      for (const i of detail?.invitations?.filter((i) => i.email === SECOND_EMAIL) ?? [])
        await attempt("invitation revoked", async () =>
          ok(
            await request.delete(`/api/organizations/${o}/invitations/${i.id}`, { headers: { origin } }),
            "invitation revoked",
          ),
        );
      // No active stray account stays behind where the seeded owner may
      // deactivate accounts (a system administrator).
      if (caps.system.includes("system.users"))
        await attempt("account deactivated", async () => {
          const response = await request.get(
            `/api/admin/users?query=${encodeURIComponent(SECOND_EMAIL)}`,
          );
          await ok(response, "account search");
          const list = (await response.json()) as { items: Array<{ id: string; email: string }> };
          for (const u of list.items.filter((u) => u.email === SECOND_EMAIL))
            await ok(
              await request.post(`/api/admin/users/${u.id}/deactivate`, { headers: { origin }, data: {} }),
              "account deactivated",
            );
        });
    } finally {
      await context.close();
    }
    if (errors.length) throw new AggregateError(errors, "cleanup of settings-center-on.spec.ts failed");
  });

  test.beforeEach(() => {
    test.skip(stage !== "on", "ORBIT_SETTINGS_CENTER is not on");
  });

  test("every old address opens its section of the center", async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const rows = redirectRows();
    expect(rows.length, "rows the member's capabilities open").toBe(expectedRowCount());
    test.info().annotations.push({ type: "rows walked", description: String(rows.length) });
    for (const [from, to] of rows) {
      await test.step(from, async () => {
        const before = await page.evaluate(() => history.length);
        await page.goto(from);
        await expect.poll(() => here(page), from).toBe(to);
        await expect(sectionNav(page).locator("[aria-current=page]"), from).toHaveCount(1);
        await expect(page.getByText("Not available", { exact: true }), from).toHaveCount(0);
        await expect(page.getByText("Page not found"), from).toHaveCount(0);
        // The redirect replaces the old address: one entry for the visit.
        expect(await page.evaluate(() => history.length), from).toBeLessThanOrEqual(before + 1);
      });
    }
    expect(errors).toEqual([]);
  });

  test("opening old addresses writes nothing", async ({ page }) => {
    test.setTimeout(180_000);
    const writes = recordWrites(page);
    for (const [from, to] of redirectRows()) {
      await page.goto(from);
      await expect.poll(() => here(page), from).toBe(to);
      await expect(sectionNav(page).locator("[aria-current=page]"), from).toHaveCount(1);
    }
    // Requests still on their way when the last section rendered.
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(writes).toEqual([]);
  });

  test("legacy addresses without a project land in the last project's center", async ({ page }) => {
    test.skip(!projectCaps().includes("project.ai"), "the member cannot open the project's AI area");
    test.skip(!projectCaps().includes("project.integrations"), "the member cannot open the project's integrations");
    const p = projectId();
    // The seeded project becomes the last project opened.
    await page.goto(`/p/${p}`);
    await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("orbit.project"))).toBe(p);
    for (const [from, to, section] of [
      ["/settings?section=ai", `/manage/p/${p}/ai`, "AI overview"],
      ["/connectors", `/manage/p/${p}/integrations/connections`, "Connections"],
    ]) {
      const before = await page.evaluate(() => history.length);
      await page.goto(from);
      await expect.poll(() => here(page), from).toBe(to);
      await expect(
        sectionNav(page).getByRole("link", { name: section, exact: true }),
        from,
      ).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => history.length), from).toBeLessThanOrEqual(before + 1);
    }
  });

  test("the Google Drive return opens the project's Drive section", async ({ page }) => {
    test.skip(!projectCaps().includes("project.integrations"), "the member cannot open the project's integrations");
    const p = projectId();
    const writes = recordWrites(page);
    await page.goto(`/p/${p}/settings?googleDrive=ready`);
    await expect
      .poll(() => here(page))
      .toBe(`/manage/p/${p}/integrations/google-drive?googleDrive=ready`);
    await expect(
      sectionNav(page).getByRole("link", { name: "Google Drive", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Not available", { exact: true })).toHaveCount(0);
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(writes).toEqual([]);
  });

  test("a module settings address of a module that is off says the settings are not available", async ({
    page,
  }) => {
    // The web knows Finance's settings tab whether or not the installation
    // offers the module; only a Finance that is on for the project defeats
    // the case.
    test.skip(moduleOn("finance"), "Finance is on for the project; the case needs it off");
    test.skip(!projectCaps().includes("project.modules"), "the member cannot open the project's modules");
    const p = projectId();
    await page.goto(`/p/${p}/settings?section=finance-mailboxes`);
    await expect.poll(() => here(page)).toBe(`/manage/p/${p}/modules/finance/mailboxes`);
    await expect(page.getByText("Not available", { exact: true })).toBeVisible();
  });

  test("the user menu and the sidebar offer one entry", async ({ page }) => {
    const p = projectId();
    await page.goto(`/p/${p}`);
    await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Workspace" });
    const entry = nav.getByRole("link", { name: "Administration & settings", exact: true });
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("href", `/manage/p/${p}`);
    for (const name of ["Settings", "Connectors", "Account", "Organization settings", "Administration"])
      await expect(nav.getByRole("link", { name, exact: true }), name).toHaveCount(0);

    await page.getByLabel(/^Account menu/).click();
    await expect(
      page.getByRole("menuitem", { name: "Administration & settings", exact: true }),
    ).toBeVisible();
    for (const name of ["Account", "Organization settings", "Administration", "Connectors"])
      await expect(page.getByRole("menuitem", { name, exact: true }), name).toHaveCount(0);

    await page
      .getByRole("menuitem", { name: "Administration & settings", exact: true })
      .click();
    // A bare project address of the center shows the project's overview.
    await expect.poll(() => here(page)).toMatch(new RegExp(`^/manage/p/${p}(/|$)`));
  });

  test("a module group's Settings link opens the module's section", async ({ page }) => {
    test.skip(!moduleOn("marketing"), "Marketing is not on for the project");
    test.skip(!projectCaps().includes("project.modules"), "the member cannot open the project's modules");
    const p = projectId();
    await page.goto(`/p/${p}`);
    await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
    const link = page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Marketing Settings", exact: true });
    await expect(link).toHaveAttribute("href", `/manage/p/${p}/modules/marketing/policy`);
    await link.click();
    await expect.poll(() => here(page)).toBe(`/manage/p/${p}/modules/marketing/policy`);
    await expect(sectionNav(page).locator("[aria-current=page]")).toHaveCount(1);
    await expect(page.getByText("Not available", { exact: true })).toHaveCount(0);
  });

  test("an old address reached on the client from a center page decides on its own search and hash", async ({
    page,
  }) => {
    test.skip(!org().capabilities.includes("organization.ai"), "the member cannot open the organization's AI area");
    test.skip(!projectCaps().includes("project.ai"), "the member cannot open the project's AI area");
    test.skip(!projectCaps().includes("project.members"), "the member cannot open the project's members");
    test.skip(!caps.account.includes("account.profile"), "the member cannot open the account's profile");
    const p = projectId();
    const o = org().id;
    // The seeded stack shows no in-app link from a center page to an old
    // address (the assistant's budget notice needs an exhausted budget).
    const push = (href: string) => routerPush(page, href);
    // Each from a center page with a search of its own, which must not reach
    // the target; the first starts outside any project, as the assistant's
    // budget notice can.
    const cases: Array<[string, string, string]> = [
      ["/manage/me/profile?probe=previous", `/o/${o}/settings#assistant-budget`, `/manage/o/${o}/ai/budget#assistant-budget`],
      [`/manage/p/${p}/members?probe=previous`, `/p/${p}/settings?section=ai`, `/manage/p/${p}/ai`],
    ];
    for (const [start, from, to] of cases) {
      await test.step(from, async () => {
        await page.goto(start);
        await expect.poll(() => here(page)).toBe(start);
        await expect(sectionNav(page).locator("[aria-current=page]")).toHaveCount(1);
        await push(from);
        await expect.poll(() => here(page), from).toBe(to);
        await expect(sectionNav(page).locator("[aria-current=page]"), from).toHaveCount(1);
        expect(page.url(), from).not.toContain("probe=previous");
      });
    }
  });

  test("a client navigation that waits for its location keeps the assistant mounted", async ({ page }) => {
    // The assistant provider wraps every page and reads its status once per
    // mount; a remount reads it again. The path may be an old address but is
    // not mapped without an OAuth result, so the shell waits one render for
    // the committed location on the way.
    const p = projectId();
    const statusReads: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/assistant") statusReads.push(request.url());
    });
    await page.goto(`/p/${p}`);
    await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    // The read is observable on this stack (it answers even without the assistant).
    expect(statusReads.length).toBeGreaterThan(0);
    statusReads.length = 0;
    const to = `/p/${p}/social/accounts`;
    await routerPush(page, to);
    await expect.poll(() => here(page)).toBe(to);
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(statusReads).toEqual([]);
  });

  test("an attention link opens the center", async ({ page }) => {
    const p = projectId();
    await page.goto(`/p/${p}`);
    await expect(page.getByRole("heading", { level: 2, name: "Needs your attention" })).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    const hrefs = await page
      .locator(".attention-row a")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
    // No attention link may lead to an old settings address with the flag on:
    // a project's settings or connectors, an organization's settings, their
    // project-less legacy forms, the administration or the account. The
    // shapes are anchored at the start, so no center address (/manage/…)
    // matches, also not one that ends in /settings.
    const OLD_SETTINGS =
      /^\/(?:(?:p\/[^/?#]+\/)?(?:settings|connectors)|o\/[^/?#]+\/settings|admin|account)(?:[/?#]|$)/;
    for (const href of hrefs) expect(href, "attention link").not.toMatch(OLD_SETTINGS);
    const center = hrefs.find((h) => h.startsWith("/manage/"));
    test.skip(
      !center,
      "the seeded stack shows no attention item with a settings link; the mapping of such links is covered by home.test.tsx (attentionTarget)",
    );
    await page.locator(`.attention-row a[href="${center}"]`).first().click();
    await expect.poll(() => here(page)).toBe(center!);
    await expect(sectionNav(page).locator("[aria-current=page]")).toHaveCount(1);
  });

  test("a member who may not open the target lands on what they may open", async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      !org().capabilities.includes("organization.members"),
      "the member cannot invite into the organization",
    );
    const p = projectId();
    const o = org().id;
    // Leftovers of an interrupted run: its second person and open invitations.
    const detail = (await page.request.get(`/api/organizations/${o}`).then((r) => r.json())) as {
      members: Array<{ id: string; email: string }>;
      invitations?: Array<{ id: string; email: string }>;
    };
    for (const m of detail.members.filter((m) => m.email.startsWith(SECOND_PREFIX))) {
      await page.request.delete(`/api/organizations/${o}/projects/${p}/members/${m.id}`, { headers: { origin } });
      const removed = await page.request.delete(`/api/organizations/${o}/members/${m.id}`, { headers: { origin } });
      expect(removed.ok(), "leftover second person removed").toBe(true);
    }
    for (const i of (detail.invitations ?? []).filter((i) => i.email.startsWith(SECOND_PREFIX))) {
      const revoked = await page.request.delete(`/api/organizations/${o}/invitations/${i.id}`, { headers: { origin } });
      expect(revoked.ok(), "leftover invitation revoked").toBe(true);
    }
    const email = SECOND_EMAIL;
    secondInvited = true;
    const invited = await page.request.post(`/api/organizations/${o}/invitations`, {
      headers: { origin },
      data: { email, role: "member", projects: [{ projectId: p, role: "editor" }] },
    });
    expect(invited.status(), "second person invited").toBe(201);
    const invitation = (await invited.json()) as { invitationId?: string; delivery?: string; link?: string };
    test.skip(
      invitation.delivery !== "link" || !invitation.link,
      "system mail is configured, so the invitation link is not returned",
    );
    const context = (secondContext = await page.context().browser()!.newContext({
      baseURL: origin,
      storageState: { cookies: [], origins: [] },
    }));
    const invitee = await context.newPage();
    const password = randomBytes(18).toString("base64url");
    await invitee.goto(invitation.link!);
    await expect(invitee.getByText(`For ${email}`, { exact: false })).toBeVisible();
    await invitee.getByLabel(/^Your name/).fill("Synthetic project editor");
    await invitee.getByLabel(/^Choose a password/).fill(password);
    await invitee.getByLabel(/^Repeat the password/).fill(password);
    await invitee.getByRole("button", { name: "Create account and accept" }).click();
    await expect(invitee.getByLabel(/^Account menu/)).toBeVisible();

    const theirs = (await invitee.request
      .get("/api/management/capabilities")
      .then((r) => r.json())) as Caps;
    const own = theirs.projects.find((x) => x.id === p)?.capabilities ?? [];
    // The scenario's premise: an editor may open the project, not its members.
    expect(own, "editor capabilities").toContain("project.overview");
    expect(own, "editor capabilities").not.toContain("project.members");

    const writes = recordWrites(invitee);
    await invitee.goto(`/p/${p}/settings?section=members`);
    await expect.poll(() => here(invitee)).toBe(`/manage/p/${p}/overview`);
    await expect(sectionNav(invitee).locator("[aria-current=page]")).toHaveCount(1);
    await expect(invitee.getByText("Not available", { exact: true })).toHaveCount(0);
    await expect(
      sectionNav(invitee).getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
    // The organization's settings are not theirs: the old page stays (P5-D5).
    await invitee.goto(`/o/${o}/settings`);
    await invitee.waitForLoadState("networkidle").catch(() => {});
    expect(new URL(invitee.url()).pathname).toBe(`/o/${o}/settings`);
    expect(writes).toEqual([]);
    await invitee.close();
  });

  test("public access lists keys and the profile section has no keys button", async ({ page }) => {
    test.skip(!projectCaps().includes("project.integrations"), "the member cannot open the project's integrations");
    const p = projectId();
    const writes = recordWrites(page);
    await page.goto(`/manage/p/${p}/integrations/public-access`);
    await expect(
      sectionNav(page).getByRole("link", { name: "Public access", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const main = page.getByRole("main");
    // The seeded owner sees the keys list (or that public ingress is off),
    // never the note for members who are no owners.
    await expect(
      main
        .getByText("No public keys yet.", { exact: true })
        .or(main.getByText("Public ingress is switched off for this installation.", { exact: true }))
        .or(main.locator(".member-row code").first()),
    ).toBeVisible();
    await expect(main.getByText("Only owners of the project manage public keys.")).toHaveCount(0);

    test.skip(!projectCaps().includes("project.profile"), "the member cannot open the project's profile");
    await page.goto(`/manage/p/${p}/profile`);
    await expect(
      sectionNav(page).getByRole("link", { name: "Project profile", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("heading", { name: "Project administration" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Public keys", exact: true })).toHaveCount(0);
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(writes).toEqual([]);
  });

  test("the Social accounts page shows state and a link", async ({ page }) => {
    test.skip(!moduleOn("social"), "Social is not shown for the project");
    const p = projectId();
    await page.goto(`/p/${p}/social/accounts`);
    const main = page.getByRole("main");
    await expect(
      main.getByText("Accounts are connected, checked and disconnected in Administration & settings."),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: "Manage accounts", exact: true })).toHaveAttribute(
      "href",
      `/manage/p/${p}/integrations/social/accounts`,
    );
    // The editor lives only in the center.
    await expect(main.getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  });
});
