import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Web shell and navigation (WP1.7, UI restructure): pickers, project home,
// every page by URL, the grouped and collapsible sidebar, legacy redirects,
// not-found pages, mobile bar, keyboard and DE/EN labels.

// With the support module on (E2E_SUPPORT=1), its Tickets entry takes the
// bottom bar's third place (rank 20) and Content drops off.
const SUPPORT = process.env.E2E_SUPPORT === "1";
// Marketing's Plans and Assignments pages show only while Orbit Agents is on
// (ORBIT_AGENTS; e9c5d9d). E2E_AGENTS=1 declares an agents-enabled stack.
const AGENTS = process.env.E2E_AGENTS === "1";
const agentPage = (name: string, path: string): [string, string, string] => [
  "marketing",
  name,
  path,
];
const BAR = SUPPORT
  ? ["Home", "Orbit Chat", "Tickets", "Approvals"]
  : ["Home", "Orbit Chat", "Approvals", "Content"];

// A navigation entry's text or accessible name, with or without its
// attention badge ("Tickets 2 to do"; UI restructure §4.4): the counts depend
// on the stack's data.
function badged(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s?!?\\d+\\s.*)?$`);
}

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

// Every page of the shell, by its sidebar group, label and URL below the
// project, in sidebar order: the top entries, the module groups (approvals sit
// in Marketing), then the project group. Marketing and Knowledge both have an
// "Overview", so a link is looked up inside its group's list. The support
// group (groupOrder 20) shows only on a support-enabled stack.
const SUPPORT_PAGES: Array<[group: string, name: string, path: string]> = [
  ["support", "Overview", "/support"],
  ["support", "Tickets", "/support/tickets"],
  ["support", "Contacts", "/support/contacts"],
  ["support", "Statistics", "/support/stats"],
];
const PAGES: Array<[group: string, name: string, path: string]> = [
  ["top", "Home", ""],
  ["top", "Orbit Chat", "/assistant"],
  ["marketing", "Overview", "/marketing"],
  ...(AGENTS ? [agentPage("Plans", "/marketing/plans")] : []),
  ["marketing", "Missions", "/marketing/missions"],
  ...(AGENTS ? [agentPage("Assignments", "/marketing/assignments")] : []),
  ["marketing", "Content Studio", "/marketing/content"],
  ["marketing", "Calendar", "/marketing/calendar"],
  ["marketing", "Approvals", "/approvals"],
  ["marketing", "Assets", "/marketing/assets"],
  ["marketing", "Analytics", "/marketing/analytics"],
  ["marketing", "Memory", "/marketing/memory"],
  ...(SUPPORT ? SUPPORT_PAGES : []),
  ["knowledge", "Overview", "/knowledge"],
  ["knowledge", "Sources", "/knowledge/sources"],
  ["knowledge", "Facts", "/knowledge/facts"],
  ["knowledge", "Conflicts", "/knowledge/conflicts"],
  ["knowledge", "Import", "/knowledge/import"],
  ["knowledge", "Library", "/knowledge/library"],
  ["project", "App approvals", "/decisions"],
  ["project", "Connectors", "/connectors"],
  ["project", "Operations", "/operations"],
  ["project", "Settings", "/settings"],
];

// The sidebar's links in order: PAGES, with each module group ending in its
// settings link (spec §3.4; its name carries the group: "Marketing Settings").
// Knowledge has no settings section.
const SIDEBAR_LINKS = PAGES.flatMap(([group, name], i) => {
  const last = PAGES[i + 1]?.[0] !== group;
  return last && (group === "marketing" || group === "support")
    ? [badged(name), `${group[0]!.toUpperCase()}${group.slice(1)} Settings`]
    : [badged(name)];
});

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

  // Project home: greeting, assistant prompt, status strip, the attention
  // list and the module cards; the project's name is in the breadcrumb.
  const base = `/p/${user.projectId}`;
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^Good (morning|afternoon|evening)\b/,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".breadcrumb").getByText(project.name, { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message for Orbit Chat")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View operations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Needs your attention" }),
  ).toBeVisible();
  await expect(page.locator(".module-tile")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 2, name: "Marketing · in progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "System status" }),
  ).toBeVisible();

  // Every page from the sidebar, in order; the URL is shareable.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link")).toHaveText(SIDEBAR_LINKS);
  const entry = (group: string, name: string) =>
    (group === "top" ? nav : nav.locator(`#nav-group-${group}`)).getByRole(
      "link",
      { name: badged(name) },
    );
  for (const [group, name, path] of PAGES) {
    await entry(group, name).click();
    await expect(page).toHaveURL(new RegExp(`${base}${path}$`));
    await expect(entry(group, name)).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Page not found")).toHaveCount(0);
  }
  // The tab title carries the group, so the two "Overview" pages differ.
  for (const [group, path] of [
    ["Marketing", "/marketing"],
    ["Knowledge", "/knowledge"],
  ])
    await test.step(`${group} overview title`, async () => {
      await page.goto(`${base}${path}`);
      await expect(page).toHaveTitle(
        new RegExp(`^${group} / Overview · ${project.name} · EDS Orbit$`),
      );
    });
  // The module groups and the project group, each with its entries.
  for (const group of ["Marketing", "Knowledge", "Project"])
    await expect(
      nav.getByRole("button", { name: new RegExp(`^${group}`) }),
    ).toHaveAttribute("aria-expanded", "true");
  // Deep links survive a reload: one platform page and one module page.
  // Not every page: the whole suite shares one client address and the API's
  // read limit (600 per minute).
  for (const [group, name, path] of [
    ["project", "Settings", "/settings"],
    ["marketing", "Calendar", "/marketing/calendar"],
  ]) {
    await page.goto(`${base}${path}`);
    await expect(entry(group, name)).toHaveAttribute("aria-current", "page");
  }

  // The module root is the module's overview, not a redirect to a page.
  await page.goto(`${base}/marketing`);
  await expect(page).toHaveURL(new RegExp(`${base}/marketing$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Marketing" }),
  ).toBeVisible();
  await expect(entry("marketing", "Overview")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("module settings links open their section of the grouped settings", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  const current = sections.locator('[aria-current="page"]');
  // A full load would drop this marker; section changes happen in place.
  await page.evaluate(() => ((window as any).orbitMarker = 1));

  // Marketing's settings link opens its first section, policy & budget.
  await nav
    .getByRole("link", { name: "Marketing Settings", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`${base}/settings\\?section=policy$`),
  );
  await expect(current).toHaveText("Publishing rules");
  await expect(
    page.getByRole("heading", { name: "Versioned operating policy" }),
  ).toBeVisible();
  // The settings list: Project first, then the modules in sidebar order.
  await expect(sections.getByRole("heading", { level: 2 })).toHaveText(
    SUPPORT ? ["Project", "Marketing", "Support"] : ["Project", "Marketing"],
  );
  // The platform's sections (then Connected apps while the stack's OAuth
  // server is on).
  const projectLinks = sections
    .getByRole("list", { name: "Project" })
    .getByRole("link");
  for (const [i, name] of [
    "Project",
    "Members & roles",
    "Integrations",
    "AI & budget",
    "Retention",
    "Modules",
  ].entries())
    await expect(projectLinks.nth(i)).toHaveText(name);
  // Marketing: policy & budget, brand (then assignments with Orbit Agents).
  const marketingLinks = sections
    .getByRole("list", { name: "Marketing" })
    .getByRole("link");
  await expect(marketingLinks.nth(0)).toHaveText("Publishing rules");
  await expect(marketingLinks.nth(1)).toHaveText("Brand");

  // Picking a section replaces the URL in place: no new history entry.
  await sections.getByRole("link", { name: "Brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/settings\\?section=brand$`));
  await expect(current).toHaveText("Brand");
  if (SUPPORT) {
    await nav
      .getByRole("link", { name: "Support Settings", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`${base}/settings\\?section=support$`),
    );
    await expect(current).toHaveText("Support");
    // Back returns to the section the link was followed from.
    await page.goBack();
    await expect(page).toHaveURL(
      new RegExp(`${base}/settings\\?section=brand$`),
    );
    await expect(current).toHaveText("Brand");
  }
  await sections.getByRole("link", { name: "Retention", exact: true }).click();
  await expect(current).toHaveText("Retention");
  await expect(
    page.getByRole("heading", { name: "Memory retention" }),
  ).toBeVisible();
  // Back leaves the settings: the section changes replaced their entry.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await page.goForward();
  await expect(page).toHaveURL(
    new RegExp(`${base}/settings\\?section=retention$`),
  );
  await expect(current).toHaveText("Retention");
  expect(await page.evaluate(() => (window as any).orbitMarker)).toBe(1);

  // An unknown section opens the project section.
  await page.goto(`${base}/settings?section=nope`);
  await expect(current).toHaveText("Project");
  await expect(
    page.getByRole("heading", { name: "Autopilot readiness" }),
  ).toBeVisible();
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
  await expect(mobile.getByRole("link")).toHaveText(BAR.map(badged));
  await expect(mobile.getByRole("button", { name: "More" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await mobile.getByRole("link", { name: badged(BAR[3]!) }).click();
  await expect(page).toHaveURL(
    new RegExp(`${base}/${SUPPORT ? "approvals" : "marketing/content"}$`),
  );

  // German labels in the shell.
  await page.getByRole("button", { name: "DE", exact: true }).click();
  await expect(mobile.getByRole("link")).toHaveText(
    SUPPORT
      ? ["Start", "Orbit Chat", "Tickets", "Freigaben"].map(badged)
      : ["Start", "Orbit Chat", "Freigaben", "Inhalte"].map(badged),
  );
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
  await expect(mobile.getByRole("link")).toHaveText(BAR.map(badged));
  await expect(mobile.getByRole("button", { name: "More" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();

  // The closed sidebar sits off-screen; "More" opens it as a dialog with the
  // grouped sidebar.
  await expect(page.locator("aside.sidebar")).not.toBeInViewport();
  await mobile.getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeInViewport();
  // The drawer scrolls; each group header is reachable in it.
  for (const group of ["Marketing", "Knowledge", "Project"]) {
    const header = drawer.getByRole("button", {
      name: new RegExp(`^${group}`),
    });
    await header.scrollIntoViewIfNeeded();
    await expect(header).toBeInViewport();
  }
});

test("support group lists Overview, Tickets, Contacts and Statistics", async ({
  page,
}) => {
  // Needs a stack with the support module on, like support-widget.spec.ts.
  test.skip(
    process.env.E2E_SUPPORT !== "1",
    "needs a support-enabled stack (E2E_SUPPORT=1)",
  );
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  const user = await signIn(page);
  const base = `/p/${user.projectId}`;
  await openHome(page, base);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const group = nav.locator("#nav-group-support");
  // The group ends with its settings link (spec §3.4).
  await expect(group.getByRole("link")).toHaveText([
    ...["Overview", "Tickets", "Contacts", "Statistics"].map(badged),
    "Support Settings",
  ]);
  await expect(
    group.getByRole("link", { name: "Support Settings", exact: true }),
  ).toHaveAttribute("href", `${base}/settings?section=support`);
  for (const [name, path] of [
    ["Overview", "/support"],
    ["Tickets", "/support/tickets"],
    ["Contacts", "/support/contacts"],
    ["Statistics", "/support/stats"],
  ]) {
    await group.getByRole("link", { name: badged(name!) }).click();
    await expect(page).toHaveURL(new RegExp(`${base}${path}$`));
    await expect(
      group.getByRole("link", { name: badged(name!) }),
    ).toHaveAttribute("aria-current", "page");
  }

  // On the bottom bar the Tickets entry points at the inbox, not the overview.
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page, base);
  const mobile = page.getByRole("navigation", { name: "Mobile workspace" });
  await expect(mobile.getByRole("link")).toHaveText(
    ["Home", "Orbit Chat", "Tickets", "Approvals"].map(badged),
  );
  await expect(
    mobile.getByRole("link", { name: badged("Tickets") }),
  ).toHaveAttribute("href", `${base}/support/tickets`);
  // Ruling R12: Tickets is current on every page of the support group.
  for (const path of [
    "/support",
    "/support/tickets",
    "/support/contacts",
    "/support/stats",
  ]) {
    await page.goto(`${base}${path}`);
    await expect(
      mobile.getByRole("link", { name: badged("Tickets") }),
      path,
    ).toHaveAttribute("aria-current", "page");
  }
});
