import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(
  process.env.MARKETING_V2_E2E !== "true",
  "Requires scripts/marketing-agent-v2-browser.ts on the isolated test DB; no worker",
);
test("approval mode remains explicit in management and the confirmation card after reload, on desktop and mobile", async ({
  page,
  context,
  baseURL,
}) => {
  const account = JSON.parse(
    readFileSync(".runtime/marketing-v2-browser.json", "utf8"),
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
    await page.goto(`/p/${account.projectId}/marketing/assignments`);
    await expect(
      page.getByText("Approve each post before any external handoff", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Delegated review under existing approval and veto rules",
        { exact: false },
      ),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Approve each post before any external handoff", {
        exact: false,
      }),
    ).toBeVisible();
    await page.goto(`/p/${account.projectId}/decisions`);
    await expect(
      page.getByText("Approve each post before any external handoff", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("You must explicitly approve each post", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Posts go out after the veto window unless you stop them.",
        { exact: false },
      ),
    ).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await page.goto(
      `/p/${account.projectId}/assistant?conversation=${account.conversationId}`,
    );
    await expect(
      page.getByRole("region", { name: "Assignment result" }),
    ).toBeVisible();
    await expect(
      page.getByText(`Run: ${account.resultRun.id}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Content: ${account.resultRun.contentId}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Awaiting your approval", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Assignment result" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `.runtime/ma01-approval-${viewport.width}.png`,
      fullPage: true,
    });
  }
  const assignments = await context.request.get(
    `/api/projects/${account.projectId}/assignments`,
  );
  expect(assignments.status()).toBe(200);
  const state = await assignments.json();
  expect(
    state.items.find((row: any) => row.id === account.assignmentId),
  ).toMatchObject({ approvalMode: "human_each", status: "draft" });
});
