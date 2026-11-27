import { existsSync } from "node:fs";
import { test, expect } from "./fixtures";
import { SEED, signIn } from "./settings-center-helpers";

test.skip(!existsSync(SEED), "needs the seeded e2e installation");

test("chooses Light, Dark or System and keeps the preference across reloads", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page);

  const root = page.locator("html");
  const menu = page.getByLabel(/^Account menu/);
  const choice = (name: string) =>
    page.getByRole("menuitemradio", { name, exact: true });
  const background = () =>
    root.evaluate((el) => getComputedStyle(el).backgroundColor);
  const dark = "rgb(11, 23, 36)";
  const light = "rgb(247, 252, 255)";

  await expect.poll(background).toBe(dark);
  await menu.click();
  await expect(choice("System")).toHaveAttribute("aria-checked", "true");
  await choice("Dark").press("ArrowUp");
  await expect(choice("Light")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(choice("Light")).toHaveAttribute("aria-checked", "true");
  await expect.poll(background).toBe(light);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(root).toHaveAttribute("data-appearance", "light");
  await menu.click();
  await expect(choice("Light")).toHaveAttribute("aria-checked", "true");

  await page.emulateMedia({ colorScheme: "light" });
  await choice("Dark").click();
  await expect.poll(background).toBe(dark);
  await page.reload();
  await expect(root).toHaveAttribute("data-appearance", "dark");
  await expect.poll(background).toBe(dark);

  await page.setViewportSize({ width: 390, height: 844 });
  await menu.click();
  await choice("System").click();
  await expect(choice("System")).toHaveAttribute("aria-checked", "true");
  await expect.poll(background).toBe(light);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).toBe(dark);
  await choice("System").press("Escape");
  await expect(menu).toBeFocused();
  await expect(choice("System")).toBeHidden();
  expect(errors).toEqual([]);
});
