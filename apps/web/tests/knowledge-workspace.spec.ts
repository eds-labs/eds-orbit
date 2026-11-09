import { test, expect, type Locator, type Page } from "./fixtures";
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

// Unbreakable strings: the strictest case for horizontal overflow.
const LONG_NAME = `FamilyPlan-${"Familienkalender".repeat(5)}`;
const LONG_TEXT = `FamilyPlan Beleg ${"kalender-synchronisierung-".repeat(8)}Ende.`;

type Statement = { name: string; text: string };
const FIRST: Statement = {
  name: "FamilyPlan Testdokumentation",
  text: "FamilyPlan bündelt gemeinsame Kalender.",
};
const LONG: Statement = { name: LONG_NAME, text: LONG_TEXT };
const THIRD: Statement = {
  name: "FamilyPlan Erinnerungen",
  text: "FamilyPlan erinnert Familien an gemeinsame Termine.",
};
const FOURTH: Statement = {
  name: "FamilyPlan Listen",
  text: "FamilyPlan teilt Einkaufslisten mit allen.",
};
const FIRST_EDITED = "FamilyPlan bündelt gemeinsame Kalender für Familien.";
const THIRD_EDITED = "FamilyPlan erinnert Familien rechtzeitig an Termine.";

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}

/** One text taken in through the real add flow as a single statement to review. */
async function addStatement(page: Page, setupPath: string, s: Statement) {
  await page.goto(setupPath);
  await page.getByRole("button", { name: /^Text / }).click();
  await page.getByLabel("Name der Quelle").fill(s.name);
  await page.getByLabel("Inhalt", { exact: true }).fill(s.text);
  await page.getByRole("button", { name: "Weiter", exact: true }).click();
  await page.getByRole("radio", { name: /^Als eine Aussage prüfen/ }).check();
  await page
    .getByRole("button", { name: "Zur Prüfung geben", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Vorschläge prüfen" }),
  ).toBeVisible({ timeout: 30000 });
}

const reviewCard = (page: Page, text: string) =>
  page.locator("article.knowledge-statement", {
    has: page.getByRole("heading", { level: 3, name: text }),
  });

/** The box lies inside the viewport on both axes. */
async function expectInViewport(page: Page, box: Locator) {
  const rect = await box.boundingBox();
  const view = page.viewportSize()!;
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(view.height + 0.5);
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
      test.setTimeout(420_000);
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
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Projektwissen", exact: true }),
      ).toBeVisible();

      // The whole-text way is the default; this reads the first statement.
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Text / }).click();
      await page.getByLabel("Name der Quelle").fill(FIRST.name);
      await page.getByLabel("Inhalt", { exact: true }).fill(FIRST.text);
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: USE_TITLE }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: /^Ganz übernehmen/ }),
      ).toBeChecked();
      await page
        .getByRole("radio", { name: /^Als eine Aussage prüfen/ })
        .check();
      await page
        .getByRole("button", { name: "Zur Prüfung geben", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Vorschläge prüfen" }),
      ).toBeVisible({ timeout: 30000 });
      for (const s of [LONG, THIRD, FOURTH])
        await addStatement(page, project.setupPath, s);

      // Sources: one row per source, one primary control, a working More menu.
      await page.goto(`/p/${project.id}/knowledge/sources`);
      const row = page.locator(".knowledge-source", {
        has: page.getByRole("heading", { name: FIRST.name, exact: true }),
      });
      await expect(row).toBeVisible();
      await expect(
        page.locator(".knowledge-source", {
          has: page.getByRole("heading", { name: LONG_NAME, exact: true }),
        }),
      ).toBeVisible();
      await expectNoOverflow(page);
      const primaries = row.locator(
        ".knowledge-source-actions > a, .knowledge-source-actions > button",
      );
      await expect(primaries).toHaveCount(1);
      await expect(primaries.first()).toHaveText("Prüfen");
      const more = row.locator("details.knowledge-more");
      await expect(more).not.toHaveAttribute("open", "");
      await more.locator("summary").click();
      await expect(more).toHaveAttribute("open", "");
      const panel = more.locator(".knowledge-more-panel");
      await expect(panel).toBeVisible();
      await panel.scrollIntoViewIfNeeded();
      await expectInViewport(page, panel);
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-more-${name}.png`,
        fullPage: true,
      });
      await panel
        .getByRole("menuitem", { name: "Entscheidungsverlauf" })
        .click();
      // A choice closes the menu and acts.
      await expect(more).not.toHaveAttribute("open", "");
      await expect(
        row.locator(".knowledge-source-history .knowledge-statement"),
      ).toHaveCount(1);
      await expectNoOverflow(page);

      // To review: statements under their topic, selected and confirmed in bulk.
      await page.goto(`/p/${project.id}/knowledge/review`);
      await expect(
        page.getByRole("heading", { level: 2, name: /^Beschreibung/ }),
      ).toBeVisible();
      await expect(page.locator("article.knowledge-statement h3")).toHaveCount(
        4,
      );
      await expect(reviewCard(page, LONG.text)).toBeVisible();
      await expect(reviewCard(page, LONG.text)).toContainText(LONG_NAME);
      await expect(
        reviewCard(page, LONG.text).locator("blockquote"),
      ).toContainText(LONG.text);
      await expectNoOverflow(page);
      const bar = page.locator(".knowledge-bulk-bar");
      await expect(bar).toHaveCount(0);
      await page.screenshot({
        path: `.runtime/knowledge-review-${name}.png`,
        fullPage: true,
      });

      // A card's edit under Adjust stays with the card, also across a refresh.
      await reviewCard(page, FIRST.text)
        .getByRole("button", { name: "Anpassen" })
        .click();
      await reviewCard(page, FIRST.text)
        .getByRole("textbox", { name: "Aussage", exact: true })
        .fill(FIRST_EDITED);
      await reviewCard(page, THIRD.text)
        .getByRole("button", { name: "Anpassen" })
        .click();
      await reviewCard(page, THIRD.text)
        .getByRole("textbox", { name: "Aussage", exact: true })
        .fill(THIRD_EDITED);
      await expect(
        page.getByRole("heading", { level: 3, name: FIRST_EDITED }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Alle auswählen" }).click();
      await expect(bar).toBeVisible();
      const summary = bar.locator(".knowledge-bulk-summary");
      await expect(summary).toHaveText(
        /^4 Aussagen · Marketing und Support · \d+ öffentlich$/,
      );
      await expect(
        page.locator(".knowledge-review-check input:checked"),
      ).toHaveCount(4);

      // The bar stays in view while the page scrolls and clears the bottom bar.
      await page.setViewportSize({
        width: viewport.width,
        height: name === "desktop" ? 600 : 844,
      });
      const scrollable = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 50,
      );
      expect(scrollable).toBe(true);
      const nav = page.locator(".mobile-nav");
      for (const y of [0, 400, 100000]) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await expectInViewport(page, bar);
        if (name === "mobile") {
          const barBox = (await bar.boundingBox())!;
          const navBox = (await nav.boundingBox())!;
          expect(barBox.y + barBox.height).toBeLessThanOrEqual(navBox.y + 0.5);
        }
      }
      if (name === "mobile") await expect(nav).toBeVisible();
      await page.screenshot({ path: `.runtime/knowledge-bulk-${name}.png` });
      await page.setViewportSize(viewport);

      // Partial failure: one request is answered with a version conflict.
      const sent: Record<string, any>[] = [];
      let conflictThird = true;
      await page.route(
        `**/api/projects/${project.id}/actions/knowledge-proposal-decide`,
        (route) => {
          const body = route.request().postDataJSON();
          sent.push(body);
          if (conflictThird && body.statement === THIRD_EDITED)
            return route.fulfill({
              status: 409,
              json: { error: { code: "VERSION_CONFLICT" } },
            });
          return route.continue();
        },
      );
      await bar.getByRole("button", { name: "Auswahl bestätigen" }).click();
      await expect(bar.getByRole("status")).toHaveText("3 von 4 bestätigt");
      // What was sent is what the owner adjusted, one request per statement.
      expect(sent).toHaveLength(4);
      expect(sent.map((b) => b.statement).sort()).toEqual(
        [FIRST_EDITED, LONG.text, THIRD_EDITED, FOURTH.text].sort(),
      );
      for (const body of sent)
        expect(body).toMatchObject({
          decision: "accept",
          audiences: ["marketing", "support"],
        });
      const failed = reviewCard(page, THIRD_EDITED);
      await expect(failed).toBeVisible();
      await expect(
        failed.getByText("Dieser Eintrag wurde inzwischen geändert."),
      ).toBeVisible();
      await expect(
        failed.locator(".knowledge-review-check input"),
      ).toBeChecked();
      await expect(page.locator("article.knowledge-statement h3")).toHaveCount(
        1,
      );
      await expect(summary).toHaveText(
        /^1 Aussage · Marketing und Support · \d+ öffentlich$/,
      );
      await expectInViewport(page, bar);
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-bulk-failed-${name}.png`,
        fullPage: true,
      });

      // The kept edit is what the retry sends.
      conflictThird = false;
      sent.length = 0;
      await bar.getByRole("button", { name: "Auswahl bestätigen" }).click();
      await expect(bar.getByRole("status")).toHaveText("1 von 1 bestätigt");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.statement).toBe(THIRD_EDITED);
      await expect(
        page.getByText("Alles geprüft", { exact: true }),
      ).toBeVisible();
      await page.unroute(
        `**/api/projects/${project.id}/actions/knowledge-proposal-decide`,
      );

      // Project knowledge: the statements are listed under their topic.
      await page.goto(`/p/${project.id}/knowledge`);
      await expect(
        page.getByRole("heading", { name: "Projektwissen", exact: true }),
      ).toBeVisible();
      const topic = page.locator("section.knowledge-topic", {
        has: page.getByRole("heading", { level: 2, name: /^Beschreibung/ }),
      });
      await expect(topic.locator("article.knowledge-statement h3")).toHaveCount(
        4,
      );
      for (const text of [FIRST_EDITED, LONG.text, THIRD_EDITED, FOURTH.text])
        await expect(
          topic.getByRole("heading", { level: 3, name: text }),
        ).toBeVisible();
      await expectNoOverflow(page);
      const first = reviewCard(page, FIRST_EDITED);
      await first.getByText("Beleg und Verlauf", { exact: true }).click();
      await expect(first.locator("blockquote")).toContainText(FIRST.text);
      await first.getByRole("button", { name: "Verlauf laden" }).click();
      await expect(
        first.getByRole("region", { name: "Entscheidungsverlauf" }),
      ).toContainText("Bestätigt");
      await expectNoOverflow(page);
      if (name === "desktop") {
        const side = page.locator(".sidebar");
        await expect(
          side.getByRole("link", { name: "Projektwissen", exact: true }),
        ).toBeVisible();
        await expect(
          side.getByRole("link", { name: "Quellen", exact: true }),
        ).toBeVisible();
        await expect(
          side.getByRole("link", { name: /^Zu prüfen/ }),
        ).toBeVisible();
        await expect(
          side.getByRole("link", { name: "Fakten", exact: true }),
        ).toHaveCount(0);
        await expect(
          side.getByRole("link", { name: "Importieren", exact: true }),
        ).toHaveCount(0);
      }
      await page.screenshot({
        path: `.runtime/knowledge-${name}.png`,
        fullPage: true,
      });
      await page.getByLabel("Wissen durchsuchen").fill("nicht vorhanden");
      await expect(page.getByText(/Keine passenden Einträge/)).toBeVisible();
      await page.getByLabel("Wissen durchsuchen").fill("");
      // A confirmed statement can be corrected, removed and brought back.
      const corrected = "FamilyPlan teilt Einkaufslisten mit der Familie.";
      await reviewCard(page, FOURTH.text)
        .getByRole("button", { name: "Bearbeiten", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Aussage", exact: true })
        .fill(corrected);
      await page.getByRole("button", { name: "Änderung speichern" }).click();
      const correctedHeading = page.getByRole("heading", {
        level: 3,
        name: corrected,
      });
      await expect(correctedHeading).toBeVisible();
      await reviewCard(page, corrected)
        .getByRole("button", { name: "Entfernen", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Aussage entfernen?" })
        .getByRole("button", { name: "Entfernen", exact: true })
        .click();
      await expect(correctedHeading).toHaveCount(0);
      await page.getByRole("button", { name: "Entfernt (1)" }).click();
      await page.getByRole("button", { name: "Wiederherstellen" }).click();
      await expect(correctedHeading).toBeVisible();
      await expect(page.getByRole("button", { name: /^Entfernt/ })).toHaveCount(
        0,
      );

      // The technical area is one link; its bar leads back to knowledge.
      await page
        .getByRole("link", { name: "Technik-Bereich", exact: true })
        .click();
      await expect(page).toHaveURL(/\/knowledge\/health\?expert=1/);
      const technical = page.getByRole("navigation", {
        name: "Technik-Bereich",
      });
      await expect(technical).toBeVisible();
      await expectNoOverflow(page);
      await technical.getByRole("link", { name: "Zurück zum Wissen" }).click();
      await expect(
        page.getByRole("heading", { name: "Projektwissen", exact: true }),
      ).toBeVisible();
      await expect(page).not.toHaveURL(/expert=1/);

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
      const emptyRow = page.locator(`#knowledge-source-${source.id}`);
      await expect(emptyRow).toContainText("Noch nie abgerufen");
      await expect(emptyRow).toBeFocused();
      await expectNoOverflow(page);
      await page.screenshot({
        path: `.runtime/knowledge-sources-${name}.png`,
        fullPage: true,
      });
      await emptyRow.locator("details.knowledge-more summary").click();
      await emptyRow
        .getByRole("menuitem", { name: "Entfernen", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Quelle entfernen?" })
        .getByRole("button", { name: "Entfernen", exact: true })
        .click();
      await expect(emptyRow).toHaveCount(0);

      // A long text taken over whole is on the Sources page with its document.
      await page.goto(project.setupPath);
      await page.getByRole("button", { name: /^Text / }).click();
      await page.getByLabel("Name der Quelle").fill("FamilyPlan Handbuch");
      await page
        .getByLabel("Inhalt", { exact: true })
        .fill(
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
      await page
        .getByRole("button", { name: "Übernehmen", exact: true })
        .click();
      await expect(
        page.getByText("Der Inhalt ist jetzt durchsuchbar.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Zu den Quellen" }).click();
      const handbook = page.locator(".knowledge-source", {
        has: page.getByRole("heading", { name: "FamilyPlan Handbuch" }),
      });
      await expect(handbook).toBeFocused();
      await handbook.locator("details.knowledge-more summary").click();
      await expect(
        handbook.getByRole("menuitem", { name: "Dokumente und Versionen" }),
      ).toBeVisible();
      await expectNoOverflow(page);

      // Updating a website draft asks first, then opens its Use step.
      const siteDraft = await context.request.post(
        `/api/projects/${project.id}/actions/knowledge-draft-save`,
        {
          headers: { Origin: baseURL! },
          data: {
            name: "FamilyPlan Webseite",
            kind: "website",
            url: SITE_ROOT,
            pages: SITE_PAGES.map((p) => p.url),
            language: "de",
          },
        },
      );
      expect(siteDraft.status()).toBe(200);
      const draft = await siteDraft.json();
      const previewId = randomUUID();
      const previews: Record<string, unknown>[] = [];
      const previewRoute = `**/api/projects/${project.id}/actions/knowledge-draft-preview`;
      await page.route(previewRoute, (route) => {
        previews.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: previewId } });
      });
      await page.goto(`/p/${project.id}/knowledge/sources`);
      const siteRow = page.locator(`#knowledge-source-${draft.id}`);
      await expect(siteRow).toBeVisible();
      await siteRow.locator("details.knowledge-more summary").click();
      await siteRow.getByRole("menuitem", { name: "Aktualisieren" }).click();
      const confirmRead = page.getByRole("dialog", {
        name: "Quelle neu lesen?",
      });
      await expect(confirmRead).toBeVisible();
      expect(previews).toHaveLength(0);
      await confirmRead.getByRole("button", { name: "Jetzt lesen" }).click();
      await page.waitForURL(
        `**/knowledge/import?draft=${draft.id}&preview=${previewId}`,
      );
      expect(previews).toEqual([{ draftId: draft.id }]);
      await page.unroute(previewRoute);

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
      await page
        .getByRole("radio", { name: /^KI schlägt Aussagen vor/ })
        .check();
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
        publicUse: true,
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
