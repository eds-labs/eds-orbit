import { test, expect, type Page, type Request } from "./fixtures";
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
});
