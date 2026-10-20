import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Opt-in native acceptance fixture, created without starting a worker or a paid provider.
test.skip(
  process.env.E2E_MCP_TASKS !== "1",
  "Requires the isolated MCP task browser fixture",
);
test("native work-order history, exact approval and mobile cancellation", async ({
  page,
}) => {
  const user = JSON.parse(readFileSync(".runtime/mcp2-browser.json", "utf8"));
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(p|o)(\/|$)/);
  await page.goto(`/p/${user.projectId}/assistant`);
  const tasks = page.getByRole("region", { name: "External work orders" });
  await expect(tasks).toBeVisible();
  await expect(
    tasks.getByText("Needs approval", { exact: true }),
  ).toBeVisible();
  await expect(
    tasks.getByText(/Review the beta launch campaign/),
  ).toBeVisible();
  await page.goto(`/p/${user.projectId}/decisions`);
  await expect(
    page.getByText(
      "Review the beta launch campaign and prepare copy for owner approval.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${user.projectId}/assistant`);
  await expect(tasks).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".runtime/mcp2-mobile.png", fullPage: true });
  const canceled = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/assistant-tasks/${user.taskId}/cancel`) &&
      r.request().method() === "POST",
  );
  await tasks.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await canceled).status()).toBe(200);
  await expect(tasks.getByText("Canceled", { exact: true })).toBeVisible();
  const result = await page.request.get(
    `/api/projects/${user.projectId}/assistant-tasks/${user.taskId}`,
  );
  expect((await result.json()).status).toBe("canceled");
});
