import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
test.skip(
  process.env.MARKETING_PLAN_E2E !== "true",
  "Requires isolated synthetic scripts/marketing-plans-browser.ts",
);
test("strategy survives chat closure; exact owner activation and pause remain separate", async ({
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
      page.getByText("Starting work requires separate approval", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Pending reviews per assignment", { exact: true }),
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
  const strategy = (await exported.json()).plan;
  const proposed = await context.request.post(
    `/api/projects/${account.projectId}/marketing-plans/${account.planId}/activation`,
    {
      headers: { Origin: baseURL! },
      data: {
        version: strategy.version,
        children: [
          {
            key: "weekly",
            assignment: {
              name: "Exact browser mandate",
              kind: "standing",
              contentType: "social",
              channels: strategy.spec.channels,
              schedule: { ...strategy.spec.cadence, leadMinutes: 360 },
              topicFrame: "Reviewed beta product education",
              image: true,
              styleAssetIds: [],
              monthlyBudgetMicros: 20_000_000,
              pendingReviewLimit: 4,
              vetoMinutes: 180,
              approvalMode: "human_each",
              delivery: "publish",
            },
          },
        ],
      },
    },
  );
  expect(proposed.status(), await proposed.text()).toBe(200);
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `/p/${account.projectId}/marketing/plans?plan=${account.planId}`,
    );
    await expect(
      page.getByText("At most 4; new generation waits when full", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Activate assignments", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Exact browser mandate", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `.runtime/ma04-activation-${viewport.width}.png`,
      fullPage: true,
    });
    await page.goto(`/p/${account.projectId}/decisions`);
    await expect(
      page.getByRole("button", { name: "Activate assignments", exact: true }),
    ).toBeDisabled();
  }
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Activate assignments", exact: true })
    .click();
  await page.goto(
    `/p/${account.projectId}/marketing/plans?plan=${account.planId}`,
  );
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Owned by this plan", { exact: false }),
  ).toBeVisible();
  // MA-06: saved operational evidence only; no scheduler, worker or provider.
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/marketing-run-browser.ts"],
    { stdio: "pipe" },
  );
  await page.reload();
  await expect(
    page.getByText("Outcome unknown: reconcile before continuing", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Check outcome; do not resend",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Pause plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause plan", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  const assignments = await context.request.get(
    `/api/projects/${account.projectId}/assignments`,
  );
  expect((await assignments.json()).items).toHaveLength(1);
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/p/${account.projectId}/marketing/assignments`);
    await expect(
      page.getByText("0 waiting · 0 reserved · limit 4", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Outcome unknown: reconcile before continuing", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Unknown cost (reserved exposure): $0.07", {
        exact: false,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("0 waiting · 0 reserved · limit 4", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `.runtime/ma06-run-status-${viewport.width}.png`,
      fullPage: true,
    });
  }
  for (const kind of ["jobs", "content", "publications", "postiz_drafts"]) {
    const response = await context.request.get(
      `/api/projects/${account.projectId}/${kind}`,
    );
    expect(response.status()).toBe(200);
    expect((await response.json()).items).toEqual([]);
  }
});
