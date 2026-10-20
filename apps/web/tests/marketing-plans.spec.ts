import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.skip(
  process.env.MARKETING_PLAN_E2E !== "true",
  "Requires isolated synthetic scripts/marketing-plans-browser.ts",
);
test("strategic proposal survives chat closure, owner review and reload without starting work", async ({
  page,
  context,
  baseURL,
}) => {
  const account = JSON.parse(
    readFileSync(".runtime/marketing-plan-browser.json", "utf8"),
  );
  const login = await context.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL! },
    data: { email: account.email, password: account.password },
  });
  expect(login.status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `/p/${account.projectId}/assistant?conversation=${account.conversationId}`,
    );
    await expect(
      page.getByRole("button", { name: "Approve strategy only" }),
    ).toBeVisible();
    await expect(
      page.getByText("Proposed · not active", { exact: true }),
    ).toBeVisible();
    await page.goto(`/p/${account.projectId}/marketing/plans`);
    await page
      .getByRole("link", { name: "Synthetic organic strategy", exact: true })
      .click();
    await expect(page.getByText("No data", { exact: false })).toBeVisible();
    await expect(
      page.getByText("Activation is not available yet", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Approve strategy only" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "All plans", exact: true }).click();
    await expect(
      page.getByRole("link", {
        name: "Synthetic organic strategy",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Synthetic organic strategy", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve strategy only" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `.runtime/ma03-strategy-${viewport.width}.png`,
      fullPage: true,
    });
    await page.goto(`/p/${account.projectId}/decisions`);
    await expect(
      page.getByRole("button", { name: "Approve strategy only" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Approve strategy only" }).click();
  await page.goto(
    `/p/${account.projectId}/marketing/plans?plan=${account.planId}`,
  );
  await expect(
    page.getByText("This revision has strategic approval.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Proposed · not active", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("This revision has strategic approval.", { exact: true }),
  ).toBeVisible();
  const exported = await context.request.get(
    `/api/projects/${account.projectId}/marketing-plans/${account.planId}/export`,
  );
  expect(exported.status()).toBe(200);
  expect((await exported.json()).history.length).toBeGreaterThan(1);
  for (const kind of ["assignments", "jobs", "content", "publications"]) {
    const response = await context.request.get(
      `/api/projects/${account.projectId}/${kind}`,
    );
    expect(response.status()).toBe(200);
    expect((await response.json()).items).toEqual([]);
  }
});
