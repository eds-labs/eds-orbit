import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { SEED, signIn } from "./settings-center-helpers";
import { googleSearchReport } from "../src/modules/marketing/matomo-reports";

test.skip(!existsSync(SEED), "needs the seeded e2e installation");

test("shows separate Matomo reports and accessible daily values at desktop and mobile widths", async ({
  page,
}) => {
  await signIn(page);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "de"));
  const { projectId } = JSON.parse(readFileSync(SEED, "utf8")) as {
    projectId: string;
  };
  const site = { siteId: 2, timezone: "Europe/Berlin", currency: "EUR" };
  await page.route(
    `**/api/projects/${projectId}/marketing/matomo-trend?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              ...site,
              accountId: "visits",
              reportMethod: "VisitsSummary.get",
              date: "2026-11-24",
              sessions: 8,
            },
            {
              ...site,
              accountId: "actions",
              reportMethod: "Actions.get",
              date: "2026-11-24",
              outlinkClicks: 3,
              pageviews: 15,
            },
            {
              ...site,
              accountId: "search",
              reportMethod: googleSearchReport,
              date: "2026-11-22",
              clicks: 4,
              impressions: 78,
            },
            {
              ...site,
              accountId: "search",
              reportMethod: googleSearchReport,
              date: "2026-11-24",
              clicks: 0,
              impressions: 14,
            },
          ],
          truncated: false,
        },
      }),
  );
  await page.goto(`/p/${projectId}/marketing/analytics`);
  const trend = page.getByRole("region", { name: "Matomo · Tagesverlauf" });
  await expect(trend.getByLabel("Kennzahl")).toHaveValue("sessions");
  await trend
    .getByLabel("Bericht")
    .selectOption({ label: "Website-Aktionen · Website 2 · Europe/Berlin" });
  await trend.getByLabel("Kennzahl").selectOption("outlinkClicks");
  await expect(trend.getByLabel("Kennzahl")).toHaveValue("outlinkClicks");
  await trend.getByLabel("Bericht").selectOption({
    label: "Google-Websuche (Search Console) · Website 2 · Europe/Berlin",
  });
  await trend.getByLabel("Kennzahl").selectOption("clicks");
  await expect(trend.getByText("2 von 30 Tagen mit Messwerten")).toBeVisible();
  const details = trend.getByText("Tageswerte anzeigen", { exact: true });
  await details.focus();
  await details.press("Enter");
  const table = trend.getByRole("table");
  await expect(
    table.getByRole("row", { name: "23.11.2026 Fehlt" }),
  ).toBeVisible();
  await expect(table.getByRole("row", { name: "24.11.2026 0" })).toBeVisible();
  await expect(table.getByRole("row", { name: "22.11.2026 4" })).toBeVisible();

  for (const width of [2560, 1280, 761, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 845 });
    await expect(trend.getByLabel("Kennzahl")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const bounds = await trend.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const content = await page.locator(".marketing-analytics").boundingBox();
    expect(bounds!.x).toBeCloseTo(content!.x, 0);
    expect(bounds!.width).toBeCloseTo(content!.width, 0);
  }
  const zeroMark = trend.locator("[data-zero]");
  const lightColor = await zeroMark.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(zeroMark).not.toHaveCSS("background-color", lightColor);
  await expect(table.getByRole("row", { name: "24.11.2026 0" })).toBeVisible();
});
