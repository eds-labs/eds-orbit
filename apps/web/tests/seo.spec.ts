import { test, expect, type Page } from "./fixtures";

const projectId = "seo-browser-project";
const workspaceId = "seo-browser-organization";
const project = `/p/${projectId}`;
const settings = `/manage/p/${projectId}/integrations/seo/search-console`;
const seo = `/api/projects/${projectId}/seo`;
const provider = "google-search-console";

async function fixture(
  page: Page,
  access: "owner" | "viewer" | "none",
  enabled = true,
) {
  const providerBase = `${seo}/providers/${provider}`;
  const websiteName = "Rechercheportal für unabhängige Familienorganisation";
  const propertyId = "sc-domain:search-console-fixture.example.test";
  const connectionId = "synthetic-connection";
  const connection = {
    id: connectionId,
    label: "Google Search Console",
    unavailable: false,
  };
  const property = { id: propertyId, label: propertyId };
  const websites = [
    {
      id: "other",
      name: "Bereits verknüpfte Projekt-Website",
      url: "https://website.example.test/",
      properties: [
        {
          provider,
          connectionId,
          propertyId: "sc-domain:website.example.test",
        },
      ],
    },
  ];
  const requests: { method: string; path: string; data?: unknown }[] = [];
  const role = access === "owner" ? "owner" : "viewer";
  const capabilities = [
    "project.overview",
    "project.integrations",
    "project.modules",
  ];
  let connected = access !== "owner";
  const oauth = "https://accounts.google.com/o/oauth2/v2/auth?fixture=seo";
  await page.addInitScript(() => {
    localStorage.setItem("orbit.locale", "de");
  });
  await page.route(oauth, async (route) => {
    connected = true;
    await route.fulfill({
      status: 302,
      headers: {
        Location: new URL(`${settings}?connection=connected`, page.url()).href,
      },
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/setup")
      return route.fulfill({ json: { configured: true } });
    if (path === "/api/me")
      return route.fulfill({
        json: {
          user: {
            id: "synthetic-user",
            name: "SEO QA",
            email: "browser@example.test",
          },
          projects: [
            {
              id: projectId,
              workspaceId,
              name: "SEO Fixture",
              language: "de",
              timezone: "Europe/Berlin",
              mode: "observe",
              paused: false,
              generation: 0,
              role,
            },
          ],
          workspaces: [{ id: workspaceId, name: "SEO Fixture", role }],
          connections: true,
        },
      });
    if (path === `/api/projects/${projectId}/modules`)
      return route.fulfill({
        json: {
          enabled: true,
          modules: [
            { id: "marketing", enabled: false, access: "none" },
            { id: "knowledge", enabled: false, access: "none" },
            { id: "seo", enabled, access },
          ],
          features: {},
        },
      });
    if (path === "/api/management/capabilities")
      return route.fulfill({
        json: {
          flags: {
            connections: true,
            aiCatalog: false,
            aiDefaults: false,
            aiOrgBudget: false,
          },
          system: [],
          account: [],
          organizations: [],
          projects: [
            {
              id: projectId,
              workspaceId,
              name: "SEO Fixture",
              role,
              capabilities,
            },
          ],
        },
      });
    if (!path.startsWith(seo))
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND" } },
      });
    requests.push({
      method,
      path,
      ...(request.postData() ? { data: request.postDataJSON() } : {}),
    });
    if (path === seo)
      return route.fulfill({
        json: {
          canManage: access === "owner",
          providers: [
            {
              id: provider,
              label: "Google Search Console",
              canConnect: true,
              appReady: access === "owner",
              connections: connected && access === "owner" ? [connection] : [],
            },
          ],
          websites,
        },
      });
    if (path === `${providerBase}/connect` && method === "POST")
      return route.fulfill({ json: { authorizeUrl: oauth } });
    if (path === `${providerBase}/connections/${connectionId}/properties`)
      return route.fulfill({ json: { properties: [property] } });
    if (path === `${seo}/websites` && method === "POST") {
      const website = {
        id: "second",
        ...(request.postDataJSON() as { name: string; url: string }),
        properties: [],
      };
      websites.push(website);
      return route.fulfill({ status: 201, json: website });
    }
    if (
      path === `${seo}/websites/second/properties/${provider}` &&
      method === "PUT"
    ) {
      const website = websites.find((item) => item.id === "second")!;
      website.properties = [{ provider, ...request.postDataJSON() }];
      return route.fulfill({ json: website });
    }
    if (/\/websites\/(other|second)\/performance$/.test(path))
      return route.fulfill({
        json: {
          provider,
          websiteId: path.split("/").at(-2),
          dimension: url.searchParams.get("dimension"),
          startDate: url.searchParams.get("startDate"),
          endDate: url.searchParams.get("endDate"),
          rows: [
            {
              keys: [
                "Suchanfrage zur Organisation eines gemeinsamen Familienalltags",
              ],
              clicks: 42,
              impressions: 350,
              ctr: 0.12,
              position: 4.5,
            },
          ],
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND" } },
    });
  });
  return { websiteName, connectionId, propertyId, requests };
}

test("owner connects, adds a second website and links a property", async ({
  page,
}) => {
  const { websiteName, connectionId, propertyId, requests } = await fixture(
    page,
    "owner",
  );
  await page.goto(`${project}/seo`);
  await expect(
    page.getByRole("heading", { level: 1, name: "SEO" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Websites und Verbindungen verwalten" })
    .click();
  await expect(page).toHaveURL(settings);
  await expect(
    page.getByRole("heading", { name: "Websites und Verbindungen verwalten" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Konto verbinden", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Konto verbunden/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(settings);
  await page.getByRole("button", { name: "Website hinzufügen" }).click();
  const websiteDialog = page.getByRole("dialog", {
    name: "Website hinzufügen",
  });
  await websiteDialog.getByLabel("Name", { exact: true }).fill(websiteName);
  await websiteDialog
    .getByLabel("Website-URL")
    .fill("https://second.example.test/");
  await websiteDialog
    .getByRole("button", { name: "Website hinzufügen" })
    .click();
  await expect(page.getByText(websiteName, { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: `Property verknüpfen: ${websiteName}` })
    .click();
  const propertyDialog = page.getByRole("dialog", {
    name: "Property verknüpfen",
  });
  await propertyDialog
    .getByLabel("Property", { exact: true })
    .selectOption(propertyId);
  await propertyDialog
    .getByRole("button", { name: "Property verknüpfen" })
    .click();
  await expect(page.getByText(new RegExp(propertyId))).toBeVisible();
  expect(requests.filter((request) => request.method === "PUT")).toEqual([
    {
      method: "PUT",
      path: `${seo}/websites/second/properties/${provider}`,
      data: { connectionId, propertyId },
    },
  ]);

  for (const width of [320, 390, 760, 761, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await expect(
      page.getByRole("button", { name: `Archivieren: ${websiteName}` }),
    ).toBeVisible();
  }
});

test("SEO remains available with Marketing off and reports stay inside the mobile layout", async ({
  page,
}) => {
  const { requests } = await fixture(page, "viewer");
  await page.goto(`${project}/seo`);
  await expect(
    page.getByRole("heading", { level: 1, name: "SEO" }),
  ).toBeVisible();
  await expect(page.getByText("Marketing", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Websites und Verbindungen verwalten" }),
  ).toHaveCount(0);

  await page.getByLabel("Startdatum").fill("2026-08-01");
  await page.getByLabel("Enddatum").fill("2026-11-10");
  await page.getByRole("button", { name: "Bericht laden" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "höchstens 90 Tage" }),
  ).toContainText("höchstens 90 Tage");
  expect(
    requests.some((request) => request.path.endsWith("/performance")),
  ).toBe(false);
  await page.getByLabel("Startdatum").fill("2026-11-01");
  await page.getByLabel("Gruppieren nach").selectOption("query");
  await page.getByRole("button", { name: "Bericht laden" }).click();
  const table = page.getByRole("table");
  await expect(
    table.getByRole("columnheader", { name: "Suchanfrage" }),
  ).toBeVisible();
  await expect(
    table.getByRole("cell", { name: "42", exact: true }),
  ).toBeVisible();

  for (const width of [320, 390, 760, 761, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await expect(
      page.getByRole("button", { name: "Bericht laden" }),
    ).toBeVisible();
    const scrollRegion = page.getByRole("region", {
      name: "Tabelle mit Leistungsdaten",
      exact: true,
    });
    await scrollRegion.focus();
    await expect(scrollRegion).toBeFocused();
  }
});

for (const condition of ["disabled", "inaccessible"] as const) {
  test(`a deep link never loads data when SEO is ${condition}`, async ({
    page,
  }) => {
    const disabled = condition === "disabled";
    const { requests } = await fixture(
      page,
      disabled ? "owner" : "none",
      !disabled,
    );
    await page.goto(`${project}/seo`);
    await expect(
      page.getByText(disabled ? "Modul ausgeschaltet" : "Kein Zugriff", {
        exact: true,
      }),
    ).toBeVisible();
    expect(requests).toEqual([]);
  });
}
