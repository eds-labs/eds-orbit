import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.KNOWLEDGE_E2E !== "true",
  "Requires the isolated knowledge test stack and its synthetic browser account.",
);

const SITE_ROOT = "https://hilfe.example.test/familyplan";
const SITE_PAGES = [
  { url: `${SITE_ROOT}/de`, language: "de" },
  { url: `${SITE_ROOT}/de/kalender`, language: "de" },
  { url: `${SITE_ROOT}/de/einkaufsliste`, language: "de" },
  { url: `${SITE_ROOT}/en`, language: "en" },
  { url: `${SITE_ROOT}/en/calendar`, language: "en" },
];
const USE_TITLE = "Wie soll Orbit das verwenden?";

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });
    test("creates, reviews and traces project knowledge without JSON", async ({
      page,
      context,
      baseURL,
    }) => {
      const account = JSON.parse(
        readFileSync(".runtime/knowledge-e2e.json", "utf8"),
      );
      const login = await context.request.post("/api/auth/sign-in/email", {
        headers: { Origin: baseURL! },
        data: { email: account.email, password: account.password },
      });
      expect(login.status()).toBe(200);
      await page.addInitScript(() =>
        localStorage.setItem("orbit.locale", "de"),
      );
      const created = await context.request.post("/api/projects", {
        headers: { Origin: baseURL! },
        data: {
          name: `FamilyPlan ${name} ${randomUUID().slice(0, 6)}`,
          language: "de",
          timezone: "Europe/Berlin",
          workspaceId: account.workspaceId,
        },
      });
      expect(created.status()).toBe(201);
      const project = await created.json();
      expect(project.setupPath).toBe(`/p/${project.id}/knowledge/import`);
      await page.goto(project.setupPath);
      await expect(
        page.getByRole("heading", { name: "Wissen hinzufügen", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Was möchtest du hinzufügen?" }),
      ).toBeVisible();
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-add-what-${name}.png`,
        fullPage: true,
      });
      // The project description is optional and has its own page.
      await page
        .getByRole("link", { name: "Projektbeschreibung bearbeiten" })
        .click();
      await page
        .getByLabel("Was ist das Projekt?")
        .fill("Synthetisches FamilyPlan-Projekt für die lokale Abnahme.");
      await page.getByLabel("Für wen ist es gedacht?").fill("Familien");
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Projektwissen", exact: true }),
      ).toBeVisible();
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Text / }).click();
      await page
        .getByLabel("Name der Quelle")
        .fill("FamilyPlan Testdokumentation");
      await page
        .getByLabel("Inhalt", { exact: true })
        .fill("FamilyPlan bündelt gemeinsame Kalender.");
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: USE_TITLE }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: /^Ganz übernehmen/ }),
      ).toBeChecked();
      await page.getByRole("radio", { name: /^Als eine Aussage prüfen/ }).check();
      await page
        .getByRole("button", { name: "Zur Prüfung geben", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Vorschläge prüfen" }),
      ).toBeVisible({ timeout: 30000 });
      await page.getByRole("link", { name: "Vorschläge prüfen" }).click();
      await expect(
        page.getByRole("heading", {
          name: "FamilyPlan bündelt gemeinsame Kalender.",
        }),
      ).toBeVisible();
      await page.getByText("Beleg und Verlauf", { exact: true }).click();
      await expect(page.locator("blockquote")).toContainText(
        "FamilyPlan bündelt gemeinsame Kalender.",
      );
      await page
        .getByRole("button", { name: "Übernehmen", exact: true })
        .click();
      await expect(
        page.getByText("Alles geprüft", { exact: true }),
      ).toBeVisible();
      await page.goto(`/p/${project.id}/knowledge`);
      await expect(
        page.getByRole("heading", { name: "Projektwissen", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "FamilyPlan bündelt gemeinsame Kalender.",
        }),
      ).toBeVisible();
      await page.getByText("Beleg und Verlauf", { exact: true }).click();
      await page.getByRole("button", { name: "Verlauf laden" }).click();
      await expect(
        page.getByRole("region", { name: "Entscheidungsverlauf" }),
      ).toContainText("Bestätigt");
      await expectNoOverflow(page);
      if (name === "desktop") {
        const nav = page.locator(".sidebar");
        await expect(
          nav.getByRole("link", { name: "Projektwissen", exact: true }),
        ).toBeVisible();
        await expect(
          nav.getByRole("link", { name: "Quellen", exact: true }),
        ).toBeVisible();
        await expect(
          nav.getByRole("link", { name: /^Zu prüfen/ }),
        ).toBeVisible();
        await expect(
          nav.getByRole("link", { name: "Fakten", exact: true }),
        ).toHaveCount(0);
        await expect(
          nav.getByRole("link", { name: "Importieren", exact: true }),
        ).toHaveCount(0);
      }
      await page.screenshot({
        path: `.runtime/knowledge-${name}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Verlauf laden" }).click();
      await page.getByLabel("Wissen durchsuchen").fill("nicht vorhanden");
      await expect(page.getByText(/Keine passenden Einträge/)).toBeVisible();
      await page.getByLabel("Wissen durchsuchen").fill("");
      // A confirmed statement can be corrected, removed and brought back.
      const corrected = page.getByRole("heading", {
        name: "FamilyPlan teilt Familienkalender.",
      });
      await page
        .getByRole("button", { name: "Bearbeiten", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Aussage", exact: true })
        .fill("FamilyPlan teilt Familienkalender.");
      await page.getByRole("button", { name: "Änderung speichern" }).click();
      await expect(corrected).toBeVisible();
      await page.getByRole("button", { name: "Entfernen", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Aussage entfernen?" })
        .getByRole("button", { name: "Entfernen", exact: true })
        .click();
      await expect(corrected).toHaveCount(0);
      await page.getByRole("button", { name: "Entfernt (1)" }).click();
      await page.getByRole("button", { name: "Wiederherstellen" }).click();
      await expect(corrected).toBeVisible();
      await expect(page.getByRole("button", { name: /^Entfernt/ })).toHaveCount(
        0,
      );
      // A warning's link lands on its source, which says what is wrong.
      const empty = await context.request.post(
        `/api/projects/${project.id}/sources`,
        {
          headers: { Origin: baseURL! },
          data: {
            name: "Leere Hilfe",
            type: "gitbook",
            authority: "official",
            allowedOrigins: ["https://example.invalid"],
            allowedPaths: ["/"],
            maxAgeHours: 168,
            publicUse: false,
            modelUse: true,
            status: "active",
            generation: 1,
          },
        },
      );
      expect(empty.status()).toBe(201);
      const source = await empty.json();
      await page.goto(`/p/${project.id}/knowledge/sources?source=${source.id}`);
      const row = page.locator(`#knowledge-source-${source.id}`);
      await expect(row).toContainText("Noch nie abgerufen");
      await expect(row).toBeFocused();
      await page.screenshot({
        path: `.runtime/knowledge-sources-${name}.png`,
        fullPage: true,
      });
      await row.getByRole("button", { name: "Entfernen", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Quelle entfernen?" })
        .getByRole("button", { name: "Entfernen", exact: true })
        .click();
      await expect(row).toHaveCount(0);
      // Reading a source again asks first and then shows how it is used.
      await page
        .locator(".knowledge-source", {
          has: page.getByRole("heading", {
            name: "FamilyPlan Testdokumentation",
          }),
        })
        .getByRole("button", { name: "Aktualisieren" })
        .click();
      const confirmRead = page.getByRole("dialog", {
        name: "Quelle neu lesen?",
      });
      await expect(confirmRead).toBeVisible();
      await confirmRead.getByRole("button", { name: "Jetzt lesen" }).click();
      await expect(
        page.getByRole("heading", { name: USE_TITLE }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: /^Als eine Aussage prüfen/ }),
      ).toBeChecked();

      // A long text taken over whole is on the Sources page with its document.
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Text / }).click();
      await page.getByLabel("Name der Quelle").fill("FamilyPlan Handbuch");
      await page.getByLabel("Inhalt", { exact: true }).fill(
        Array.from(
          { length: 30 },
          (_, i) =>
            `Abschnitt ${i + 1}: Familien teilen Termine und Aufgaben in FamilyPlan.`,
        ).join("\n"),
      );
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(
        page.getByRole("radio", { name: /^Ganz übernehmen/ }),
      ).toBeChecked();
      // Over 1,000 characters there is no single statement to review.
      await expect(
        page.getByRole("radio", { name: /^Als eine Aussage prüfen/ }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
      await expect(
        page.getByText("Der Inhalt ist jetzt durchsuchbar.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Zu den Quellen" }).click();
      const handbook = page.locator(".knowledge-source", {
        has: page.getByRole("heading", { name: "FamilyPlan Handbuch" }),
      });
      await expect(handbook).toBeFocused();
      await expect(
        handbook.getByRole("link", { name: "Dokumente und Versionen" }),
      ).toBeVisible();
      await expectNoOverflow(page);

      // AI analysis without a spending authority explains itself and cannot start.
      let aiStarts = 0;
      await page.route(
        `**/api/projects/${project.id}/actions/knowledge-analysis-start`,
        (route) => {
          aiStarts += 1;
          return route.abort();
        },
      );
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Text / }).click();
      await page.getByLabel("Name der Quelle").fill("FamilyPlan KI-Text");
      await page
        .getByLabel("Inhalt", { exact: true })
        .fill("FamilyPlan erinnert Familien an gemeinsame Termine.");
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await page.getByRole("radio", { name: /^KI schlägt Aussagen vor/ }).check();
      const startAi = page.getByRole("button", { name: /^Analyse starten/ });
      await expect(startAi).toBeVisible();
      await expect(startAi).toBeDisabled();
      const missingAuthority = page.getByRole("status").filter({
        hasText: "Für KI-Analysen fehlt eine KI-Ausgabenfreigabe",
      });
      await expect(
        missingAuthority.getByRole("link", {
          name: "Zu den KI-Einstellungen",
        }),
      ).toBeVisible();
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-add-ai-${name}.png`,
        fullPage: true,
      });
      expect(aiStarts).toBe(0);

      // A site is stubbed at the network: the fetcher reads public HTTPS only.
      const started: Record<string, unknown>[] = [];
      const discovered: Record<string, unknown>[] = [];
      await page.route(
        `**/api/projects/${project.id}/actions/knowledge-site-discover`,
        (route) => {
          discovered.push(route.request().postDataJSON());
          return route.fulfill({
            json: {
              rootUrl: SITE_ROOT,
              discovery: "sitemap",
              pages: SITE_PAGES,
              capped: false,
              complete: true,
              excludedPages: [],
            },
          });
        },
      );
      const siteSourceId = randomUUID();
      await page.route(
        `**/api/projects/${project.id}/actions/knowledge-site-start`,
        (route) => {
          started.push(route.request().postDataJSON());
          return route.fulfill({
            json: {
              sourceId: siteSourceId,
              started: true,
              run: { id: randomUUID(), data: { status: "queued" } },
            },
          });
        },
      );
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Website oder GitBook/ }).click();
      await page.getByLabel("Name der Quelle").fill("FamilyPlan Hilfe");
      await page
        .getByLabel("Adresse der Webseite")
        .fill("hilfe.example.test/familyplan");
      await page
        .getByRole("button", { name: "Seiten suchen", exact: true })
        .click();
      await expect(page.getByText("5 von 5 Seiten ausgewählt")).toBeVisible();
      expect(discovered).toEqual([{ url: SITE_ROOT }]);
      await page.getByRole("checkbox", { name: "einkaufsliste" }).uncheck();
      await page.getByRole("checkbox", { name: /^Englisch: alle/ }).uncheck();
      await expect(page.getByText("2 von 5 Seiten ausgewählt")).toBeVisible();
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-add-pages-${name}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(
        page.getByRole("radio", { name: /^Ganz übernehmen/ }),
      ).toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: /^Jede Woche automatisch/ }),
      ).toBeChecked();
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-add-use-${name}.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "2 Seiten einlesen", exact: true })
        .click();
      await expect(
        page.getByText("Orbit liest jetzt 2 Seiten.", { exact: false }),
      ).toBeVisible();
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        url: SITE_ROOT,
        name: "FamilyPlan Hilfe",
        marketing: true,
        support: true,
        modelUse: true,
        publicUse: false,
        autoUpdate: true,
        excludedPages: [
          `${SITE_ROOT}/de/einkaufsliste`,
          `${SITE_ROOT}/en`,
          `${SITE_ROOT}/en/calendar`,
        ],
      });
      await expect(
        page.getByRole("link", { name: "Zu den Quellen" }),
      ).toHaveAttribute("href", new RegExp(`source=${siteSourceId}$`));
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-add-result-${name}.png`,
        fullPage: true,
      });
      // Old diagnostic deep links remain reachable under the runtime feature.
      await page.goto(`/p/${project.id}/knowledge/health`);
      await expect(page.locator("main")).toBeVisible();
      // GitHub App setup has its own page.
      await page.goto(`/p/${project.id}/knowledge/github`);
      await expect(
        page.getByRole("heading", { name: "GitHub-App-Einstellungen" }),
      ).toBeVisible();
    });
  });
}
