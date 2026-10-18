import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Web shell and navigation (WP1.7, UI restructure): pickers, project home,
// every page by URL, the grouped and collapsible sidebar, legacy redirects,
// not-found pages, mobile bar, keyboard and DE/EN labels.

function account() {
  return JSON.parse(
    readFileSync(resolve(".runtime/e2e-user.json"), "utf8"),
  ) as { email: string; password: string; projectId: string };
}

async function signIn(page: Page) {
  const user = account();
  await page.goto("/");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel(/^Email/).fill(user.email);
    await page.getByLabel(/^Password/).fill(user.password);
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/auth/sign-in/email"),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    if ((await response).status() !== 429) break;
    await page.waitForTimeout(10_500);
  }
  // The start page opens the last or only project, else a picker.
  await page.waitForURL(/\/(p|o)(\/|$)/);
  return user;
}

// The load event comes before the shell has rendered and stored the project as
// the last used one; wait for the home itself.
async function openHome(page: Page, base: string) {
  await page.goto(base);
  await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
}

// Every page of the shell, by its sidebar label and its URL below the project,
// in sidebar order: the top entries, the module groups (approvals sit in
// Marketing), then the project group.
const PAGES: Array<[string, string]> = [
  ["Home", ""],
  ["Orbit Chat", "/assistant"],
  ["Missions", "/marketing/missions"],
  ["Content Studio", "/marketing/content"],
  ["Calendar", "/marketing/calendar"],
  ["Approvals", "/approvals"],
  ["Assets", "/marketing/assets"],
  ["Analytics", "/marketing/analytics"],
  ["Memory", "/marketing/memory"],
  ["Overview", "/knowledge"],
  ["Sources", "/knowledge/sources"],
  ["Facts", "/knowledge/facts"],
  ["Conflicts", "/knowledge/conflicts"],
  ["Import", "/knowledge/import"],
  ["Library", "/knowledge/library"],
  ["Connectors", "/connectors"],
  ["Operations", "/operations"],
  ["Settings", "/settings"],
];

// The 13 paths from before WP1.7 and the page each one opens now.
const LEGACY: Array<[string, string]> = [
  ["/", ""],
  ["/missions", "/marketing/missions"],
  ["/chat", "/assistant"],
  ["/content", "/marketing/content"],
  ["/calendar", "/marketing/calendar"],
  ["/knowledge", "/knowledge"],
  ["/assets", "/marketing/assets"],
  ["/approvals", "/approvals"],
  ["/analytics", "/marketing/analytics"],
  ["/memory", "/marketing/memory"],
  ["/connectors", "/connectors"],
  ["/operations", "/operations"],
  ["/settings", "/settings"],
];

test("pickers, project home and every page have their own URL", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const user = await signIn(page);
  const me = await (await page.request.get("/api/me")).json();
  const project = me.projects.find(
    (p: { id: string }) => p.id === user.projectId,
  );

  // Organization and project pickers.
  await page.goto("/o");
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(me.workspaces[0].name) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/o/${project.workspaceId}$`));
  await expect(
    page.getByRole("heading", { name: "Choose a project" }),
  ).toBeVisible();
  await page.locator(`a[href="/p/${user.projectId}"]`).click();

  // Project home: assistant prompt, module tiles and the marketing section.
  const base = `/p/${user.projectId}`;
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(
    page.getByRole("heading", { level: 1, name: project.name }),
  ).toBeVisible();
  await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
  await expect(
    page.locator('.module-tile[data-module="marketing"]'),
  ).toBeVisible();
  await expect(
    page.locator('.module-tile[data-module="knowledge"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your marketing, in orbit." }),
  ).toBeVisible();

  // Every page from the sidebar, in order; the URL is shareable.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link")).toHaveText(PAGES.map(([name]) => name));
  for (const [name, path] of PAGES) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}${path}$`));
    await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("Page not found")).toHaveCount(0);
  }
  // The module groups and the project group, each with its entries.
  for (const group of ["Marketing", "Knowledge", "Project"])
    await expect(
      nav.getByRole("button", { name: new RegExp(`^${group}`) }),
    ).toHaveAttribute("aria-expanded", "true");
  // Deep links survive a reload: one platform page and one module page.
  // Not every page: the whole suite shares one client address and the API's
  // read limit (600 per minute).
  for (const [name, path] of [
    ["Settings", "/settings"],
    ["Calendar", "/marketing/calendar"],
  ]) {
    await page.goto(`${base}${path}`);
    await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  // A module root opens the module's first page.
  await page.goto(`${base}/marketing`);
  await expect(page).toHaveURL(new RegExp(`${base}/marketing/missions$`));
});

test("legacy paths redirect, unknown paths say so", async ({ page }) => {
  test.setTimeout(120_000);
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);
  for (const [old, now] of LEGACY) {
    await page.goto(old);
    await expect(page, old).toHaveURL(new RegExp(`${base}${now}$`));
  }
  // Query and hash survive the redirect (the Google Drive callback uses one).
  await page.goto("/settings?googleDrive=ready");
  await expect(page).toHaveURL(
    new RegExp(`${base}/settings\\?googleDrive=ready$`),
  );

  await page.goto(`${base}/nope`);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to start" }),
  ).toHaveAttribute("href", base);
  await page.goto("/nope/deeper");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await page.goto(`/p/${randomUUID()}`);
  await expect(
    page.getByRole("heading", { name: "Project not available" }),
  ).toBeVisible();
});

test("home prompt opens the chat without sending, 390px, keyboard and German", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);

  // The prompt is handed to the chat for review; nothing is sent.
  const text = `Navigation acceptance ${Date.now()}`;
  await page.getByLabel("Message for Orbit Chat").fill(text);
  await page.getByRole("button", { name: "Continue in chat" }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/assistant$`));
  await expect(page.getByLabel("Message Orbit")).toHaveValue(text);
  await expect(page.locator(".chat-message", { hasText: text })).toHaveCount(0);

  // Keyboard: the skip link leads to the content, links open with Enter.
  await openHome(page, base);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Approvals", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${base}/approvals$`));

  // 390px: the bottom bar comes from the manifests, no horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page, base);
  const mobile = page.getByRole("navigation", { name: "Mobile workspace" });
  await expect(mobile.getByRole("link")).toHaveText([
    "Home",
    "Orbit Chat",
    "Approvals",
    "Content",
  ]);
  await expect(mobile.getByRole("button", { name: "More" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await mobile.getByRole("link", { name: "Content" }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/marketing/content$`));

  // German labels in the shell.
  await page.getByRole("button", { name: "DE", exact: true }).click();
  await expect(mobile.getByRole("link")).toHaveText([
    "Start",
    "Orbit Chat",
    "Freigaben",
    "Inhalte",
  ]);
  await expect(mobile.getByRole("button", { name: "Mehr" })).toBeVisible();
  await page.goto(`${base}/nope`);
  await expect(
    page.getByRole("heading", { name: "Seite nicht gefunden" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "EN", exact: true }).click();
});

const COLLAPSED_KEY = "orbit.nav.collapsed";

test("sidebar groups collapse and stay collapsed after reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const marketing = nav.getByRole("button", { name: /^Marketing/ });
  const knowledge = nav.getByRole("button", { name: /^Knowledge/ });
  const missions = nav.getByRole("link", { name: "Missions", exact: true });

  // All groups are open by default.
  await expect(marketing).toHaveAttribute("aria-expanded", "true");
  await expect(knowledge).toHaveAttribute("aria-expanded", "true");
  await expect(missions).toBeVisible();

  // Collapsing hides the entries of that group only.
  await marketing.click();
  await expect(marketing).toHaveAttribute("aria-expanded", "false");
  await expect(missions).toBeHidden();
  await expect(
    nav.getByRole("link", { name: "Sources", exact: true }),
  ).toBeVisible();

  // The state is remembered in this browser: still collapsed on Home after a
  // reload (wait for the shell before looking for the missing link).
  await page.reload();
  await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
  await expect(marketing).toHaveAttribute("aria-expanded", "false");
  await expect(missions).toBeHidden();
  await expect(knowledge).toHaveAttribute("aria-expanded", "true");

  // The header opens the group again.
  await marketing.click();
  await expect(marketing).toHaveAttribute("aria-expanded", "true");
  await expect(missions).toBeVisible();
});

test("navigating to a page opens its collapsed group", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const marketing = nav.getByRole("button", { name: /^Marketing/ });
  const missions = nav.getByRole("link", { name: "Missions", exact: true });

  // Marketing is collapsed in storage, then a deep link opens one of its pages.
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify(["marketing"])),
    COLLAPSED_KEY,
  );
  await page.goto(`${base}/marketing/missions`);
  await expect(marketing).toHaveAttribute("aria-expanded", "true");
  await expect(missions).toBeVisible();
  await expect(missions).toHaveAttribute("aria-current", "page");

  // The page opened the group for good: the storage no longer lists it.
  expect(
    await page.evaluate((key) => localStorage.getItem(key), COLLAPSED_KEY),
  ).toBe("[]");

  // The open page's group is not locked: its header still collapses it.
  await marketing.click();
  await expect(marketing).toHaveAttribute("aria-expanded", "false");
  await expect(missions).toBeHidden();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), COLLAPSED_KEY),
  ).toBe(JSON.stringify(["marketing"]));

  // Navigating to another page of that group opens it again.
  await page.goto(`${base}/marketing/calendar`);
  await expect(marketing).toHaveAttribute("aria-expanded", "true");
  await expect(
    nav.getByRole("link", { name: "Calendar", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("mobile bar shows Home, Chat and two module entries plus More", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page, base);
  const mobile = page.getByRole("navigation", { name: "Mobile workspace" });
  await expect(mobile.getByRole("link")).toHaveText([
    "Home",
    "Orbit Chat",
    "Approvals",
    "Content",
  ]);
  await expect(mobile.getByRole("button", { name: "More" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();

  // The drawer behind "More" shows the grouped sidebar.
  await mobile.getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("navigation", { name: "Workspace" });
  await expect(
    drawer.getByRole("button", { name: /^Marketing/ }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: /^Knowledge/ }),
  ).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Project/ })).toBeVisible();
});
