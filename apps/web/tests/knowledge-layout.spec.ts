import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Locator } from "./fixtures";
import { SEED, signIn } from "./settings-center-helpers";

test.skip(!existsSync(SEED), "needs the seeded e2e installation");

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test("keeps German knowledge status and index actions readable on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "de"));
  const { projectId } = JSON.parse(readFileSync(SEED, "utf8")) as {
    projectId: string;
  };
  const knowledge = `/p/${projectId}/knowledge`;
  const health = `${knowledge}/health?expert=1`;
  const warning =
    "Der neue Wissensindex erfüllt die Prüfanforderungen noch nicht.";
  await page.route(
    `**/api/projects/${projectId}/knowledge-workspace?*`,
    (route) =>
      route.fulfill({
        json: {
          enabled: true,
          profile: {},
          drafts: [],
          runs: [],
          proposals: [],
          facts: [],
          sources: [],
          operations: {
            monitoring: true,
            reviewExperience: true,
            automation: true,
            changed: 0,
            pending: 0,
            status: {
              state: "action_required",
              lastSuccessAt: "2026-11-26T18:31:00.000Z",
              nextAttemptAt: null,
              stage: null,
              marketingBlocked: true,
            },
            issues: [
              {
                id: "layout-index",
                subject: "index",
                href: health,
                telegram: "sent",
                label: { de: warning, en: "The new index needs attention." },
              },
            ],
          },
        },
      }),
  );
  await page.route(`**/api/projects/${projectId}/indexes?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "index-14",
            generation: 14,
            profile: "openai:text-embedding-3-small:1536:chunk-v1",
            phase: "embedding",
            chunks: 560,
            embeddedChunks: 0,
            managedRefresh: true,
          },
        ],
        refresh: {
          autoEnabled: true,
          run: { indexId: "index-14", status: "running", stage: "embedding" },
        },
      },
    }),
  );

  await page.goto(knowledge);
  const operations = page.getByRole("region", { name: "Wissensbetrieb" });
  const card = await bounds(operations);
  const cardTitle = await bounds(
    operations.getByRole("heading", { name: "Wissensbetrieb" }),
  );
  const badge = await bounds(
    operations.getByText("Eingriff nötig", { exact: true }),
  );
  const alert = await bounds(
    operations.getByRole("status").filter({ hasText: warning }),
  );
  const settingsLink = operations.getByRole("link", {
    name: "Index und Einstellungen ansehen",
  });
  const link = await bounds(settingsLink);
  expect(cardTitle.x - card.x).toBeGreaterThanOrEqual(14);
  for (const box of [badge, alert, link]) {
    expect(box.x).toBeCloseTo(cardTitle.x, 0);
  }
  expect(card.y + card.height - link.y - link.height).toBeGreaterThanOrEqual(
    14,
  );

  await settingsLink.click();
  await expect(page).toHaveURL(health);
  await page.setViewportSize({ width: 320, height: 740 });
  const title = await bounds(
    page.getByRole("heading", { level: 1, name: "Wissen" }),
  );
  const settings = await bounds(operations);
  expect(settings.y - title.y - title.height).toBeGreaterThan(12);
  const settingsButtons = operations
    .getByRole("group", { name: "Funktionen für dieses Projekt" })
    .getByRole("button");
  await expect(settingsButtons).toHaveCount(3);
  const first = await bounds(settingsButtons.nth(0));
  const second = await bounds(settingsButtons.nth(1));
  expect(second.y - first.y - first.height).toBeGreaterThanOrEqual(6);
  expect(first.x + first.width).toBeLessThanOrEqual(
    settings.x + settings.width - 14,
  );

  const index = page.locator("section", {
    has: page.getByRole("heading", { name: "Suchindex", exact: true }),
  });
  const terms = index.getByText(/^Orbit sendet freigegebene Wissensabschnitte/);
  const progress = index.getByText("Wissensabschnitte werden eingebettet …");
  const automation = index.getByText("Automatische Aktualisierung ist an.");
  const refresh = index.getByRole("button", {
    name: "Index jetzt aktualisieren",
  });
  const toggle = index.getByRole("button", {
    name: "Automatische Aktualisierung ausschalten",
  });
  const advanced = index.getByText("Index manuell verwalten", { exact: true });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const text of [terms, progress, automation]) {
      await expect
        .poll(() => text.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    const status = await bounds(automation);
    const refreshBox = await bounds(refresh);
    const toggleBox = await bounds(toggle);
    const advancedBox = await bounds(advanced);
    expect(refreshBox.y - status.y - status.height).toBeGreaterThanOrEqual(8);
    if (width <= 390)
      expect(
        toggleBox.y - refreshBox.y - refreshBox.height,
      ).toBeGreaterThanOrEqual(6);
    expect(
      advancedBox.y - toggleBox.y - toggleBox.height,
    ).toBeGreaterThanOrEqual(8);
    expect(advancedBox.x).toBeCloseTo((await bounds(terms)).x, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await expect(refresh).toBeDisabled();
  await advanced.click();
  await expect(
    index.getByRole("button", { name: "Neue Generation vorbereiten" }),
  ).toBeVisible();
});
