import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// System administration (ADR 0013) in the browser: an administrator invites
// someone, the invited person sets their own password, and deactivation
// ends their session. Needs ORBIT_ADMINISTRATION=true on the stack and the
// seeded installation's first user, who is its system administrator.

const SEED = resolve(".runtime/e2e-user.json");
function account() {
  return JSON.parse(readFileSync(SEED, "utf8")) as {
    email: string;
    password: string;
  };
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel(/^Account menu/)).toBeVisible();
}

test.describe("system administration", () => {
  test.skip(!existsSync(SEED), "needs the seeded e2e installation");

  test("invite, accept with an own password, deactivate", async ({
    page,
    browser,
  }) => {
    const admin = account();
    await login(page, admin.email, admin.password);
    const me = await page.request.get("/api/me").then((r) => r.json());
    test.skip(!me.systemAdmin, "ORBIT_ADMINISTRATION is off or not an admin");

    // Reached through the account menu, not only by URL.
    await page.getByLabel(/^Account menu/).click();
    await page.getByRole("menuitem", { name: "Administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Project content is not visible here.")).toBeVisible();

    await page.getByRole("link", { name: "Organizations" }).first().click();
    await page.locator("table a.row-button").first().click();
    await page.getByRole("button", { name: "Invite" }).click();
    const email = `${randomUUID()}@example.invalid`;
    const dialog = page.getByRole("dialog", { name: "Invite someone" });
    await dialog.getByLabel(/^E-Mail/).fill(email);
    await dialog.getByRole("button", { name: "Invite" }).click();
    // Without system mail the link is shown once.
    const link = await page
      .getByRole("dialog", { name: "Pass on the link" })
      .locator("code")
      .innerText();
    expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{40,}$/);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("cell", { name: email })).toBeVisible();

    const invited = await browser.newContext();
    const invitee = await invited.newPage();
    const password = randomBytes(18).toString("base64url");
    await invitee.goto(link);
    await expect(invitee.getByText(`For ${email}`, { exact: false })).toBeVisible();
    // The token leaves the address bar once read.
    await expect.poll(() => new URL(invitee.url()).hash).toBe("");
    await invitee.getByLabel(/^Your name/).fill("Synthetic invitee");
    await invitee.getByLabel(/^Choose a password/).fill(password);
    await invitee.getByLabel(/^Repeat the password/).fill(password);
    await invitee
      .getByRole("button", { name: "Create account and accept" })
      .click();
    await expect(invitee.getByLabel(/^Account menu/)).toBeVisible();
    // A member sees neither the administration nor the organization settings.
    await invitee.getByLabel(/^Account menu/).click();
    await expect(invitee.getByRole("menuitem", { name: "Administration" })).toHaveCount(0);

    await page.goto("/admin/users");
    await page.getByLabel("Search name or e-mail").fill(email);
    await page.getByRole("link", { name: "Synthetic invitee" }).click();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("Deactivated").first()).toBeVisible();

    await invitee.reload();
    await expect(
      invitee.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await invited.close();
  });
});
