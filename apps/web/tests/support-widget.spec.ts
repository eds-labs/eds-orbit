import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The support flow end to end (WP5.2, WP5.4): a visitor on another origin
// writes through the embedded widget, an agent answers in the workspace, and
// the visitor sees the answer. Needs a stack with ORBIT_SUPPORT,
// ORBIT_MODULES, ORBIT_PUBLIC_INGRESS and (for live updates) ORBIT_REALTIME
// on, the module enabled and a widget inbox for the e2e project; run with
// E2E_SUPPORT=1 and E2E_SUPPORT_KEY=<pk_…> (the inbox's widget key).
test.skip(
  process.env.E2E_SUPPORT !== "1" || !process.env.E2E_SUPPORT_KEY,
  "needs a support-enabled stack (E2E_SUPPORT=1, E2E_SUPPORT_KEY)",
);

const HOST = "https://desk.e2e.test";

function account() {
  return JSON.parse(
    readFileSync(resolve(".runtime/e2e-user.json"), "utf8"),
  ) as {
    email: string;
    password: string;
    projectId: string;
  };
}

async function signIn(page: Page) {
  const user = account();
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(p|o)(\/|$)/);
  return user;
}

test("a visitor on another origin chats with an agent", async ({
  page,
  browser,
  baseURL,
}) => {
  // The host app: a page on its own origin that only embeds the script.
  const visitor = await browser.newPage();
  await visitor.route(`${HOST}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Desk</title><h1>Desk</h1>
<script>window.OrbitSupportConfig = ${JSON.stringify({ key: process.env.E2E_SUPPORT_KEY, locale: "en" })};</script>
<script src="${baseURL}/widget/v1.js" async></script>`,
    }),
  );
  await visitor.goto(`${HOST}/`);
  const widget = visitor.locator("[data-orbit-support]");
  await widget.getByRole("button", { name: "Open support chat" }).click();
  await widget.getByLabel("Your e-mail").fill("e2e-visitor@example.org");
  await widget.getByRole("button", { name: "Start" }).click();
  await widget.getByRole("button", { name: "New conversation" }).click();
  await widget.getByLabel("Your message").fill("E2E: where is my deposit?");
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(widget.getByText("E2E: where is my deposit?")).toBeVisible();

  // The agent answers in the workspace.
  const user = await signIn(page);
  await page.goto(`/p/${user.projectId}/support/tickets`);
  await page
    .getByRole("button", { name: /E2E: where is my deposit\?/ })
    .first()
    .click();
  await page.getByLabel("Reply").fill("E2E: it arrives within the hour.");
  await page.getByRole("button", { name: "Send reply" }).click();

  // The visitor sees it without reloading; the host page kept working.
  await expect(
    widget.getByText("E2E: it arrives within the hour."),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(visitor.getByRole("heading", { name: "Desk" })).toBeVisible();
});

test("the host page keeps working when Orbit is unreachable (H05)", async ({
  browser,
}) => {
  const visitor = await browser.newPage();
  await visitor.route(`${HOST}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Desk</title><h1>Desk</h1><button>Trade</button>
<script>window.OrbitSupportConfig = { key: "pk_${"x".repeat(32)}" };</script>
<script src="https://orbit.unreachable.invalid/widget/v1.js" async></script>`,
    }),
  );
  const errors: string[] = [];
  visitor.on("pageerror", (e) => errors.push(e.message));
  await visitor.goto(`${HOST}/`);
  await expect(visitor.getByRole("button", { name: "Trade" })).toBeEnabled();
  expect(errors).toEqual([]);
});
