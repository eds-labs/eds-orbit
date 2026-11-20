import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Content Hub acceptance (ADR 0029, CH1.18). The owner writes an article,
// publishes it, schedules an update, sees it in the calendar, cancels the
// schedule, compares and restores a version and withdraws the article. A
// second test sets publication approvals to the owner alone: an editor's
// publication then waits under Decisions until the owner approves it there.
//
// Needs a stack with ORBIT_CMS, ORBIT_MODULES and ORBIT_ADMINISTRATION on, in
// test mode, seeded with `E2E_CMS=1 node scripts/seed-e2e.ts` (the content
// module and one synthetic website). Run with E2E_CMS=1.
test.skip(
  process.env.E2E_CMS !== "1",
  "needs a stack with ORBIT_CMS seeded by E2E_CMS=1",
);
test.describe.configure({ mode: "serial" });

type Account = { email: string; password: string; projectId: string };
const owner = (): Account =>
  JSON.parse(readFileSync(resolve(".runtime/e2e-user.json"), "utf8"));
const run = Date.now().toString(36);

async function signIn(page: Page, user: { email: string; password: string }) {
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

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
}

async function api<T = unknown>(
  request: APIRequestContext,
  origin: string,
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

type Status = {
  settings: Record<string, unknown> & { publishApprovers: string };
  settingsVersion: number;
};

async function setApprovers(
  request: APIRequestContext,
  origin: string,
  projectId: string,
  approvers: "owner" | "owner_or_editor",
) {
  const status = await api<Status>(
    request,
    origin,
    "GET",
    `/projects/${projectId}/cms/status`,
  );
  if (status.settings.publishApprovers === approvers) return;
  await api(request, origin, "PUT", `/projects/${projectId}/cms/settings`, {
    version: status.settingsVersion,
    settings: { ...status.settings, publishApprovers: approvers },
  });
}

/** The date `days` from now in Berlin, as YYYY-MM-DD. */
const berlinDate = (days: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 86_400_000));

/** Types into the article text and waits until the autosave stored it. */
/** The next draft save's answer (any status). */
const draftSave = (page: Page, ok = true) =>
  page.waitForResponse(
    (r) =>
      /\/cms\/entries\/[^/]+\/draft$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "PATCH" &&
      r.ok() === ok,
  );

async function typeText(page: Page, text: string) {
  const body = page.getByRole("textbox", { name: "Article text" });
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function write(page: Page, text: string) {
  const saved = draftSave(page);
  await typeText(page, text);
  await saved;
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

test("owner publishes, schedules, restores and withdraws an article", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const user = owner();
  const origin = new URL(baseURL!).origin;
  const title = `Orbit e2e Artikel ${run}`;
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page, user);

  // A new German article for the seeded website.
  await page.goto(`/p/${user.projectId}/cms/entries`);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel(/Orbit e2e site/).check();
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await page.waitForURL(/[?&]entry=/);
  const entryId = new URL(page.url()).searchParams.get("entry")!;
  await expect(
    page.getByRole("textbox", { name: "Article text" }),
  ).toBeVisible();

  // An address another entry uses is refused; the text still saves.
  const taken = await api<{ entry: { slug: string } }>(
    page.request,
    origin,
    "POST",
    `/projects/${user.projectId}/cms/entries`,
    { type: "article", locale: "de", title: `Belegt ${run}` },
  );
  await page.getByRole("tab", { name: "SEO" }).click();
  const refusedSlug = draftSave(page, false);
  await page.getByLabel("Address (slug)").fill(taken.entry.slug);
  await refusedSlug;
  await expect(page.getByText("Not saved: Address.")).toBeVisible();
  const textSaved = draftSave(page);
  await typeText(page, `Erster Absatz ${run}.`);
  await textSaved;
  const slugSaved = draftSave(page);
  await page.getByLabel("Address (slug)").fill(`artikel-${run}`);
  await slugSaved;
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Publishing" }).click();

  // Publish now.
  await expect(page.getByText("Nothing stops a publication.")).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published.", { exact: true })).toBeVisible();

  // Change the text and schedule the update for tomorrow 10:00 Berlin time.
  await write(page, ` Zweiter Satz ${run}.`);
  const day = berlinDate(1);
  await page.getByRole("radio", { name: "At" }).check();
  await page.locator('input[type="datetime-local"]').fill(`${day}T10:00`);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText("Scheduled.", { exact: true })).toBeVisible();

  // The calendar shows the schedule on its day.
  await page.goto(`/p/${user.projectId}/cms/calendar`);
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  const [year, month] = day.split("-").map(Number);
  const now = new Date();
  if (year * 12 + month > now.getFullYear() * 12 + now.getMonth() + 1)
    await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: title })
      .filter({ hasText: "Scheduled" })
      .last(),
  ).toBeVisible();

  // Back in the editor: cancel the schedule.
  await page.goto(`/p/${user.projectId}/cms/entries?entry=${entryId}`);
  await page
    .getByRole("button", { name: "Cancel schedule", exact: true })
    .click();
  await expect(page.getByText("Cancelled.", { exact: true })).toBeVisible();

  // History: version 1 differs from the draft; restoring it drops the second sentence.
  await page.getByRole("tab", { name: "History" }).click();
  const first = page.getByRole("listitem").filter({ hasText: /^#1\b/ });
  await first.getByRole("button", { name: "Compare with the draft" }).click();
  const diff = page.getByRole("dialog", {
    name: "Version #1 compared with the draft",
  });
  await expect(
    diff.getByText(`Zweiter Satz ${run}.`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Publish" })
      .filter({ hasText: "Orbit e2e site" })
      .first(),
  ).toBeVisible();
  await first.getByRole("button", { name: "Restore into the draft" }).click();
  const body = page.getByRole("textbox", { name: "Article text" });
  await expect(body).toContainText(`Erster Absatz ${run}.`);
  await expect(body).not.toContainText("Zweiter Satz");

  // Withdraw it again; the entry leaves every website.
  await page.getByRole("tab", { name: "Publishing" }).click();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByText("Withdrawn.", { exact: true })).toBeVisible();
  const detail = await api<{ entry: { publishedRevisionId: string | null } }>(
    page.request,
    origin,
    "GET",
    `/projects/${user.projectId}/cms/entries/${entryId}`,
  );
  expect(detail.entry.publishedRevisionId).toBeNull();
});

test("an editor's publication waits for the owner under Decisions", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const user = owner();
  const origin = new URL(baseURL!).origin;
  const title = `Orbit e2e Freigabe ${run}`;
  await signIn(page, user);
  await setApprovers(page.request, origin, user.projectId, "owner");
  try {
    const sites = await api<{ items: Array<{ id: string; name: string }> }>(
      page.request,
      origin,
      "GET",
      `/projects/${user.projectId}/cms/sites`,
    );
    const site = sites.items.find((s) => s.name === "Orbit e2e site")!;
    const created = await api<{ entry: { id: string } }>(
      page.request,
      origin,
      "POST",
      `/projects/${user.projectId}/cms/entries`,
      {
        type: "article",
        locale: "de",
        title,
        siteIds: [site.id],
      },
    );
    const editorUrl = `/p/${user.projectId}/cms/entries?entry=${created.entry.id}`;

    // An editor joins through an invitation.
    const editor = {
      name: "Synthetic content editor",
      email: `orbit-cms-editor-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
    };
    await page.goto(`/manage/p/${user.projectId}/members`);
    await page
      .getByRole("button", { name: "Invite member", exact: true })
      .click();
    const invite = page.getByRole("dialog", { name: "Invite member" });
    await invite.getByLabel(/^E-Mail/).fill(editor.email);
    await invite.getByLabel(/^Project role/).selectOption("editor");
    await invite.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await page
      .getByRole("dialog", { name: "Pass on the link" })
      .locator("code")
      .innerText();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("link", { name: /Back to project/ }).click();
    await signOut(page);
    await page.goto(link);
    await page.getByLabel(/^Your name/).fill(editor.name);
    await page.getByLabel(/^Choose a password/).fill(editor.password);
    await page.getByLabel(/^Repeat the password/).fill(editor.password);
    await page
      .getByRole("button", { name: "Create account and accept" })
      .click();
    await expect(page.getByLabel(/^Account menu/)).toBeVisible();

    // The editor writes and asks for publication.
    await page.goto(editorUrl);
    await write(page, `Text des Editors ${run}.`);
    await expect(
      page.getByText("Publishing and updates are approved by the owner."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByText("Requested. The decision waits under Decisions."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel request", exact: true }),
    ).toBeVisible();
    await signOut(page);

    // The owner sees exactly what the approval covers and approves it.
    await signIn(page, user);
    await page.goto(`/p/${user.projectId}/decisions`);
    const inbox = page.getByRole("region", { name: "Open decisions" });
    const request = inbox.locator("article").filter({
      has: page.getByRole("heading", { name: `Publish article: ${title}` }),
    });
    await expect(
      request.getByText("Version #1", { exact: false }),
    ).toBeVisible();
    await expect(request.getByText("Websites: Orbit e2e site")).toBeVisible();
    await expect(request.getByText("Immediately after approval")).toBeVisible();
    await request.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(request).toHaveCount(0);
    await expect
      .poll(async () => {
        const detail = await api<{
          entry: { publishedRevisionId: string | null };
        }>(
          page.request,
          origin,
          "GET",
          `/projects/${user.projectId}/cms/entries/${created.entry.id}`,
        );
        return detail.entry.publishedRevisionId !== null;
      })
      .toBe(true);
  } finally {
    await setApprovers(page.request, origin, user.projectId, "owner_or_editor");
  }
});
