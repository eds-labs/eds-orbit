import { test, expect, type Page, type Request, type Route } from "./fixtures";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The settings center (/manage) in the browser: the four scopes, addresses,
// search, refusals, module sections, the old pages beside it, phone and
// keyboard use, German, and the administrator confirmation (D-8). Needs the
// seeded e2e installation and a stack with ORBIT_ADMINISTRATION=true,
// ORBIT_ACCOUNT=true and ORBIT_SETTINGS_CENTER=preview (or on). The seeded
// user is both system administrator and organization owner; viewer and
// editor visibility is covered by the API integration and unit tests.
//
// The integrations center (phase 3) at the end of the file: the catalog in
// three scopes and the guided setup. Its setup scenarios also need
// ORBIT_CONNECTIONS=true, ORBIT_MODULES=true and
// ORBIT_CONNECTIONS_CUTOVER=postiz,matomo; they bind connections in a project
// of their own ("Integrations acceptance project", created once through the
// API), because a binding cannot be undone in the product and the seeded
// project must stay without a Matomo connector for workspace.spec.ts.
//
// One sign-in for the whole file (sign-ins are rate limited): beforeAll
// signs in and every test starts from that session.

const SEED = resolve(".runtime/e2e-user.json");
const STATE = resolve(".runtime/settings-center-state.json");
const FOREIGN = "00000000-0000-4000-8000-000000000000";

type Caps = {
  system: string[];
  account: string[];
  organizations: Array<{ id: string; name: string; capabilities: string[] }>;
  projects: Array<{
    id: string;
    name: string;
    workspaceId: string;
    capabilities: string[];
  }>;
};

let stage: string | undefined;
let connectionsOn = false;
let caps: Caps;
let userId = "";
let origin = "";

async function signIn(page: Page) {
  const user = JSON.parse(readFileSync(SEED, "utf8")) as {
    email: string;
    password: string;
  };
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  const submit = () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    return page
      .getByRole("button", { name: "Sign in", exact: true })
      .click()
      .then(() => response);
  };
  let response = await submit();
  if (response.status() === 429) {
    // Respect the real authentication throttle; never disable it.
    const seconds = Math.min(
      60,
      Math.max(1, Number(response.headers()["retry-after"]) || 11),
    );
    await page.waitForTimeout(seconds * 1000);
    response = await submit();
  }
  expect(response.status(), "sign-in response").toBe(200);
  await expect(page.getByLabel(/^Account menu/)).toBeVisible();
}

test.describe("settings center", () => {
  test.skip(!existsSync(SEED), "needs the seeded e2e installation");
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: STATE });

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    origin = new URL(baseURL!).origin;
    // A fresh context: the describe's storageState does not exist yet.
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      const me = await page.request.get("/api/me").then((r) => r.json());
      stage = me.settingsCenter;
      connectionsOn = me.connections === true;
      userId = me.user.id;
      if (stage && stage !== "off")
        caps = await page.request
          .get("/api/management/capabilities")
          .then((r) => r.json());
      await context.storageState({ path: STATE });
    } finally {
      await context.close();
    }
  });

  test.beforeEach(() => {
    test.skip(!stage || stage === "off", "ORBIT_SETTINGS_CENTER is off");
  });

  const org = () => caps.organizations[0];
  const project = () => caps.projects[0];
  const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
  const sectionNav = (page: Page) =>
    page.getByRole("navigation", { name: "Settings sections" });

  test("reaches the four scopes through the account menu and the switcher", async ({
    page,
  }) => {
    // Script errors only: the shell probes features that are off on this
    // stack (assistant, notifications, agents), and each 404 logs a console
    // error of its own.
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource"))
        errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    expect(caps.system.length, "seeded user is administrator").toBeGreaterThan(0);
    expect(org(), "seeded user owns an organization").toBeTruthy();
    expect(project(), "seeded user has a project").toBeTruthy();
    await page.goto("/");
    await page.getByLabel(/^Account menu/).click();
    await page
      .getByRole("menuitem", { name: "Administration & settings" })
      .click();
    // A bare /manage opens the last project.
    await expect(page).toHaveURL(/\/manage\/p\/[0-9a-f-]{36}$/);
    await expect(h1(page)).toBeVisible();

    const switcher = page.getByLabel("Applies to");
    const labels = await switcher.locator("option").allInnerTexts();
    for (const name of ["Whole system", "My account", org().name, project().name])
      expect(labels).toContain(name);

    const visit = async (label: string, url: RegExp, heading: string) => {
      await switcher.selectOption({ label });
      await expect(page).toHaveURL(url);
      await expect(h1(page)).toHaveText(heading);
      // The bare scope address shows the card overview.
      await expect(page.locator(".manage-cards")).toBeVisible();
    };
    await visit("Whole system", /\/manage\/system$/, "Whole system");
    await visit("My account", /\/manage\/me$/, "My account");
    await visit(org().name, new RegExp(`/manage/o/${org().id}$`), org().name);
    await visit(
      project().name,
      new RegExp(`/manage/p/${project().id}$`),
      project().name,
    );
    // No React or runtime error on the way.
    expect(errors).toEqual([]);
  });

  test("opens a section by address and marks it", async ({ page }) => {
    await page.goto("/manage/system/users");
    const users = sectionNav(page).getByRole("link", {
      name: "Users",
      exact: true,
    });
    await expect(users).toHaveAttribute("aria-current", "page");
    await expect(sectionNav(page).locator("[aria-current=page]")).toHaveCount(1);
    await expect(h1(page)).toHaveCount(1);
    // The canonical address of a section named like its area is the area's.
    await expect(users).toHaveAttribute("href", "/manage/system/users");
    await page.goto("/manage/system/security/audit");
    await users.click();
    await expect(page).toHaveURL(/\/manage\/system\/users$/);
    await expect(users).toHaveAttribute("aria-current", "page");

    const me = await page.request.get("/api/me").then((r) => r.json());
    await page.goto(`/manage/system/users/${userId}`);
    await expect(
      page.getByRole("main").getByRole("heading", { name: me.user.name }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText(me.user.email)).toBeVisible();
    await expect(users).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Not available")).toHaveCount(0);
  });

  test("searches settings", async ({ page }) => {
    await page.goto("/manage/system");
    await page.getByLabel("Search settings").fill("audit");
    const hit = page.locator(".manage-hits").getByRole("link", {
      name: /Audit log/,
    });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/\/manage\/system\/security\/audit$/);
    await expect(
      sectionNav(page).getByRole("link", { name: "Audit log" }),
    ).toHaveAttribute("aria-current", "page");
    // The search ends with the navigation.
    await expect(page.getByLabel("Search settings")).toHaveValue("");
  });

  test("refuses a foreign project, a foreign organization and an unknown section", async ({
    page,
  }) => {
    await page.goto(`/manage/p/${FOREIGN}`);
    await expect(page.getByText("Page not found").first()).toBeVisible();
    await expect(page.getByLabel("Applies to")).toHaveCount(0);

    // Refused from the capabilities alone: the organization is never requested.
    const asked: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith(`/api/organizations/${FOREIGN}`))
        asked.push(`${r.method()} ${r.url()}`);
    });
    await page.goto(`/manage/o/${FOREIGN}`);
    await expect(page.getByText("Page not found").first()).toBeVisible();
    await expect(page.getByLabel("Applies to")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);

    await page.goto("/manage/system/nope");
    await expect(page.getByText("Not available")).toBeVisible();
    // Inside the frame: the switcher stays.
    await expect(page.getByLabel("Applies to")).toBeVisible();
  });

  test("hides a disabled module's settings", async ({ page }) => {
    const id = project().id;
    const base = `/api/projects/${encodeURIComponent(id)}/modules`;
    const list = (await page.request.get(base).then((r) => r.json())) as {
      switchable: boolean;
      modules: Array<{ id: string; enabled: boolean }>;
    };
    test.skip(!list.switchable, "switching modules is off on this installation");

    // A module that is on and has a group in the project's section list.
    await page.goto(`/manage/p/${id}/modules`);
    await expect(sectionNav(page)).toBeVisible();
    const groupIds = await sectionNav(page)
      .locator(".settings-nav-heading")
      .evaluateAll((els) => els.map((e) => e.id.replace("settings-group-", "")));
    const candidates = ["marketing", ...list.modules.map((m) => m.id)];
    const target = candidates.find(
      (m) =>
        groupIds.includes(m) &&
        list.modules.some((row) => row.id === m && row.enabled),
    );
    test.skip(!target, "no enabled module with settings in this installation");
    const moduleId = target!;
    test.info().annotations.push({ type: "module", description: moduleId });
    const firstLink = await sectionNav(page)
      .locator(`ul[aria-labelledby="settings-group-${moduleId}"] a`)
      .first()
      .getAttribute("href");
    expect(firstLink).toBeTruthy();

    const put = (enabled: boolean) =>
      page.request.put(`${base}/${encodeURIComponent(moduleId)}`, {
        headers: { origin },
        data: { enabled },
      });
    // The installation can switch modules, so a refusal is a failure.
    const off = await put(false);
    expect(off.status(), `switching ${moduleId} off`).toBe(200);
    try {
      await page.goto(`/manage/p/${id}/modules`);
      await expect(sectionNav(page)).toBeVisible();
      await expect(page.locator(`#settings-group-${moduleId}`)).toHaveCount(0);
      await page.goto(firstLink!);
      await expect(page.getByText("Not available")).toBeVisible();
      await page.goto(`/manage/p/${id}/modules/${moduleId}`);
      await expect(page.getByText("Not available")).toBeVisible();
    } finally {
      const on = await put(true);
      expect(on.ok(), `module ${moduleId} switched back on`).toBe(true);
    }
  });

  test("keeps the old pages", async ({ page }) => {
    // The old organization settings page heads with an h2 (it had no h1
    // before the settings center either), so the level is not asserted there.
    const pages: Array<[string, string | RegExp, 1 | 2]> = [
      ["/admin", "Administration", 1],
      [`/o/${org().id}/settings`, org().name, 2],
      [`/p/${project().id}/settings?section=members`, /.+/, 1],
      // Connectors renders embedded in the center; its own page keeps its head.
      [`/p/${project().id}/connectors`, "Connectors", 1],
      ["/account", /.+/, 1],
    ];
    for (const [url, name, level] of pages) {
      await page.goto(url);
      await expect(
        page.getByRole("main").getByRole("heading", { level, name }).first(),
      ).toBeVisible();
      await expect(page.getByText("Page not found")).toHaveCount(0);
      await expect(page.getByLabel("Applies to")).toHaveCount(0);
    }
    // The account menu keeps its old entries beside the new one.
    await page.getByLabel(/^Account menu/).click();
    for (const name of ["Administration & settings", "Administration"])
      await expect(
        page.getByRole("menuitem", { name, exact: true }),
      ).toBeVisible();
  });

  const noHorizontalScroll = (page: Page) =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    );

  test("works on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of [
      `/manage/p/${project().id}/members`,
      "/manage/system/users",
      `/manage/o/${org().id}/members`,
      "/manage/me/profile",
    ]) {
      await page.goto(url);
      const select = page.getByLabel("Section", { exact: true });
      await expect(select).toBeVisible();
      await expect(sectionNav(page)).toBeHidden();
      await expect.poll(() => noHorizontalScroll(page), url).toBe(true);
    }
    // The select opens a section.
    await page.goto("/manage/system/users");
    await page
      .getByLabel("Section", { exact: true })
      .selectOption({ label: "Audit log" });
    await expect(page).toHaveURL(/\/manage\/system\/security\/audit$/);

    await page.setViewportSize({ width: 768, height: 1024 });
    for (const url of [
      `/manage/p/${project().id}/members`,
      "/manage/system/users",
      `/manage/o/${org().id}/members`,
    ]) {
      await page.goto(url);
      await expect(h1(page)).toBeVisible();
      await expect.poll(() => noHorizontalScroll(page), url).toBe(true);
    }
  });

  test("is keyboard operable", async ({ page }) => {
    await page.goto("/manage/system");
    await expect(h1(page)).toHaveCount(1);
    // The frame starts with its back link.
    await page.getByRole("link", { name: /Back to Orbit/ }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Applies to")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Search settings")).toBeFocused();
    await page.keyboard.press("Tab");
    const first = sectionNav(page).getByRole("link").first();
    await expect(first).toBeFocused();
    const href = await first.getAttribute("href");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(first).toHaveAttribute("aria-current", "page");
    await expect(h1(page)).toHaveCount(1);
  });

  test("reads in German", async ({ page }) => {
    await page.goto("/manage/system");
    await page.getByRole("button", { name: "DE", exact: true }).click();
    await expect(page.getByLabel("Gilt für")).toBeVisible();
    await expect(h1(page)).toHaveText("Gesamtes System");
    await page.getByLabel(/^(Account menu|Kontomenü)/).click();
    await expect(
      page.getByRole("menuitem", { name: "Verwaltung & Einstellungen" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => noHorizontalScroll(page)).toBe(true);
  });

  test("asks an administrator before granting a role (D-8), the old page does not", async ({
    page,
  }) => {
    const sent: Request[] = [];
    page.on("request", (r) => {
      if (
        ["PUT", "POST"].includes(r.method()) &&
        new URL(r.url()).pathname.startsWith("/api/organizations/")
      )
        sent.push(r);
    });
    const email = `d8-${Date.now()}@example.invalid`;

    await page.goto(`/manage/system/organizations/${org().id}`);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const invite = page.getByRole("dialog", { name: "Invite someone" });
    await invite.getByLabel(/^E-Mail/).fill(email);
    await invite.getByRole("button", { name: "Invite", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Assign this role as system administrator?",
    });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await invite.getByRole("button", { name: "Cancel" }).click();
    // A changed role asks too.
    const me = await page.request.get("/api/me").then((r) => r.json());
    await page
      .getByLabel(`Organization role of ${me.user.name}`)
      .selectOption("member");
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(sent.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);

    // The old page sends at once. The request is stopped in the browser so
    // nothing is created.
    await page.route(
      (url) => /\/api\/organizations\/[^/]+\/invitations$/.test(url.pathname),
      (route) =>
        route.request().method() === "POST" ? route.abort() : route.fallback(),
    );
    await page.goto(`/admin/organizations/${org().id}`);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const oldInvite = page.getByRole("dialog", { name: "Invite someone" });
    await oldInvite.getByLabel(/^E-Mail/).fill(email);
    const attempt = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/invitations"),
    );
    await oldInvite.getByRole("button", { name: "Invite", exact: true }).click();
    await attempt;
    await expect(confirmation).toHaveCount(0);
    await oldInvite.getByRole("button", { name: "Cancel" }).click();
    const invitations = await page.request
      .get(`/api/organizations/${org().id}`)
      .then((r) => r.json());
    expect(JSON.stringify(invitations.invitations ?? [])).not.toContain(email);
  });

  // ---- Integrations center (phase 3) ----

  const INTEGRATIONS_PROJECT = "Integrations acceptance project";
  // Recognisable and never valid anywhere; the pages must never show it.
  const DUMMY_KEY = "orbit-e2e-dummy-key-7f3c91d2";
  // Labels unique per run, so a second run of the file never meets the
  // first run's rows.
  const RUN = Date.now().toString(36);
  const STATES =
    /Not set up|Stored, not checked|Verified|Ready|Needs attention|Disabled/;

  const card = (page: Page, name: string) =>
    page
      .getByRole("main")
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  const steps = (page: Page) => page.getByRole("list", { name: "Guided setup" });
  const step = (page: Page, label: string) =>
    steps(page)
      .getByRole("listitem")
      .filter({ has: page.locator("strong", { hasText: new RegExp(`^${label}$`) }) });
  const connectionRow = (page: Page, label: string) =>
    page.getByRole("row").filter({ hasText: label });

  /** The project the setup scenarios bind into; created once through the API. */
  async function integrationsProject(page: Page) {
    const me = await page.request.get("/api/me").then((r) => r.json());
    const found = (
      me.projects as Array<{ id: string; name: string; workspaceId: string }>
    ).find((p) => p.name === INTEGRATIONS_PROJECT && p.workspaceId === org().id);
    if (found) return found;
    const created = await page.request.post("/api/projects", {
      headers: { origin },
      data: {
        name: INTEGRATIONS_PROJECT,
        timezone: "Europe/Berlin",
        language: "en",
        workspaceId: org().id,
      },
    });
    expect(created.status(), "integrations project created").toBe(201);
    return (await created.json()) as { id: string; name: string; workspaceId: string };
  }

  /**
   * Answers the two provider checks in the browser (no local Matomo or
   * Postiz) and, for the connections checked that way, the reads that carry
   * their state. Everything else, and every write, goes to the real API. The
   * stored status stays `configured`, so the reads are adjusted here: a
   * checked connection reads as the server would answer once verified.
   */
  async function answerChecks(page: Page) {
    const verified = new Set<string>();
    const boundIn = new Set<string>();
    const seen = new Map<string, Record<string, unknown>>();
    const asVerified = (c: Record<string, unknown>) => ({
      ...c,
      status: "read_verified",
      state: "verified",
    });
    const later = (state: string, bound: boolean) =>
      state === "stored" ? (bound ? "ready" : "verified") : state;
    const item = (projectId: string, i: { id: string; state: string }, bound?: boolean) => {
      const id = i.id.startsWith("connection:") ? i.id.slice("connection:".length) : null;
      return id && verified.has(id)
        ? { ...i, state: later(i.state, bound ?? boundIn.has(`${projectId}/${id}`)) }
        : i;
    };
    const path = (url: URL, re: RegExp) => re.test(url.pathname);
    const fetched = async (
      route: Route,
      change: (body: any) => void,
    ) => {
      if (route.request().method() !== "GET") return route.fallback();
      try {
        const response = await route.fetch();
        const body = await response.json();
        change(body);
        await route.fulfill({ response, json: body });
      } catch {
        // The page moved on and dropped the read; nobody waits for it.
        await route.abort().catch(() => {});
      }
    };
    await page.route(
      (url) => path(url, /^\/api\/(admin|organizations\/[^/]+)\/connections\/[^/]+\/check$/),
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
        verified.add(id);
        await route.fulfill({ json: asVerified(seen.get(id) ?? { id }) });
      },
    );
    await page.route(
      (url) => path(url, /^\/api\/(admin|organizations\/[^/]+)\/connections$/),
      (route) =>
        fetched(route, (body) => {
          for (const c of body.items ?? []) seen.set(c.id, c);
          body.items = (body.items ?? []).map((c: { id: string }) =>
            verified.has(c.id) ? asVerified(c) : c,
          );
        }),
    );
    await page.route(
      (url) => path(url, /^\/api\/management\/organizations\/[^/]+\/integrations$/),
      (route) =>
        fetched(route, (body) => {
          const connections = body.connections ?? [];
          body.connections = connections.map((c: { id: string; state: string }) =>
            verified.has(c.id) ? { ...c, state: later(c.state, false) } : c,
          );
          body.projects = (body.projects ?? []).map(
            (p: { id: string; integrations: Array<{ id: string; state: string }> }) => ({
              ...p,
              integrations: p.integrations.map((i) =>
                item(
                  p.id,
                  i,
                  connections.some(
                    (c: { id: string; projects?: Array<{ id: string; bound: boolean }> }) =>
                      i.id === `connection:${c.id}` &&
                      (c.projects ?? []).some((x) => x.id === p.id && x.bound),
                  ),
                ),
              ),
            }),
          );
        }),
    );
    await page.route(
      (url) => path(url, /^\/api\/management\/projects\/[^/]+\/integrations$/),
      (route) =>
        fetched(route, (body) => {
          const projectId = new URL(route.request().url()).pathname.split("/").at(-2)!;
          body.items = (body.items ?? []).map((i: { id: string; state: string }) =>
            item(projectId, i),
          );
        }),
    );
    return {
      /** The project shows the connection as bound (seen in the page). */
      bound: (projectId: string, connectionId: string) =>
        boundIn.add(`${projectId}/${connectionId}`),
    };
  }

  /** Adds a connection through the setup's own form; answers its id. */
  async function addConnection(
    page: Page,
    provider: string,
    label: string,
    baseUrl: string,
  ) {
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    // The guided setup offers only its provider, already chosen.
    const select = dialog.getByLabel(/^Provider/);
    await expect(select.locator("option")).toHaveText([provider]);
    await dialog.getByLabel(/^Label/).fill(label);
    await dialog.getByLabel(/^Base URL/).fill(baseUrl);
    await dialog.getByLabel(/^API key or token/).fill(DUMMY_KEY);
    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/connections$/.test(new URL(r.url()).pathname),
    );
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    const response = await created;
    expect(response.status(), `creating ${label}`).toBeLessThan(300);
    // Read at once: the body is gone after the next navigation.
    const { id } = (await response.json()) as { id: string };
    await expect(dialog).toHaveCount(0);
    await expect(connectionRow(page, label)).toBeVisible();
    return id;
  }

  /** Revokes every grant the panel may revoke, then removes the connection. */
  async function removeConnection(page: Page, label: string) {
    const row = connectionRow(page, label);
    await row.getByRole("button", { name: "Grants", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Grants · ${label}` });
    const revoke = dialog.getByRole("button", { name: "Revoke", exact: true });
    await expect(dialog.getByRole("table")).toBeVisible();
    for (let n = await revoke.count(); n > 0; n = await revoke.count()) {
      await revoke.first().click();
      await expect(revoke).toHaveCount(n - 1);
    }
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: `Remove: ${label}`, exact: true }).click();
    await expect(row).toHaveCount(0);
  }

  test("opens Integrations on the catalog in each scope", async ({ page }) => {
    for (const url of [
      "/manage/system/integrations",
      `/manage/o/${org().id}/integrations`,
      `/manage/p/${project().id}/integrations`,
    ]) {
      await page.goto(url);
      // The area address opens the catalog, marked in the section list.
      await expect(
        sectionNav(page).getByRole("link", { name: "All integrations", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("heading", { name: "All integrations", exact: true }),
      ).toBeVisible();
      const planned = page
        .getByRole("main")
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Not available yet", exact: true }) });
      await expect(planned.getByRole("heading", { name: "TikTok", exact: true })).toBeVisible();
      await expect(
        planned.getByText("Planned; there is nothing to set up yet.").first(),
      ).toBeVisible();
      // A planned provider offers nothing to click.
      await expect(planned.getByRole("link", { name: "Set up", exact: true })).toHaveCount(0);
      const postiz = card(page, "Postiz");
      await expect(postiz).toBeVisible();
      await expect(postiz.getByText(STATES).first()).toBeVisible();
      await expect(postiz.getByRole("link", { name: "Set up", exact: true })).toHaveAttribute(
        "href",
        `${new URL(url, origin).pathname}/setup/postiz`,
      );
    }
    // The system lists the server environment as state only.
    await page.goto("/manage/system/integrations");
    await expect(
      page.getByRole("heading", { name: "Server environment", exact: true }),
    ).toBeVisible();
  });

  test("never offers a setup for a planned provider or another scope's provider", async ({
    page,
  }) => {
    for (const id of ["tiktok", "openai", "social.app.meta", "nope"]) {
      await page.goto(`/manage/p/${project().id}/integrations/setup/${id}`);
      await expect(page.getByText("Not available").first(), id).toBeVisible();
      await expect(steps(page), id).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add connection" }), id).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Bind" }), id).toHaveCount(0);
      // Inside the frame: the switcher stays.
      await expect(page.getByLabel("Applies to")).toBeVisible();
    }
  });

  test("sets up a Matomo connection from the organization to the project", async ({
    page,
  }) => {
    test.skip(!connectionsOn, "ORBIT_CONNECTIONS is off");
    test.setTimeout(150_000);
    const target = await integrationsProject(page);
    const checks = await answerChecks(page);
    const label = `Matomo e2e ${RUN}`;
    const orgSetup = `/manage/o/${org().id}/integrations/setup/matomo`;

    await page.goto(orgSetup);
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Matomo", exact: true }),
    ).toBeVisible();
    await expect(step(page, "Choose provider")).toContainText("Done");
    await expect(step(page, "Configure connection or developer app")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect(step(page, "Configure connection or developer app")).toContainText("Your step");
    // An organization cannot see a project's final check.
    await expect(step(page, "Validate")).toContainText("Follows in the project");

    const id = await addConnection(page, "Matomo", label, "https://matomo.example.invalid");
    const row = connectionRow(page, label);
    await row.getByRole("button", { name: "Check", exact: true }).click();
    await expect(row).toContainText("read verified");
    await page.getByRole("button", { name: "Refresh state" }).click();
    await expect(step(page, "Check")).toContainText("Done");
    await expect(step(page, "Authorize organization and projects")).toHaveAttribute(
      "aria-current",
      "step",
    );

    await row.getByRole("button", { name: "Grants", exact: true }).click();
    const grants = page.getByRole("dialog", { name: `Grants · ${label}` });
    await grants.getByLabel(/^Project/).selectOption({ label: target.name });
    await grants.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(grants.getByRole("row").filter({ hasText: target.name })).toBeVisible();
    await grants.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Refresh state" }).click();
    await expect(step(page, "Authorize organization and projects")).toContainText("Done");
    await expect(step(page, "Assign account or channel")).toHaveAttribute("aria-current", "step");

    // The project binds the granted connection instead of entering a key.
    await page.goto(`/manage/p/${target.id}/integrations/setup/matomo`);
    const granted = page.locator(".data-row").filter({ hasText: label });
    await granted.getByRole("button", { name: "Bind", exact: true }).click();
    await expect(granted.getByText("bound", { exact: true })).toBeVisible();
    checks.bound(target.id, id);
    await page.getByRole("button", { name: "Refresh state" }).click();
    for (const name of [
      "Configure connection or developer app",
      "Check",
      "Authorize organization and projects",
      "Assign account or channel",
      "Validate",
    ])
      await expect(step(page, name), name).toContainText("Done");
    await expect(steps(page).locator("[aria-current=step]")).toHaveCount(0);

    await page.goto(`/manage/p/${target.id}/integrations`);
    await expect(
      card(page, "Matomo").getByRole("listitem").filter({ hasText: label }),
    ).toContainText("Ready");
    await page.goto(`/manage/o/${org().id}/integrations`);
    await expect(
      card(page, "Matomo").getByRole("listitem").filter({ hasText: label }),
    ).toContainText(`Used by: ${target.name} (bound)`);

    // Leave the organization as it was: grant revoked, connection removed.
    await page.goto(orgSetup);
    await removeConnection(page, label);
  });

  test("grants a system connection to an organization and from there to a project", async ({
    page,
  }) => {
    test.skip(!connectionsOn, "ORBIT_CONNECTIONS is off");
    test.setTimeout(150_000);
    expect(caps.system, "seeded user is administrator").toContain("system.connections");
    const target = await integrationsProject(page);
    const checks = await answerChecks(page);
    const label = `Postiz e2e ${RUN}`;
    const systemSetup = "/manage/system/integrations/setup/postiz";

    await page.goto(systemSetup);
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Postiz", exact: true }),
    ).toBeVisible();
    // The system cannot see project bindings: those steps follow there.
    await expect(step(page, "Assign account or channel")).toContainText("Follows in the project");
    await expect(step(page, "Validate")).toContainText("Follows in the project");
    const id = await addConnection(page, "Postiz", label, "https://postiz.example.invalid");
    const row = connectionRow(page, label);
    await row.getByRole("button", { name: "Check", exact: true }).click();
    await expect(row).toContainText("read verified");

    await row.getByRole("button", { name: "Grants", exact: true }).click();
    const grants = page.getByRole("dialog", { name: `Grants · ${label}` });
    await grants.getByLabel("Organization").selectOption({ label: org().name });
    await grants.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(grants.getByRole("row").filter({ hasText: org().name })).toBeVisible();
    await grants.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Refresh state" }).click();
    for (const name of [
      "Configure connection or developer app",
      "Check",
      "Authorize organization and projects",
    ])
      await expect(step(page, name), name).toContainText("Done");
    await expect(steps(page).locator("[aria-current=step]")).toHaveCount(0);

    // The organization owner grants the system connection on to the project.
    await page.goto(`/manage/o/${org().id}/integrations/setup/postiz`);
    const orgRow = connectionRow(page, label);
    await expect(orgRow).toContainText("System");
    await orgRow.getByRole("button", { name: "Grants", exact: true }).click();
    const orgGrants = page.getByRole("dialog", { name: `Grants · ${label}` });
    await orgGrants.getByLabel(/^Project/).selectOption({ label: target.name });
    await orgGrants.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(orgGrants.getByRole("row").filter({ hasText: target.name })).toBeVisible();
    await orgGrants.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Refresh state" }).click();
    await expect(step(page, "Authorize organization and projects")).toContainText("Done");

    await page.goto(`/manage/p/${target.id}/integrations/setup/postiz`);
    const granted = page.locator(".data-row").filter({ hasText: label });
    await expect(granted).toContainText("System");
    await granted.getByRole("button", { name: "Bind", exact: true }).click();
    await expect(granted.getByText("bound", { exact: true })).toBeVisible();
    checks.bound(target.id, id);
    await page.getByRole("button", { name: "Refresh state" }).click();
    await expect(step(page, "Validate")).toContainText("Done");
    await expect(steps(page).locator("[aria-current=step]")).toHaveCount(0);

    await page.goto(`/manage/p/${target.id}/integrations`);
    await expect(
      card(page, "Postiz").getByRole("listitem").filter({ hasText: label }),
    ).toContainText("Ready");

    // Revoking the organization's grant ends the project's grant with it.
    await page.goto(systemSetup);
    await removeConnection(page, label);
  });

  test("shows a viewer states without actions", async ({ page }) => {
    // The seeded installation has one person (system administrator and
    // organization owner) and no way to add a viewer without the database,
    // so this runs as the least privileged member there is: states read as
    // text, and the key never comes back to any page.
    test.skip(!connectionsOn, "ORBIT_CONNECTIONS is off");
    test.setTimeout(120_000);
    const target = await integrationsProject(page);
    const label = `Matomo key check ${RUN}`;
    const orgSetup = `/manage/o/${org().id}/integrations/setup/matomo`;
    await page.goto(orgSetup);
    await addConnection(page, "Matomo", label, "https://matomo.example.invalid");
    const row = connectionRow(page, label);
    await row.getByRole("button", { name: "Grants", exact: true }).click();
    const grants = page.getByRole("dialog", { name: `Grants · ${label}` });
    await grants.getByLabel(/^Project/).selectOption({ label: target.name });
    await grants.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(grants.getByRole("row").filter({ hasText: target.name })).toBeVisible();
    await grants.getByRole("button", { name: "Close dialog" }).click();

    for (const url of [
      `/manage/p/${target.id}/integrations`,
      `/manage/p/${target.id}/integrations/setup/matomo`,
      `/manage/p/${target.id}/integrations/connections`,
      `/manage/o/${org().id}/integrations`,
      orgSetup,
      `/manage/o/${org().id}/integrations/connections`,
    ]) {
      await page.goto(url);
      await expect(page.getByText(label).first(), url).toBeVisible();
      expect(await page.locator("body").innerText(), url).not.toContain(DUMMY_KEY);
      expect(await page.content(), url).not.toContain(DUMMY_KEY);
    }
    // Not checked: the state says so in words, not only by colour.
    await page.goto(`/manage/p/${target.id}/integrations`);
    await expect(
      card(page, "Matomo").getByRole("listitem").filter({ hasText: label }),
    ).toContainText("Stored, not checked");

    await page.goto(orgSetup);
    await removeConnection(page, label);
  });

  test("hides a disabled module's integration section", async ({ page }) => {
    const id = project().id;
    const base = `/api/projects/${encodeURIComponent(id)}/modules`;
    const list = (await page.request.get(base).then((r) => r.json())) as {
      switchable: boolean;
      modules: Array<{ id: string; enabled: boolean }>;
    };
    const put = (moduleId: string, enabled: boolean) =>
      page.request.put(`${base}/${encodeURIComponent(moduleId)}`, {
        headers: { origin },
        data: { enabled },
      });
    const social = list.modules.find((m) => m.id === "social");
    const switchSocial = list.switchable && social?.enabled === true;
    if (!switchSocial)
      test.info().annotations.push({
        type: "social",
        description: social
          ? "Social is off for the project; checked as it is"
          : "Social is not installed; checked as it is",
      });
    if (switchSocial) expect((await put("social", false)).status(), "social off").toBe(200);
    try {
      await page.goto(`/manage/p/${id}/integrations`);
      await expect(sectionNav(page)).toBeVisible();
      await expect(
        sectionNav(page).getByRole("link", { name: "All integrations", exact: true }),
      ).toBeVisible();
      await expect(
        sectionNav(page).getByRole("link", { name: "Social accounts", exact: true }),
      ).toHaveCount(0);
      await page.goto(`/manage/p/${id}/integrations/social/accounts`);
      await expect(page.getByText("Not available").first()).toBeVisible();
    } finally {
      if (switchSocial)
        expect((await put("social", true)).ok(), "social switched back on").toBe(true);
    }

    // Marketing owns Matomo: with Marketing off its card no longer leads to a
    // page that cannot manage it.
    const marketing = list.modules.find((m) => m.id === "marketing");
    if (!list.switchable || !marketing?.enabled) {
      test.info().annotations.push({
        type: "marketing",
        description: "Marketing cannot be switched here; its part is not checked",
      });
      return;
    }
    await page.goto(`/manage/p/${id}/integrations`);
    await expect(
      card(page, "Matomo").getByRole("link", { name: "Manage", exact: true }),
    ).toHaveAttribute("href", `/manage/p/${id}/integrations/connections`);
    expect((await put("marketing", false)).status(), "marketing off").toBe(200);
    try {
      await page.goto(`/manage/p/${id}/integrations`);
      await expect(card(page, "Matomo")).toContainText("Managed in its module.");
      await expect(
        card(page, "Matomo").getByRole("link", { name: "Manage", exact: true }),
      ).toHaveCount(0);
    } finally {
      expect((await put("marketing", true)).ok(), "marketing switched back on").toBe(true);
    }
  });

  test("returns from Google Drive into the connected project", async ({ page }) => {
    const target = await integrationsProject(page);
    const other = (JSON.parse(readFileSync(SEED, "utf8")) as { projectId: string }).projectId;
    expect(target.id).not.toBe(other);
    // The last project opened is another one.
    await page.goto(`/p/${other}/settings`);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("orbit.project"))).toBe(other);

    // Where the Drive callback sends the member back.
    await page.goto(`/p/${target.id}/settings?googleDrive=ready`);
    await expect(page).toHaveURL(new RegExp(`/p/${target.id}/settings`));
    await expect(
      sectionNav(page).getByRole("link", { name: "Integrations", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#project")).toHaveValue(target.id);
  });

  test("keeps the old connectors and social pages", async ({ page }) => {
    const id = project().id;
    await page.goto(`/p/${id}/connectors`);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1, name: "Connectors" }),
    ).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);
    // The old page lists mailboxes flat: no mail server groups.
    await expect(page.getByRole("heading", { name: /^Mail server / })).toHaveCount(0);
    // The center's connections section renders the same cards.
    await page.goto(`/manage/p/${id}/integrations/connections`);
    await expect(
      sectionNav(page).getByRole("link", { name: "Connections", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Not available")).toHaveCount(0);

    const modules = (await page.request
      .get(`/api/projects/${encodeURIComponent(id)}/modules`)
      .then((r) => r.json())) as { modules: Array<{ id: string; enabled: boolean }> };
    const social = modules.modules.some((m) => m.id === "social" && m.enabled);
    if (!social) {
      test.info().annotations.push({
        type: "social",
        description: "Social is not on for the project; its old page does not exist here",
      });
      return;
    }
    await page.goto(`/p/${id}/social/accounts`);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);
  });
});
