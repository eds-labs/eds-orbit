import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "./fixtures";
import type { HomeLayout } from "../src/platform/shell/home-layout";

// Run on an isolated Orbit stack with ORBIT_HOME_WIDGETS, ORBIT_MODULES,
// ORBIT_SOCIAL, ORBIT_WEBMAIL, ORBIT_ADS and ORBIT_CMS enabled and an E2E user.
test.skip(
  process.env.E2E_HOME_WIDGETS !== "1",
  "requires an isolated widget stack",
);

const user = () =>
  JSON.parse(readFileSync(".runtime/e2e-user.json", "utf8")) as {
    email: string;
    password: string;
    projectId: string;
  };
const card = (page: Page, id: string) =>
  page.locator(`li[data-widget="${id}"]`);
const order = (page: Page) =>
  page
    .locator("li[data-widget]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-widget")),
    );

async function openHome(page: Page, signIn = false) {
  const { email, password, projectId } = user();
  await page.goto(`/p/${projectId}`);
  if (signIn) {
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Password/).fill(password);
    const submit = async () => {
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/auth/sign-in/email" &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      return response;
    };
    let answer = await submit();
    if (answer.status() === 429) {
      // Share a session across desktop tests and observe the remaining
      // sign-in throttle when repeating the suite or using a second device.
      const seconds = Math.min(
        60,
        Math.max(1, Number(answer.headers()["retry-after"]) || 11),
      );
      await page.waitForTimeout(seconds * 1000);
      answer = await submit();
    }
    expect(answer.status()).toBe(200);
  }
  await expect(
    page.getByRole("button", { name: "Customize dashboard" }),
  ).toBeVisible();
}

let desktopCookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await openHome(await context.newPage(), true);
    desktopCookies = await context.cookies();
  } finally {
    await context.close();
  }
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(desktopCookies);
});

async function changeLayout(page: Page, widgets: HomeLayout["widgets"]) {
  const path = `/api/projects/${user().projectId}/home-layout`;
  const get = await page.request.get(path);
  expect(get.ok()).toBe(true);
  const { revision } = (await get.json()) as HomeLayout;
  const put = await page.request.put(path, {
    headers: { origin: new URL(page.url()).origin },
    data: { revision, widgets },
  });
  expect(put.ok()).toBe(true);
}
async function setModule(page: Page, moduleId: string, enabled: boolean) {
  const response = await page.request.put(
    `/api/projects/${user().projectId}/modules/${moduleId}`,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { enabled },
    },
  );
  expect(response.ok(), `set module ${moduleId}: ${response.status()}`).toBe(
    true,
  );
}
async function otherProject(page: Page) {
  const name = "Widget layout isolation project";
  const identity = await page.request.get("/api/me");
  expect(identity.ok()).toBe(true);
  const { projects } = (await identity.json()) as {
    projects: Array<{ id: string; name: string }>;
  };
  const existing = projects.find((project) => project.name === name);
  if (existing) return existing.id;
  const created = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name, timezone: "Europe/Berlin", language: "en" },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id as string;
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Customize dashboard" }),
  ).toBeVisible();
}

async function drag(
  page: Page,
  from: string,
  to: string,
  context?: BrowserContext,
) {
  const start = page.getByRole("button", {
    name: `Move widget: ${from}`,
    exact: true,
  });
  const end = page.getByRole("button", {
    name: `Move widget: ${to}`,
    exact: true,
  });
  await start.scrollIntoViewIfNeeded();
  const a = await start.boundingBox();
  const b = await end.boundingBox();
  if (!a || !b) throw new Error("Widget drag handles must be visible");
  const x = a.x + a.width / 2;
  const y = a.y + a.height / 2;
  const endX = b.x + b.width / 2;
  const endY = b.y + b.height / 2;
  if (!context) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();
    return;
  }
  const client = await context.newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    // Wait for the configured touch sensor activation delay.
    await expect(start).toHaveAttribute("aria-pressed", "true");
    for (let step = 1; step <= 8; step++)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: x + ((endX - x) * step) / 8, y: y + ((endY - y) * step) / 8 },
        ],
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

test("catalog, mouse and keyboard placement, device sync, and module gating", async ({
  page,
  browser,
}) => {
  await openHome(page);
  for (const moduleId of ["social", "webmail", "ads", "cms"])
    await setModule(page, moduleId, true);
  await changeLayout(page, [
    { id: "platform.system-status", size: "compact" },
    { id: "marketing.overview", size: "compact" },
  ]);
  await page.reload();

  const edit = page.getByRole("button", { name: "Customize dashboard" });
  await edit.click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "Widget catalog" });
  for (const name of [
    "Scheduled social posts",
    "Shared mailboxes",
    "Ad accounts",
    "Content and publishing",
  ])
    await expect(
      catalog.getByRole("button", { name: `Add widget: ${name}` }),
    ).toBeVisible();
  await catalog
    .getByRole("button", { name: "Add widget: Scheduled social posts" })
    .click();
  await expect(card(page, "social.upcoming")).toBeVisible();

  await drag(page, "System status", "Marketing");
  await expect
    .poll(() => order(page))
    .toEqual([
      "marketing.overview",
      "platform.system-status",
      "social.upcoming",
    ]);
  const systemHandle = page.getByRole("button", {
    name: "Move widget: System status",
  });
  await systemHandle.focus();
  await page.keyboard.press("Space");
  await expect(systemHandle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByText("System status at position 1 of 3."),
  ).toBeAttached();
  await page.keyboard.press("Space");
  await expect(systemHandle).toBeFocused();
  await expect
    .poll(() => order(page))
    .toEqual([
      "platform.system-status",
      "marketing.overview",
      "social.upcoming",
    ]);
  await page
    .getByRole("combobox", { name: "Size: Scheduled social posts" })
    .selectOption("wide");
  await save(page);
  await expect(card(page, "social.upcoming")).toHaveAttribute(
    "data-size",
    "wide",
  );

  const mobile = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const phone = await mobile.newPage();
    await openHome(phone, true);
    await expect.poll(() => order(phone)).toEqual(await order(page));
    await expect(card(phone, "social.upcoming")).toHaveAttribute(
      "data-size",
      "wide",
    );
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await phone.getByRole("button", { name: "Customize dashboard" }).click();
    await drag(phone, "System status", "Marketing", mobile);
    await expect
      .poll(() => order(phone))
      .toEqual([
        "marketing.overview",
        "platform.system-status",
        "social.upcoming",
      ]);
    // dnd-kit suppresses the synthetic release click for 50 ms after a drag.
    await phone.waitForTimeout(60);
    await phone.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect.poll(() => order(phone)).toEqual(await order(page));
  } finally {
    await mobile.close();
  }

  const secondProject = await otherProject(page);
  await page.reload();
  const projectPicker = page.getByRole("combobox", {
    name: "Project",
    exact: true,
  });
  await projectPicker.selectOption(secondProject);
  await expect(edit).toBeVisible();
  await expect(card(page, "social.upcoming")).toHaveCount(0);
  await projectPicker.selectOption(user().projectId);
  await expect(card(page, "social.upcoming")).toHaveAttribute(
    "data-size",
    "wide",
  );

  await setModule(page, "social", false);
  await page.reload();
  await expect(edit).toBeVisible();
  await expect(card(page, "social.upcoming")).toHaveCount(0);
  await edit.click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await expect(catalog.getByText("Scheduled social posts")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Widget options: Marketing" }).click();
  await page.getByRole("button", { name: "Move earlier", exact: true }).click();
  await save(page);
  await setModule(page, "social", true);
  await page.reload();
  await expect(card(page, "social.upcoming")).toHaveAttribute(
    "data-size",
    "wide",
  );

  await edit.click();
  await page.getByRole("button", { name: "Restore default" }).click();
  await save(page);
  await expect(card(page, "social.upcoming")).toHaveCount(0);
  await expect(card(page, "platform.system-status")).toBeVisible();
});

test("failed and concurrent saves leave the draft on screen", async ({
  page,
}) => {
  await openHome(page);
  await changeLayout(page, []);
  await page.reload();

  await page.getByRole("button", { name: "Customize dashboard" }).click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await page.getByRole("button", { name: "Add widget: System status" }).click();

  await page.route(
    "**/home-layout",
    async (route) => {
      if (route.request().method() === "PUT") await route.abort();
      else await route.fallback();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Your draft is still open" }),
  ).toBeVisible();
  await expect(card(page, "platform.system-status")).toBeVisible();

  await changeLayout(page, [{ id: "marketing.overview", size: "wide" }]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed in another tab" }),
  ).toBeVisible();
  await expect(card(page, "platform.system-status")).toBeVisible();
  await page
    .getByRole("button", { name: "Load current layout and discard draft" })
    .click();
  await expect(card(page, "marketing.overview")).toHaveAttribute(
    "data-size",
    "wide",
  );
  await expect(card(page, "platform.system-status")).toHaveCount(0);
  await changeLayout(page, null);
});

test("module widgets load data only when placed", async ({ page }) => {
  await openHome(page);
  for (const moduleId of ["webmail", "ads", "cms"])
    await setModule(page, moduleId, true);
  await changeLayout(page, []);
  await page.reload();
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(webmail\/mailboxes|ads\/accounts|cms\/summary)$/.test(path))
      requests.push(path);
  });
  await page.getByRole("button", { name: "Customize dashboard" }).click();
  const open = page.getByRole("button", { name: "Add widget", exact: true });
  await open.click();
  const catalog = page.getByRole("dialog", { name: "Widget catalog" });
  await expect(
    catalog.getByRole("button", { name: "Add widget: Ad accounts" }),
  ).toBeVisible();
  expect(requests).toEqual([]);

  await catalog
    .getByRole("button", { name: "Add widget: Ad accounts" })
    .click();
  await expect(
    card(page, "ads.accounts").getByText("No ad accounts are linked."),
  ).toBeVisible();
  await open.click();
  await catalog
    .getByRole("button", { name: "Add widget: Shared mailboxes" })
    .click();
  await expect(
    card(page, "webmail.mailboxes").getByText(
      "No mailboxes are shared with you.",
    ),
  ).toBeVisible();
  await open.click();
  await catalog
    .getByRole("button", { name: "Add widget: Content and publishing" })
    .click();
  await expect(card(page, "cms.publishing").getByText("Drafts")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("li[data-widget]")).toHaveCount(0);
  await changeLayout(page, null);
});

test("uses the full desktop width and previews the selected readable inbox", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await openHome(page);
  await setModule(page, "webmail", true);
  await changeLayout(page, []);
  const id = "webmail.inbox";
  const inbox = card(page, id);
  const mailboxes = [
    ["00000000-0000-4000-8000-000000000011", "First inbox", true],
    ["00000000-0000-4000-8000-000000000012", "Second inbox", true],
    ["00000000-0000-4000-8000-000000000013", "Managed only", false],
  ] as const;
  await page.route("**/webmail/mailboxes", (route) =>
    route.fulfill({
      json: {
        origin: "https://mail.example.invalid",
        mailboxes: mailboxes.map(([mailboxId, displayName, read], index) => ({
          id: mailboxId,
          address: `mail-${index}@example.invalid`,
          displayName,
          status: "ok",
          sync: "ok",
          lastError: null,
          sensitive: false,
          capabilities: {
            read,
            send: false,
            organize: false,
            convert: false,
            manage: !read,
          },
        })),
      },
    }),
  );
  let unread = 3;
  let partial = false;
  await page.route("**/webmail/unread", (route) =>
    route.fulfill({
      json: {
        total: unread + (partial ? 0 : 4),
        complete: !partial,
        counts: { [mailboxes[0][0]]: unread, [mailboxes[1][0]]: partial ? null : 4 },
      },
    }),
  );
  const requests: string[] = [];
  await page.route("**/inbox-summary", (route) => {
    const mailboxId = new URL(route.request().url()).pathname
      .split("/")
      .at(-2)!;
    requests.push(mailboxId);
    return route.fulfill({
      json:
        mailboxId === mailboxes[0][0]
          ? {
              unread,
              messages: [
                {
                  uid: 42,
                  sender: "Synthetic sender",
                  subject: "Synthetic subject",
                  receivedAt: "2026-11-23T09:00:00.000Z",
                  unread: unread > 0,
                },
              ],
            }
          : { unread: 0, messages: [] },
    });
  });
  await page.reload();
  const webmailGroup = page.getByRole("button", { name: /^Webmail .*unread/ });
  await expect(webmailGroup).toHaveAccessibleName("Webmail 7 unread emails in total");
  await webmailGroup.click();
  await expect(webmailGroup).toHaveAttribute("aria-expanded", "false");
  await expect(webmailGroup.locator(".nav-badge")).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Customize dashboard" }).click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await page
    .getByRole("button", { name: "Add widget: Email inbox", exact: true })
    .click();
  await expect(inbox.getByText("3 unread emails", { exact: true })).toBeVisible();
  await expect(inbox.getByText("7 unread emails in total", { exact: true })).toBeVisible();
  await expect(inbox.getByRole("combobox", { name: "Mailbox" }).locator("option")).toHaveText([
    "First inbox (mail-0@example.invalid) · 3 unread",
    "Second inbox (mail-1@example.invalid) · 4 unread",
  ]);
  await expect(inbox.getByText("Synthetic sender")).toBeVisible();
  await expect(inbox.getByText("Synthetic subject")).toBeVisible();
  await expect(inbox.locator("time")).toHaveAttribute(
    "datetime",
    "2026-11-23T09:00:00.000Z",
  );
  expect(requests).toEqual([mailboxes[0][0]]);
  const viewport = await page.locator(".project-home").boundingBox();
  expect(viewport?.width).toBeGreaterThan(1800);
  const columns = await page
    .locator("li[data-widget]")
    .first()
    .evaluate(
      (el) =>
        getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ")
          .length,
    );
  expect(columns).toBe(4);

  unread = 1;
  partial = true;
  await inbox.getByRole("button", { name: "Refresh" }).click();
  await expect(inbox.getByText("1 unread email", { exact: true })).toBeVisible();
  await expect(inbox.getByText("At least 1 unread email in total")).toBeVisible();
  await expect(webmailGroup).toHaveAccessibleName("Webmail At least 1 unread email in total");
  await expect(webmailGroup.locator(".nav-badge")).toContainText("1+");
  await expect(
    inbox.getByRole("combobox", { name: "Mailbox" }).locator("option"),
  ).toHaveCount(2);
  await inbox
    .getByRole("combobox", { name: "Mailbox" })
    .selectOption(mailboxes[1][0]);
  await expect(inbox.getByText("No unread emails")).toBeVisible();
  await expect(inbox.getByText("The inbox is empty.")).toBeVisible();
  await expect(inbox.getByText("Synthetic subject")).toHaveCount(0);
  expect(requests.at(-1)).toBe(mailboxes[1][0]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await changeLayout(page, null);

  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(webmailGroup.locator(".nav-badge")).toContainText("1+");
  await webmailGroup.click();
  await page.route("**/webmail/mailboxes/*/session", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "WEBMAIL_INBOX_UNAVAILABLE" } },
    }),
  );
  await page.getByRole("link", { name: "Mailboxes", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Mailbox" }).locator("option")).toHaveText([
    "First inbox (mail-0@example.invalid) · 1 unread",
    "Second inbox (mail-1@example.invalid) · Unread: unknown",
    "Managed only (mail-2@example.invalid)",
  ]);
  await expect(page.locator("main").getByText("At least 1 unread email in total")).toBeVisible();
});
