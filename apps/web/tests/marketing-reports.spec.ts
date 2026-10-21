import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.skip(
  process.env.MARKETING_REPORT_E2E !== "true",
  "Requires isolated synthetic reports fixture",
);
test("saved periodic evidence, owner receipt and proposed revision survive reload", async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = JSON.parse(
    readFileSync(".runtime/marketing-report-browser.json", "utf8"),
  );
  const signIn = await context.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL! },
    data: { email: fixture.email, password: fixture.password },
  });
  expect(signIn.status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
  const path = `/p/${fixture.projectId}/marketing/analytics?report=${fixture.reportId}`;
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    const reports = page.getByRole("region", { name: "Marketing reports" });
    await expect(
      reports.getByText("Plan-attributed measurements", { exact: true }),
    ).toBeVisible();
    await expect(
      reports.getByText(
        "Full-period coverage is not established; missing measurements are not zeros.",
      ),
    ).toBeVisible();
    await expect(
      reports.getByText("Sessions: 12", { exact: false }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Mark report read" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `.runtime/ma07-report-${viewport.width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Mark report read" }).click();
  await expect(
    page.getByRole("button", { name: "Mark report read" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Prepare proposed plan revision" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare proposed plan revision" })
    .click();
  await expect(
    page.getByRole("link", { name: "Review proposed revision" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Review proposed revision" }).click();
  await expect(
    page.getByRole("button", { name: "Approve strategy only" }),
  ).toBeVisible();
  for (const kind of ["assignments", "publications", "postiz_drafts"]) {
    const response = await context.request.get(
      `/api/projects/${fixture.projectId}/${kind}`,
    );
    expect(response.status()).toBe(200);
    expect((await response.json()).items).toEqual([]);
  }
});
