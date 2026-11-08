import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.KNOWLEDGE_E2E !== "true",
  "Requires the isolated knowledge test stack and its synthetic browser account.",
);
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
        page.getByRole("heading", { name: "Projektwissen aufbauen" }),
      ).toBeVisible();
      await page
        .getByLabel("Was ist das Projekt?")
        .fill("Synthetisches FamilyPlan-Projekt für die lokale Abnahme.");
      await page.getByLabel("Für wen ist es gedacht?").fill("Familien");
      await page
        .getByRole("button", { name: "Speichern und weiter", exact: true })
        .click();
      await page
        .getByLabel("Name der Quelle")
        .fill("FamilyPlan Testdokumentation");
      await page
        .getByLabel("Inhalt", { exact: true })
        .fill("FamilyPlan bündelt gemeinsame Kalender.");
      await expect(
        page.getByRole("checkbox", { name: /Ausgewählte Inhalte/ }),
      ).not.toBeChecked();
      await page
        .getByRole("button", { name: "Auswahl anzeigen", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Auswahl und Verwendung prüfen" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Text zur Prüfung einreichen" })
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
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow).toBe(false);
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
      // Reading a source again asks first and then shows the selection.
      await page.getByRole("button", { name: "Aktualisieren" }).click();
      const confirmRead = page.getByRole("dialog", {
        name: "Quelle neu lesen?",
      });
      await expect(confirmRead).toBeVisible();
      await confirmRead.getByRole("button", { name: "Jetzt lesen" }).click();
      await expect(
        page.getByRole("heading", { name: "Auswahl und Verwendung prüfen" }),
      ).toBeVisible();
      // Old diagnostic deep links remain reachable under the runtime feature.
      await page.goto(`/p/${project.id}/knowledge/health`);
      await expect(page.locator("main")).toBeVisible();
    });
  });
}
