import { expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Shared by the settings center specs: the seeded installation's first user
// (system administrator and organization owner) and the sign-in that
// respects the real authentication throttle.

export const SEED = resolve(".runtime/e2e-user.json");

export type Stage = "off" | "preview" | "on";

/**
 * The settings center's stage (ORBIT_SETTINGS_CENTER) as `/api/me` reports
 * it to the signed-in member; "off" when it reports none. Specs that pass
 * through an old settings address branch on it: with "on" every old address
 * leads to the center.
 */
export async function stage(page: Page): Promise<Stage> {
  const me = await page.request.get("/api/me").then((r) => r.json());
  const value = me?.settingsCenter;
  return value === "preview" || value === "on" ? value : "off";
}

export async function signIn(page: Page) {
  const user = JSON.parse(readFileSync(SEED, "utf8")) as {
    email: string;
    password: string;
  };
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
  await expect(page.getByLabel(/^Account menu/)).toBeVisible();
}
