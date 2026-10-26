import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The issue center flow (ADR 0018, WP3.15): turn Issues and project
// management on, report two issues in the UI, confirm the duplicate
// suggestion (a merge keeps every report), confirm the issue, create its
// task, finish the task, record the production deployment and see the
// issue released. The Support hand-in and its release note are covered by
// apps/api/tests/issues-sync.integration.test.ts (no inbox needed there).
//
// Needs a stack with ORBIT_ISSUES, ORBIT_WORK and ORBIT_MODULES on; run with
// E2E_ISSUES=1. The tests share one fresh project per run.
test.skip(process.env.E2E_ISSUES !== "1", "needs a stack with ORBIT_ISSUES, ORBIT_WORK and ORBIT_MODULES (E2E_ISSUES=1)");
test.describe.configure({ mode: "serial" });

type Account = { email: string; password: string };
const account = (): Account => JSON.parse(readFileSync(resolve(".runtime/e2e-user.json"), "utf8"));

async function signIn(page: Page) {
  const user = account();
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  const submit = () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/sign-in/email") && r.request().method() === "POST",
    );
    return page
      .getByRole("button", { name: "Sign in", exact: true })
      .click()
      .then(() => response);
  };
  let response = await submit();
  if (response.status() === 429) {
    // Respect the real authentication throttle; never disable it.
    const seconds = Math.min(60, Math.max(1, Number(response.headers()["retry-after"]) || 11));
    await page.waitForTimeout(seconds * 1000);
    response = await submit();
  }
  expect(response.status(), "sign-in response").toBe(200);
  await page.waitForURL(/\/(p|o)(\/|$)/);
}

let projectId = "";
let origin = "";
const run = Date.now().toString(36);

async function api<T = unknown>(request: APIRequestContext, method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: { origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path} -> ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  origin = new URL(baseURL!).origin;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await signIn(page);
    const created = await api<{ id: string }>(page.request, "POST", "/projects", {
      name: `Issues e2e ${run}`,
      timezone: "Europe/Berlin",
      language: "en",
    });
    projectId = created.id;
    await page.goto(`/p/${projectId}/settings?section=modules`);
    for (const name of ["Issues", "Project management"]) {
      await page.getByRole("button", { name: `Turn on: ${name}` }).click();
      await expect(page.getByRole("button", { name: `Turn off: ${name}` })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("report, merge the duplicate, task, deployment and release", async ({ page }) => {
  await signIn(page);
  await page.goto(`/p/${projectId}/issues/list`);
  const report = async (title: string) => {
    await page.getByRole("button", { name: "Report an issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Report an issue" });
    await dialog.getByLabel(/^Title/).fill(title);
    await dialog.getByLabel(/^What happens/).fill("Clicking pay shows an error. Mail me at e2e@example.invalid");
    await dialog.getByRole("button", { name: "Report" }).click();
  };
  await report(`Checkout pay button fails ${run}`);
  const first = page.getByRole("article", { name: new RegExp(`Checkout pay button fails ${run}`) });
  await expect(first).toBeVisible();
  // The e-mail address never reaches the issue.
  await expect(first.getByText("[e-mail removed]").first()).toBeVisible();
  await report(`Pay button in checkout fails ${run}`);
  const second = page.getByRole("article", { name: new RegExp(`Pay button in checkout fails ${run}`) });
  await expect(second.getByRole("heading", { name: "Possible duplicates" })).toBeVisible();
  await second.getByRole("button", { name: /^Merge into ISS-/ }).click();
  await expect(second.getByText("Duplicate").first()).toBeVisible();

  // The kept issue now has both reports; confirm it and create its task.
  await page.goto(`/p/${projectId}/issues/list?status=all`);
  await page.getByRole("button", { name: new RegExp(`Checkout pay button fails ${run}`) }).click();
  const kept = page.getByRole("article", { name: new RegExp(`Checkout pay button fails ${run}`) });
  await expect(kept.getByText("Reports 2").first()).toBeVisible();
  await kept.getByLabel(/^Status/).selectOption("confirmed");
  await expect(kept.getByText("Confirmed").first()).toBeVisible();
  await kept.getByRole("button", { name: "Create task" }).click();
  await expect(kept.getByRole("link", { name: /^#\d+ ISS-\d+: Checkout pay button fails/ })).toBeVisible();

  // The task is done in project management; the issue follows to fix ready.
  const tasks = await api<{ items: Array<{ id: string; version: number; title: string }> }>(page.request, "GET", `/projects/${projectId}/work/tasks?q=${encodeURIComponent(run)}`);
  const task = tasks.items.find((t) => t.title.includes(run))!;
  await api(page.request, "PATCH", `/projects/${projectId}/work/tasks/${task.id}`, { expectedVersion: task.version, status: "done" });
  await expect.poll(async () => {
    await page.reload();
    return page.getByRole("article").getByText("Fix ready").first().isVisible();
  }, { timeout: 30_000 }).toBe(true);

  // A production deployment releases the ready fix.
  const article = page.getByRole("article", { name: new RegExp(`Checkout pay button fails ${run}`) });
  await article.getByRole("button", { name: "Record delivery" }).click();
  const dialog = page.getByRole("dialog", { name: "Record delivery" });
  await dialog.getByLabel(/^Record delivery/).selectOption("deployed");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => {
    await page.goto(`/p/${projectId}/issues/releases`);
    return page.getByText("Released").first().isVisible();
  }, { timeout: 30_000 }).toBe(true);
});

test("the overview shows the figures", async ({ page }) => {
  await signIn(page);
  await page.goto(`/p/${projectId}/issues`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Issues" }).first()).toBeVisible();
  await expect(main.getByText("Median lead times (90 days)")).toBeVisible();
});
