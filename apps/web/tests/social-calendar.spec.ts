import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The social calendar (ADR 0020, S6): the owner schedules a post and moves it
// with the keyboard (re-approving the new time); an editor moves it again,
// which sends it back to approval; the owner approves it under Approvals. A
// second test moves a draft into the hour the clocks skip.
//
// Needs a stack with ORBIT_SOCIAL, ORBIT_MODULES and ORBIT_ADMINISTRATION on,
// in test mode, seeded with `E2E_SOCIAL=1 node scripts/seed-e2e.ts` (the
// social module and one synthetic Telegram account). Run with E2E_SOCIAL=1.
test.skip(process.env.E2E_SOCIAL !== "1", "needs a stack with ORBIT_SOCIAL seeded by E2E_SOCIAL=1");
test.describe.configure({ mode: "serial" });

type Account = { email: string; password: string; projectId: string };
const owner = (): Account => JSON.parse(readFileSync(resolve(".runtime/e2e-user.json"), "utf8"));
const run = Date.now().toString(36);
const title = `Calendar e2e ${run}`;

async function signIn(page: Page, user: { email: string; password: string }) {
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

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
}

async function api<T = unknown>(request: APIRequestContext, origin: string, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, headers: { origin }, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path} -> ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/** The date `days` from now in Berlin, as YYYY-MM-DD. */
const berlinDate = (days: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + days * 86_400_000),
  );

/** Opens a post of the week by its time with the keyboard and chooses "Move to…". */
async function moveWithKeyboard(page: Page, time: string, to: string, confirm: string) {
  const chip = page.getByRole("button", { name: new RegExp(`^${time} .*${title}`) });
  await chip.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: title });
  await drawer.getByRole("button", { name: "Move to…" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Move post" });
  await dialog.getByLabel("Time", { exact: true }).fill(to);
  await dialog.getByRole("button", { name: confirm }).focus();
  await page.keyboard.press("Enter");
}

test("owner moves an approved post, an editor's move goes back to approval", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const user = owner();
  const origin = new URL(baseURL!).origin;
  const date = berlinDate(2);
  const week = `/p/${user.projectId}/social/calendar?view=week&anchor=${date}`;
  await signIn(page, user);

  // The owner writes and schedules a post for the seeded channel.
  await page.goto(`/p/${user.projectId}/social/posts?new=1`);
  await page.getByLabel("Title (only shown in Orbit)").fill(title);
  await page.getByLabel("Text for all accounts").fill(`Synthetic calendar post ${run}.`);
  await page.getByLabel(/Orbit e2e channel/).check();
  await page.getByLabel("Date", { exact: true }).fill(date);
  await page.getByLabel("Time", { exact: true }).fill("10:00");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText("Approved and planned.")).toBeVisible();

  // The week shows it; the owner moves it with the keyboard and re-approves.
  await page.goto(week);
  await moveWithKeyboard(page, "10:00", "11:30", "Move and approve");
  await expect(page.getByRole("status").filter({ hasText: `Moved to ${date} 11:30.` })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^11:30 .*${title}.*Scheduled`) })).toBeVisible();

  // An editor joins through an invitation and moves it again.
  const editor = { name: "Synthetic editor", email: `orbit-editor-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID() };
  await page.goto(`/p/${user.projectId}/settings?section=members`);
  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  const invite = page.getByRole("dialog", { name: "Invite member" });
  await invite.getByLabel(/^E-Mail/).fill(editor.email);
  await invite.getByLabel(/^Project role/).selectOption("editor");
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  const link = await page.getByRole("dialog", { name: "Pass on the link" }).locator("code").innerText();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await signOut(page);
  await page.goto(link);
  await page.getByLabel(/^Your name/).fill(editor.name);
  await page.getByLabel(/^Choose a password/).fill(editor.password);
  await page.getByLabel(/^Repeat the password/).fill(editor.password);
  await page.getByRole("button", { name: "Create account and accept" }).click();
  await expect(page.getByLabel(/^Account menu/)).toBeVisible();
  await page.goto(week);
  await moveWithKeyboard(page, "11:30", "12:00", "Move and request approval");
  await expect(page.getByRole("status").filter({ hasText: `Moved to ${date} 12:00; waiting for approval.` })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^12:00 .*${title}.*Waiting for approval`) })).toBeVisible();
  await signOut(page);

  // The owner approves it under Approvals; the calendar shows it scheduled.
  await signIn(page, user);
  await page.goto(`/p/${user.projectId}/decisions`);
  const inbox = page.getByRole("region", { name: "Open decisions" });
  await inbox.getByRole("button", { name: "Approve" }).first().click();
  await page.goto(week);
  await expect(page.getByRole("button", { name: new RegExp(`^12:00 .*${title}.*Scheduled`) })).toBeVisible();
  // Leave nothing planned behind.
  const posts = await api<{ items: Array<{ id: string; title: string | null; version: number }> }>(
    page.request,
    origin,
    "GET",
    `/projects/${user.projectId}/social/posts`,
  );
  const mine = posts.items.find((p) => p.title === title)!;
  await api(page.request, origin, "POST", `/projects/${user.projectId}/social/posts/${mine.id}/cancel`, { version: mine.version });
});

test("a move into the hour the clocks skip offers the next valid time", async ({ page, baseURL }) => {
  const user = owner();
  const origin = new URL(baseURL!).origin;
  await signIn(page, user);
  const accounts = await api<{ items: Array<{ id: string; handle: string }> }>(page.request, origin, "GET", `/projects/${user.projectId}/social/accounts`);
  const channel = accounts.items.find((a) => a.handle === "Orbit e2e channel")!;
  const draft = await api<{ id: string; version: number }>(page.request, origin, "POST", `/projects/${user.projectId}/social/posts`, {
    title,
    baseText: `Synthetic draft ${run}.`,
    baseMedia: [],
    variants: [{ accountId: channel.id, text: null, media: null, options: {} }],
  });
  // A draft moves freely: put it on the Saturday before the change.
  await api(page.request, origin, "POST", `/projects/${user.projectId}/social/posts/${draft.id}/reschedule`, {
    version: draft.version,
    local: "2027-03-27T10:00",
    timeZone: "Europe/Berlin",
  });
  await page.goto(`/p/${user.projectId}/social/calendar?view=week&anchor=2027-03-27`);
  const chip = page.getByRole("button", { name: new RegExp(`^10:00 .*${title}`) });
  await chip.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: title }).getByRole("button", { name: "Move to…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move post" });
  await dialog.getByLabel("Date", { exact: true }).fill("2027-03-28");
  await dialog.getByLabel("Time", { exact: true }).fill("02:30");
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(dialog.getByText("This time does not exist on that day because the clocks change.")).toBeVisible();
  await dialog.getByRole("button", { name: "Use 2027-03-28 03:00" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to 2027-03-28 03:00." })).toBeVisible();
  const moved = await api<{ version: number }>(page.request, origin, "GET", `/projects/${user.projectId}/social/posts/${draft.id}`);
  await api(page.request, origin, "POST", `/projects/${user.projectId}/social/posts/${draft.id}/archive`, { version: moved.version });
});
