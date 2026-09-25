import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function account() {
  return JSON.parse(
    readFileSync(resolve(".runtime/e2e-user.json"), "utf8"),
  ) as { email: string; password: string; projectId: string };
}

test("private chat blocks without a paid mandate and resumes after reload and project switch", async ({
  page,
}) => {
  const user = account();
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your marketing, in orbit." }),
  ).toBeVisible();
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Orbit Chat" })).toBeVisible();
  const message = `Synthetic chat acceptance ${Date.now()}`;
  await page.getByLabel("Message Orbit").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(
    page.getByText(/POLICY_REQUIRED|APPROVED_PAID_BUDGET_REQUIRED/),
  ).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  const project = await page.request.post("/api/projects", {
    data: {
      name: `Chat isolation ${Date.now()}`,
      timezone: "Europe/Berlin",
      language: "en",
    },
    headers: { Origin: "http://localhost:4310" },
  });
  expect(project.status()).toBe(201);
  const otherId = (await project.json()).id as string;
  await page.reload();
  await page.locator("#project").selectOption(otherId);
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await page.locator("#project").selectOption(user.projectId);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .getByRole("navigation", { name: "Mobile workspace" })
      .getByRole("link", { name: "Orbit Chat" }),
  ).toBeVisible();
});

test("renders streamed text, action states, source links and cancellation", async ({
  page,
}) => {
  const user = account();
  await page.goto("/");
  await page.getByLabel(/^Email/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your marketing, in orbit." }),
  ).toBeVisible();
  const conversationId = "b38d9050-3dba-4ae0-851e-98d5b59e8001";
  const runId = "b38d9050-3dba-4ae0-851e-98d5b59e8002";
  let canceled = false;
  await page.route(
    `**/api/projects/${user.projectId}/chat/conversations?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: conversationId,
              title: "Synthetic plan",
              updatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/chat/conversations/${conversationId}?*`,
    (route) =>
      route.fulfill({
        json: {
          conversation: {
            id: conversationId,
            title: "Synthetic plan",
            updatedAt: new Date().toISOString(),
          },
          messages: [
            {
              id: "source-message",
              role: "assistant",
              text: "Check the cited source.",
              cards: [
                {
                  kind: "source",
                  label: "Official source",
                  href: "/knowledge",
                  status: "verified",
                },
              ],
            },
          ],
          runs: [],
          proposals: [
            {
              id: "proposal-1",
              groupId: "group-1",
              version: 1,
              payloadHash: "0".repeat(64),
              status: "proposed",
              action: null,
              payload: {
                mission: {
                  title: "Synthetic week",
                  goal: "Explain the product",
                  audience: "Test audience",
                  channels: ["x-test"],
                  startAt: new Date().toISOString(),
                  endAt: new Date(Date.now() + 86400000).toISOString(),
                  maxContents: 1,
                  sourceIds: [],
                  assetIds: [],
                },
                firstDraftMaxMicros: 100,
                planMaxMicros: 100,
                sources: [],
                assets: [],
              },
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/chat/conversations/${conversationId}/messages`,
    (route) =>
      route.fulfill({ status: 202, json: { runId, status: "queued" } }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/chat/runs/${runId}/cancel`,
    (route) => {
      canceled = true;
      return route.fulfill({ json: { id: runId, status: "canceled" } });
    },
  );
  await page.route(
    `**/api/projects/${user.projectId}/chat/runs/${runId}/events`,
    (route) => {
      const status = canceled ? "canceled" : "running";
      const body = `id: ${canceled ? 2 : 1}\nevent: snapshot\ndata: ${JSON.stringify({ id: runId, status, partialText: "Streaming synthetic update", errorCode: null, sequence: canceled ? 2 : 1 })}\n\n`;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body,
      });
    },
  );
  await page.goto("/chat");
  await page.getByRole("button", { name: "Synthetic plan" }).click();
  await expect(
    page.getByRole("link", { name: "Official source" }),
  ).toBeVisible();
  await expect(page.getByText("Proposed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Confirmation required", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message Orbit").fill("Show progress");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Streaming synthetic update")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => canceled).toBe(true);
  await expect(page.getByText(/Canceled/)).toBeVisible({ timeout: 15000 });
});
