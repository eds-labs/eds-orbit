import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The project management flow (ADR 0016, WP1.12): turn the module on, create
// an initiative and a task in the UI, change the task, comment on it, move
// it on the board with the Move menu and find it in my tasks.
//
// Needs a stack with ORBIT_WORK and ORBIT_MODULES on; run with E2E_WORK=1.
// The tests share one fresh project per run and clean up nothing global.
test.skip(process.env.E2E_WORK !== "1", "needs a stack with ORBIT_WORK and ORBIT_MODULES (E2E_WORK=1)");
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

async function api<T = unknown>(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
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
      name: `Work e2e ${run}`,
      timezone: "Europe/Berlin",
      language: "en",
    });
    projectId = created.id;
    // Settings -> Modules: the owner turns project management on.
    await page.goto(`/p/${projectId}/settings?section=modules`);
    await page.getByRole("button", { name: "Turn on: Project management" }).click();
    await expect(page.getByRole("button", { name: "Turn off: Project management" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("initiative, task, comment, board move and my tasks", async ({ page }) => {
  await signIn(page);

  // A new initiative with a derived key.
  await page.goto(`/p/${projectId}/work/initiatives`);
  await page.getByRole("button", { name: "New initiative" }).click();
  const initiativeDialog = page.getByRole("dialog", { name: "New initiative" });
  await initiativeDialog.getByLabel(/^Title/).fill("Marketplace launch");
  await initiativeDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /ML · Marketplace launch/ })).toBeVisible();

  // A task in it, assigned to the owner and due in the past.
  await page.getByRole("button", { name: "New task" }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await taskDialog.getByLabel(/^Title/).fill(`Check the order flow ${run}`);
  await taskDialog.getByLabel(/^Assignee/).selectOption({ index: 1 });
  await taskDialog.getByLabel(/^Due/).fill("2020-01-01");
  await taskDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: new RegExp(`Check the order flow ${run}`) })).toBeVisible();

  // The task in the list, opened beside it; status and comment.
  await page.goto(`/p/${projectId}/work/tasks`);
  await page.getByRole("button", { name: new RegExp(`Check the order flow ${run}`) }).click();
  const detail = page.getByRole("article", { name: new RegExp(`Check the order flow ${run}`) });
  await expect(detail).toBeVisible();
  await detail.getByLabel(/^Status/).selectOption("in_progress");
  await expect(detail.getByText("changed the status: To do → In progress")).toBeVisible();
  await detail.getByLabel("Add comment").fill("Reproduced on testnet.");
  await detail.getByRole("button", { name: "Comment" }).click();
  await expect(detail.getByText("Reproduced on testnet.")).toBeVisible();

  // The board: the Move menu takes the card to Done.
  await page.goto(`/p/${projectId}/work/board`);
  const inProgress = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "In progress" }) });
  await expect(inProgress.getByText(`Check the order flow ${run}`)).toBeVisible();
  await page.getByLabel("Move to").first().selectOption("done");
  const done = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Done" }) });
  await expect(done.getByText(`Check the order flow ${run}`)).toBeVisible();

  // Done tasks leave my open tasks.
  await page.goto(`/p/${projectId}/work/my`);
  await expect(page.getByText("No tasks yet.")).toBeVisible();
});

test("the overview shows the figures and links to the board", async ({ page }) => {
  await signIn(page);
  await page.goto(`/p/${projectId}/work`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Project management" })).toBeVisible();
  await expect(main.getByText("Open tasks")).toBeVisible();
  await main.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/work/board`));
});
