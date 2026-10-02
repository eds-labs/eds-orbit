import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function account() {
  return JSON.parse(
    readFileSync(resolve(".runtime/e2e-user.json"), "utf8"),
  ) as { email: string; password: string; projectId: string };
}

// better-auth allows three sign-ins per 10 seconds; short consecutive tests can
// exceed that, so a rate-limited sign-in waits out the window once.
async function signIn(page: Page) {
  const user = account();
  await page.goto("/");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel(/^Email/).fill(user.email);
    await page.getByLabel(/^Password/).fill(user.password);
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/auth/sign-in/email"),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    if ((await response).status() !== 429) break;
    await page.waitForTimeout(10_500);
  }
  await expect(
    page.getByRole("heading", { name: "Your marketing, in orbit." }),
  ).toBeVisible();
  return user;
}

test("private chat blocks without a paid mandate and resumes after reload and project switch", async ({
  page,
}) => {
  const user = await signIn(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Orbit Chat" })).toBeVisible();
  await page.getByRole("button", { name: "Plan next week" }).click();
  await expect(page.getByLabel("Message Orbit")).toHaveValue(
    /Plan content drafts/,
  );
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByLabel("Message Orbit")).toHaveValue(
    /already imported/,
  );
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
  const user = await signIn(page);
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
              text: "## Reviewable plan\n\n**Budget:** $10 daily\n\n<script>alert(1)</script>",
              cards: [
                {
                  kind: "status",
                  label: "Knowledge retrieval: lexical_degraded · index 1",
                  status: "lexical_degraded",
                },
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
  await page
    .getByRole("button", { name: "Synthetic plan", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Official source" }),
  ).toBeVisible();
  await expect(
    page.getByText("Knowledge retrieval: lexical_degraded · index 1"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reviewable plan" }),
  ).toBeVisible();
  await expect(page.locator(".chat-message strong")).toHaveText("Budget:");
  await expect(page.locator(".chat-message script")).toHaveCount(0);
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

test("starts a content package with one click and shows both drafts", async ({
  page,
}) => {
  const user = await signIn(page);
  const conversationId = "b38d9050-3dba-4ae0-851e-98d5b59e8101";
  const requestId = "b38d9050-3dba-4ae0-851e-98d5b59e8102";
  const packageHash = "c".repeat(64);
  let decision: Record<string, unknown> | null = null;
  const deliverable = (
    key: string,
    channelName: string,
    body: string | null,
  ) => ({
    key,
    channelId: key,
    channelName,
    platform: key,
    plannedSlotAt: null,
    status: body ? "drafted" : "planned",
    errorCode: null,
    content: body ? { id: `${key}-content`, body, status: "draft" } : null,
    review: body
      ? { valid: false, problems: ["HUMAN_CONTENT_REVIEW_REQUIRED"] }
      : null,
  });
  await page.route(
    `**/api/projects/${user.projectId}/chat/conversations?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: conversationId,
              title: "Synthetic beta package",
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
            title: "Synthetic beta package",
            updatedAt: new Date().toISOString(),
          },
          messages: [],
          runs: [],
          proposals: [],
          packages: [
            {
              id: "package-1",
              goal: "Announce that beta access is open",
              status: decision ? "completed" : "proposed",
              ceilingMicros: 120000,
              image: {
                prompt: "Abstract open door of soft light, no text",
                maxCostMicros: 50000,
                status: decision ? "generated" : "planned",
                assetId: decision ? "asset-1" : null,
                href: decision
                  ? `/api/projects/${user.projectId}/assets/asset-1/content`
                  : null,
                errorCode: null,
              },
              actionRequest: {
                id: requestId,
                version: 1,
                packageHash,
                status: decision ? "consumed" : "pending",
              },
              deliverables: [
                deliverable(
                  "x",
                  "Synthetic X",
                  decision ? "Beta access is open. Learn more." : null,
                ),
                deliverable(
                  "telegram",
                  "Synthetic Telegram",
                  decision ? "Beta access is now open for teams." : null,
                ),
              ],
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/action-requests/${requestId}/decide`,
    (route) => {
      decision = route.request().postDataJSON();
      return route.fulfill({
        json: { id: requestId, version: 2, status: "approved" },
      });
    },
  );
  await page.goto("/chat");
  await page
    .getByRole("button", { name: "Synthetic beta package", exact: true })
    .click();
  const card = page.getByRole("region", { name: "Content package" });
  await expect(card.getByText("Confirmation required")).toBeVisible();
  await expect(card.getByText("Synthetic Telegram")).toBeVisible();
  await expect(card.getByText(/Nothing is published/)).toBeVisible();
  await card.getByRole("button", { name: "Start package" }).click();
  await expect
    .poll(() => decision)
    .toEqual({
      version: 1,
      packageHash,
      decision: "approve",
    });
  await expect(card.getByText("Drafts ready")).toBeVisible();
  await expect(
    card.getByText("Beta access is open. Learn more."),
  ).toBeVisible();
  await expect(
    card.getByText("Beta access is now open for teams."),
  ).toBeVisible();
  await expect(card.getByText("Needs review")).toHaveCount(2);
  await expect(card.getByText("Generated, rights review open")).toBeVisible();
  await expect(
    card.getByRole("img", { name: "Generated package image" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Start package" })).toHaveCount(
    0,
  );
});

test("cancels a running content package and shows what stopped", async ({
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
  const conversationId = "b38d9050-3dba-4ae0-851e-98d5b59e8201";
  let canceled = false;
  const deliverable = (
    key: string,
    channelName: string,
    status: string,
    body: string | null,
  ) => ({
    key,
    channelId: key,
    channelName,
    platform: key,
    plannedSlotAt: null,
    status,
    errorCode: null,
    content: body ? { id: `${key}-content`, body, status: "draft" } : null,
    review: null,
  });
  await page.route(
    `**/api/projects/${user.projectId}/chat/conversations?*`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: conversationId,
              title: "Synthetic running package",
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
            title: "Synthetic running package",
            updatedAt: new Date().toISOString(),
          },
          messages: [],
          runs: [],
          proposals: [],
          packages: [
            {
              id: "package-2",
              goal: "Announce that beta access is open",
              status: canceled ? "canceled" : "running",
              ceilingMicros: 70000,
              image: null,
              actionRequest: null,
              deliverables: [
                deliverable(
                  "x",
                  "Synthetic X",
                  "drafted",
                  "Beta access is open.",
                ),
                deliverable(
                  "telegram",
                  "Synthetic Telegram",
                  canceled ? "canceled" : "queued",
                  null,
                ),
              ],
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/chat/packages/package-2/cancel`,
    (route) => {
      canceled = true;
      return route.fulfill({ json: { id: "package-2", status: "canceled" } });
    },
  );
  await page.goto("/chat");
  await page
    .getByRole("button", { name: "Synthetic running package", exact: true })
    .click();
  const card = page.getByRole("region", { name: "Content package" });
  await expect(card.getByText("Drafts in progress")).toBeVisible();
  await card.getByRole("button", { name: "Cancel package" }).click();
  await expect.poll(() => canceled).toBe(true);
  await expect(card.getByText("Canceled").first()).toBeVisible();
  await expect(card.getByText("Beta access is open.")).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Cancel package" }),
  ).toHaveCount(0);
});

test("Postiz owner selects exact channels for the current project", async ({
  page,
}) => {
  const user = await signIn(page);
  const connectorId = "e0e1b285-a615-4dcf-a7c2-a38bdd1d80a6";
  let selected: string[] | null = null;
  await page.route(`**/api/projects/${user.projectId}/connectors?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: connectorId,
            version: 1,
            kind: "connectors",
            projectId: user.projectId,
            data: {
              provider: "postiz",
              status: "read_verified",
              assignedIntegrationIds: selected ?? [],
              baseUrl: "https://postiz.example.invalid/api/public/v1",
              channels: [
                {
                  id: "uliquid-x",
                  name: "uLiquid X",
                  identifier: "x",
                  disabled: false,
                },
                {
                  id: "familyplan-facebook",
                  name: "FamilyPlan Facebook",
                  identifier: "facebook",
                  disabled: false,
                },
              ],
            },
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/projects/${user.projectId}/actions/postiz-assign-channels`,
    (route) => {
      selected = route.request().postDataJSON().integrationIds;
      return route.fulfill({ json: { id: connectorId, version: 2, data: {} } });
    },
  );
  await page.goto("/connectors");
  await expect(page.getByText("Not assigned")).toHaveCount(2);
  await page.getByRole("checkbox", { name: /uLiquid X/ }).check();
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect.poll(() => selected).toEqual(["uliquid-x"]);
  await page.goto("/content");
  await page.getByRole("button", { name: "New draft" }).first().click();
  await expect(page.getByRole("option", { name: /uLiquid X/ })).toBeAttached();
  await expect(page.getByRole("option", { name: /FamilyPlan/ })).toHaveCount(0);
});
