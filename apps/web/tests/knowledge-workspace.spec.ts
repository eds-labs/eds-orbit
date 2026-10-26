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
      // Old diagnostic deep links remain reachable under the runtime feature.
      await page.goto(`/p/${project.id}/knowledge/health`);
      await expect(page.locator("main")).toBeVisible();
    });
  });
}
