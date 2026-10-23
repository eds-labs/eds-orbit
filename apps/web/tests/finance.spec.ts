import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The finance flow from upload to booking, payment and export (Task 22), plus
// the click flows the static web tests cannot reach: the manual FX rate after
// FX_RATE_MISSING and the version conflict between two pages.
//
// Needs a stack with ORBIT_FINANCE, ORBIT_FILES (database backend) and
// ORBIT_MODULES on; run with E2E_FINANCE=1. AI extraction stays off (the
// upload goes straight to review) and the project's FX source is set to
// "manual" before anything runs, so no provider and no ECB request is ever
// made. The tests share one fresh project per run and clean up nothing
// global.
test.skip(
  process.env.E2E_FINANCE !== "1",
  "needs a finance-enabled stack (E2E_FINANCE=1, ORBIT_FINANCE, ORBIT_FILES, ORBIT_MODULES)",
);
test.describe.configure({ mode: "serial" });

type Account = { email: string; password: string };

function account(): Account {
  return JSON.parse(readFileSync(resolve(".runtime/e2e-user.json"), "utf8"));
}

async function signIn(page: Page) {
  const user = account();
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  const submit = () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    return page
      .getByRole("button", { name: "Sign in", exact: true })
      .click()
      .then(() => response);
  };
  let response = await submit();
  if (response.status() === 429) {
    // Respect the real authentication throttle; never disable it.
    const seconds = Math.min(
      60,
      Math.max(1, Number(response.headers()["retry-after"]) || 11),
    );
    await page.waitForTimeout(seconds * 1000);
    response = await submit();
  }
  expect(response.status(), "sign-in response").toBe(200);
  await page.waitForURL(/\/(p|o)(\/|$)/);
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let projectId = "";
let origin = "";
const run = Date.now().toString(36);

// Same-origin API access with the page's session, as the web app itself does.
async function api<T = unknown>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: { origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path} -> ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

const finance = (path: string) => `/projects/${projectId}/finance${path}`;

// A distinct, still valid PDF per call: identical bytes would be an exact
// duplicate of the first upload. The file goes through the review page's
// upload control.
async function upload(page: Page, variant: string) {
  const pdf = readFileSync(
    resolve("apps/api/tests/fixtures/finance/invoice.pdf"),
  );
  const buffer = Buffer.concat([
    pdf,
    Buffer.from(`\n% e2e ${run} ${variant}\n`),
  ]);
  await page.goto(`/p/${projectId}/finance/review`);
  await page.getByLabel("Choose files").setInputFiles({
    name: `invoice-${variant}.pdf`,
    mimeType: "application/pdf",
    buffer,
  });
  const uploads = page.getByRole("list", { name: "Uploads" });
  await expect(uploads).toContainText(`invoice-${variant}.pdf`);
  await expect(uploads).toContainText("Received.");
  // The queue refreshed in place.
  await expect(
    page.getByRole("button", { name: new RegExp(`invoice-${variant}.pdf`) }),
  ).toBeVisible();
}

async function enableAndSetUp(page: Page) {
  // Settings -> Modules: the owner turns finance on.
  await page.goto(`/p/${projectId}/settings?section=modules`);
  await page.getByRole("button", { name: "Turn on: Finance" }).click();
  await expect(
    page.getByRole("button", { name: "Turn off: Finance" }),
  ).toBeVisible();
  // Never reach the network for rates: manual FX source, set before the
  // first request that could trigger a sync.
  const current = await api<{ version: number }>(
    page.request,
    "GET",
    finance("/settings"),
  );
  await api(page.request, "PUT", finance("/settings"), {
    version: current.version,
    settings: { fxSource: "manual", aiExtraction: "off" },
  });
  // The setup screen creates the default chart.
  await page.goto(`/p/${projectId}/finance`);
  await page
    .getByRole("button", { name: "Create default chart of accounts" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Set up your books" }),
  ).toBeHidden();
}

async function openFirstDocument(page: Page, name: string) {
  await page.goto(`/p/${projectId}/finance/review`);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const detail = page.getByRole("article", { name: new RegExp(name) });
  await expect(detail).toBeVisible();
  return detail;
}

// Fields by the start of their label text: a label that wraps a select also
// contains the select's option texts.
const field = (scope: Locator | Page, label: string) =>
  scope.getByLabel(
    new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );

async function fillLine(
  form: Locator,
  index: number,
  line: { description: string; amount: string },
) {
  const group = form.getByRole("group", { name: `Line ${index + 1}` });
  await field(group, "Description").fill(line.description);
  await field(group, "Net amount").fill(line.amount);
  await field(group, "Tax").fill("0");
  await field(group, "Category").selectOption({ index: 1 });
  return group;
}

test("upload to booking, payment and export, on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const created = await api<{ id: string }>(page.request, "POST", "/projects", {
    name: `Finance e2e ${run}`,
    timezone: "Europe/Berlin",
    language: "en",
  });
  projectId = created.id;
  await enableAndSetUp(page);

  // Two cost centers for a 50/50 split.
  for (const [code, name] of [
    ["PRD", "Product"],
    ["OPS", "Operations"],
  ] as const)
    await api(page.request, "POST", finance("/cost-centers"), { code, name });

  await upload(page, "main");

  // The review queue shows the document; open it.
  const detail = await openFirstDocument(page, "invoice-main.pdf");
  const form = detail.getByRole("form", { name: "Booking" });
  await expect(form).toBeVisible();

  // Fill in the form; create the counterparty inline and select it.
  await field(form, "Number").fill(`E2E-${run}`);
  await field(form, "Currency").selectOption("USD");
  await field(form, "Issue date").fill(today());
  await field(form, "Due date").fill(today());
  await field(form, "Counterparty").selectOption({
    label: "New counterparty…",
  });
  await field(form, "Name of the new counterparty").fill("E2E Hosting GmbH");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  const counterparty = field(form, "Counterparty");
  await expect(counterparty.locator("option:checked")).toHaveText(
    "E2E Hosting GmbH",
  );
  // Selecting it kept the other fields.
  await expect(field(form, "Number")).toHaveValue(`E2E-${run}`);
  await expect(field(form, "Currency")).toHaveValue("USD");
  await expect(field(form, "Issue date")).toHaveValue(today());

  // One line, split 50/50 across the two cost centers.
  const line = await fillLine(form, 0, {
    description: "Hosting",
    amount: "100.00",
  });
  await line.getByRole("button", { name: "Add cost center" }).click();
  await line.getByRole("button", { name: "Add cost center" }).click();
  const centers = field(line, "Cost center");
  await centers.nth(0).selectOption({ label: "PRD · Product" });
  await centers.nth(1).selectOption({ label: "OPS · Operations" });
  const shares = field(line, "Share (%)");
  await shares.nth(0).fill("50");
  await shares.nth(1).fill("50");

  await form.getByRole("button", { name: "Book", exact: true }).click();
  await expect(detail.getByText("Booked.")).toBeVisible();

  // The overview shows the expense and one open invoice.
  await page.goto(`/p/${projectId}/finance`);
  const expenses = page
    .locator(".kpi, .metric, .panel, section")
    .filter({ hasText: "Expenses this month" })
    .first();
  await expect(expenses).toContainText("100");
  const open = page
    .locator(".kpi, .metric, .panel, section")
    .filter({ hasText: "Open invoices" })
    .first();
  await expect(open).toContainText("100");

  // Mobile: the overview and the review list render without horizontal scroll.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/p/${projectId}/finance`);
  await expect(
    page
      .getByRole("heading", { name: "Open invoices" })
      .or(page.getByText("Open invoices").first()),
  ).toBeVisible();
  await page.goto(`/p/${projectId}/finance/review`);
  await expect(
    page.getByRole("heading", { name: "Documents to review" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "no horizontal page scroll at 375px").toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 960 });

  // Record the payment on the invoices page; the invoice shows as paid.
  await page.goto(`/p/${projectId}/finance/invoices`);
  await page.getByRole("checkbox", { name: `Select: E2E-${run}` }).check();
  await page.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("region", { name: "Record payment" });
  await expect(payment).toBeVisible();
  await field(payment, "Payment account").selectOption({ index: 1 });
  await payment.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(`E2E-${run}`) });
  await expect(row).toContainText("Paid");

  // The journal export appears in the history with a download link.
  await page.goto(`/p/${projectId}/finance/reports`);
  await page
    .getByLabel("Use a custom period for the journal and documents")
    .check();
  await field(page, "From").fill(`${today().slice(0, 4)}-01-01`);
  await field(page, "To").fill(today());
  await page.locator('[data-export="journal_csv"]').click();
  await expect(page.getByText("Export ready.")).toBeVisible();
  const history = page.getByRole("region", { name: "Export history" });
  const historyRow = history.getByRole("row", { name: /Journal \(CSV\)/ });
  await expect(historyRow).toBeVisible();
  const href = await historyRow
    .getByRole("link", { name: "Download" })
    .getAttribute("href");
  expect(href).toMatch(/\/exports\/.+\/file$/);
});

test("a foreign-currency document asks for the rate after FX_RATE_MISSING", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  // EUR is enabled by default next to the USD base; no rate is stored.
  await upload(page, "fx");
  const detail = await openFirstDocument(page, "invoice-fx.pdf");
  const form = detail.getByRole("form", { name: "Booking" });
  await field(form, "Currency").selectOption("EUR");
  await field(form, "Issue date").fill(today());
  await field(form, "Counterparty").selectOption({
    label: "E2E Hosting GmbH",
  });
  await fillLine(form, 0, { description: "Domain", amount: "10.00" });
  await form.getByRole("button", { name: "Book", exact: true }).click();

  const rate = field(form, "Rate on the issue date");
  await expect(rate).toBeVisible();
  await expect(form.getByText("Exchange rate needed.")).toBeVisible();
  await rate.fill("1.100000");
  await form.getByRole("button", { name: "Book", exact: true }).click();
  await expect(detail.getByText("Booked.")).toBeVisible();
});

test("a version conflict between two pages is recovered with Reload", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await upload(page, "conflict");

  // Page B shares the session; it opens the same document.
  const second = await browser.newContext({
    storageState: await page.context().storageState(),
    baseURL,
  });
  const pageB = await second.newPage();
  try {
    const detailA = await openFirstDocument(page, "invoice-conflict.pdf");
    const detailB = await openFirstDocument(pageB, "invoice-conflict.pdf");
    const formA = detailA.getByRole("form", { name: "Booking" });
    const formB = detailB.getByRole("form", { name: "Booking" });

    // A saves a draft; B still holds the old version.
    await field(formA, "Number").fill(`CONFLICT-${run}`);
    await formA.getByRole("button", { name: "Save draft" }).click();
    await expect(detailA.getByText("Draft saved.")).toBeVisible();

    await field(formB, "Currency").selectOption("USD");
    await field(formB, "Issue date").fill(today());
    await field(formB, "Counterparty").selectOption({
      label: "E2E Hosting GmbH",
    });
    await fillLine(formB, 0, { description: "Support", amount: "20.00" });
    await formB.getByRole("button", { name: "Book", exact: true }).click();
    await expect(detailB.getByText(/changed elsewhere/)).toBeVisible();

    // Reload re-seeds B from the saved draft; booking then succeeds.
    await detailB.getByRole("button", { name: "Reload" }).click();
    await expect(detailB.getByText(/changed elsewhere/)).toBeHidden();
    await expect(
      field(detailB.getByRole("form", { name: "Booking" }), "Number"),
    ).toHaveValue(`CONFLICT-${run}`);
    const reseeded = detailB.getByRole("form", { name: "Booking" });
    await field(reseeded, "Currency").selectOption("USD");
    await field(reseeded, "Issue date").fill(today());
    await field(reseeded, "Counterparty").selectOption({
      label: "E2E Hosting GmbH",
    });
    await fillLine(reseeded, 0, { description: "Support", amount: "20.00" });
    await reseeded.getByRole("button", { name: "Book", exact: true }).click();
    await expect(detailB.getByText("Booked.")).toBeVisible();
  } finally {
    await second.close();
  }
});
