import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";
import { SEED, signIn } from "./settings-center-helpers";
import type { MigrationView } from "../src/modules/social/legacy";

test.skip(!existsSync(SEED), "needs the seeded e2e installation");

const projectId = () =>
  (JSON.parse(readFileSync(SEED, "utf8")) as { projectId: string }).projectId;

const pageOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

test("mobile drawer keeps focus inside and restores the trigger when it closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await signIn(page);
  await page.goto(`/p/${projectId()}`);
  const sidebar = page.locator("#workspace-navigation");
  const bar = page.getByRole("navigation", { name: "Mobile workspace" });
  const more = bar.getByRole("button", { name: /^More/ });
  await expect(more).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect.poll(() => pageOverflow(page)).toBe(0);

  await more.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  const close = drawer.getByRole("button", { name: "Close", exact: true });
  const first = drawer.getByRole("link", { name: "EDS Orbit home" });
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(drawer.getByRole("button", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(sidebar).toBeHidden();

  await more.click();
  await expect(close).toBeVisible();
  await page.setViewportSize({ width: 761, height: 844 });
  await expect(drawer).toHaveCount(0);
  await expect(sidebar).toBeVisible();
  await expect
    .poll(() => page.locator("body").evaluate((el) => el.style.overflow))
    .toBe("");

  await page.goto(`/p/${projectId()}/operations`);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Workspace execution" }),
  ).toBeVisible();
  await expect.poll(() => pageOverflow(page)).toBe(0);
});

test("long CMS titles fit on phones and open the article editor", async ({
  page,
  baseURL,
}) => {
  test.skip(process.env.E2E_CMS !== "1", "needs a seeded content module");
  await signIn(page);
  const id = projectId();
  const title = `Abonnementabrechnungsberechtigungsgruppenverwaltung ${Date.now()}`;
  const create = await page.request.post(`/api/projects/${id}/cms/entries`, {
    headers: { origin: new URL(baseURL!).origin },
    data: { type: "article", locale: "de", title },
  });
  expect(create.status()).toBe(201);
  const { entry } = (await create.json()) as { entry: { id: string } };
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["cms", "cms/entries"]) {
      await page.goto(`/p/${id}/${path}`);
      const article = page.getByRole("link", { name: new RegExp(title) });
      await expect(article).toBeVisible();
      await expect.poll(() => pageOverflow(page)).toBe(0);
      const row = await article.boundingBox();
      expect(row!.x + row!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(new RegExp(`\\?entry=${entry.id}$`));
  await expect(page.locator(".cms-title-input")).toHaveValue(title);
  await expect.poll(() => pageOverflow(page)).toBe(0);
});

test("organization integration rows stay within the phone viewport", async ({
  page,
}) => {
  test.skip(process.env.E2E_SOCIAL !== "1", "needs a seeded social account");
  await page.setViewportSize({ width: 320, height: 844 });
  await signIn(page);
  const capabilities = await page.request.get("/api/management/capabilities");
  const { organizations, projects } = await capabilities.json();
  const project = projects.find(({ id }: { id: string }) => id === projectId());
  const organization = organizations.find(
    ({ id }: { id: string }) => id === project.workspaceId,
  );
  await page.goto(`/manage/o/${organization.id}/integrations`);
  const region = page.getByRole("region", { name: project.name, exact: true });
  await expect(
    region.getByRole("row").filter({ hasText: "Orbit e2e channel" }),
  ).toBeVisible();
  await expect.poll(() => pageOverflow(page)).toBe(0);
  await region.focus();
  await expect(region).toBeFocused();
});

test("the brand screen handles a project without a marketing profile", async ({
  page,
}) => {
  await signIn(page);
  const id = projectId();
  const modules = await page.request.get(`/api/projects/${id}/modules`);
  const { features } = await modules.json();
  test.skip(!features.creativeStudio, "needs Creative Studio enabled");
  await page.route(`**/api/projects/${id}/marketing-profile`, (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto(`/manage/p/${id}/modules/marketing/brand`);
  await expect(
    page.getByText(
      "Save the Marketing profile first; the brand kit is part of it.",
    ),
  ).toBeVisible();
});

test("long Postiz account names scroll inside the mapping table", async ({
  page,
}) => {
  test.skip(process.env.E2E_SOCIAL !== "1", "needs a seeded social module");
  await signIn(page);
  const id = projectId();
  const displayName =
    "Redaktion und Kundenkommunikation für alle deutschsprachigen Projekte";
  const mapping: MigrationView = {
    backend: "postiz",
    channels: [
      {
        integrationId: "test-channel",
        name: "Test channel",
        platform: "telegram",
        accountId: "test-account",
        suggestedAccountId: null,
      },
    ],
    accounts: [
      {
        accountId: "test-account",
        platform: "telegram",
        handle: "orbit-test-redaktion",
        displayName,
        status: "active",
        legacyPostizIntegrationId: "test-channel",
      },
    ],
    inventory: {
      backend: "postiz",
      channels: { assigned: 1, mapped: 1 },
      publications: {},
      postizDrafts: {},
      openExceptions: {},
      blockingSwitch: 0,
      readyToSwitch: false,
    },
  };
  await page.route(
    `**/api/projects/${id}/marketing/social-migration`,
    (route) => route.fulfill({ json: mapping }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/manage/p/${id}/integrations/social/accounts`);
  const region = page.getByRole("region", { name: "Postiz channel mappings" });
  const select = region.getByRole("combobox", {
    name: "Social account: Test channel",
  });
  await expect(select).toHaveValue("test-account");
  for (const width of [320, 390, 761, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => pageOverflow(page)).toBe(0);
    if (width <= 390) {
      expect(
        await region.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
    }
  }
  await region.focus();
  await expect(region).toBeFocused();
});
