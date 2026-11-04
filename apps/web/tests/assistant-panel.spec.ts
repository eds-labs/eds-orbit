import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The personal assistant's bubble and panel (WP3.8). The personal space and
// its chat are stubbed at the network (like chat.spec.ts), so this needs no
// ORBIT_PERSONAL_ASSISTANT and no model transport.

function account() {
  return JSON.parse(
    readFileSync(resolve(".runtime/e2e-user.json"), "utf8"),
  ) as { email: string; password: string; projectId: string };
}

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
  await page.waitForURL(/\/(p|o)(\/|$)/);
  return user;
}

const SPACE = "c48d9050-3dba-4ae0-851e-98d5b59e8000";
const CONVERSATION = "c48d9050-3dba-4ae0-851e-98d5b59e8001";
const RUN = "c48d9050-3dba-4ae0-851e-98d5b59e8002";

async function stubAssistant(page: Page, projectId: string) {
  let sent = false;
  await page.route(/\/api\/assistant(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        workspaceId: "w",
        personalSpaceId: SPACE,
        capMicros: 5_000_000,
        autoMemory: true,
      },
    }),
  );
  await page.route(`**/api/projects/${SPACE}/chat/conversations?*`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/api/projects/${SPACE}/chat/conversations`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: CONVERSATION,
        title: "New",
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route(
    `**/api/projects/${SPACE}/chat/conversations/${CONVERSATION}/messages`,
    (route) => {
      sent = true;
      return route.fulfill({
        status: 202,
        json: { runId: RUN, status: "queued" },
      });
    },
  );
  await page.route(
    `**/api/projects/${SPACE}/chat/runs/${RUN}/events`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `id: 1\nevent: snapshot\ndata: ${JSON.stringify({
          id: RUN,
          status: "succeeded",
          partialText: "Two open tasks.",
          errorCode: null,
          sequence: 1,
          steps: [
            {
              tool: "work_task_list",
              projectId,
              projectName: "E2E",
              state: "finished",
            },
          ],
        })}\n\n`,
      }),
  );
  await page.route(
    `**/api/projects/${SPACE}/chat/conversations/${CONVERSATION}?*`,
    (route) =>
      route.fulfill({
        json: {
          conversation: {
            id: CONVERSATION,
            title: "Open tasks",
            updatedAt: new Date().toISOString(),
          },
          messages: sent
            ? [
                { id: "u1", role: "user", text: "What is open?", cards: [] },
                {
                  id: "a1",
                  role: "assistant",
                  text: "Two open tasks.",
                  cards: [
                    {
                      kind: "link",
                      label: "Knowledge sources",
                      href: "/knowledge",
                      projectId,
                      projectName: "E2E project",
                    },
                  ],
                },
              ]
            : [],
          runs: [],
          proposals: [],
        },
      }),
  );
}

test("the bubble opens the panel, streams an answer and opens a linked record", async ({
  page,
}) => {
  const user = await signIn(page);
  await stubAssistant(page, user.projectId);
  await page.goto(`/p/${user.projectId}`);
  const bubble = page.getByRole("button", { name: /^Open Orbit Assistant/ });
  await bubble.click();
  const panel = page.getByRole("dialog", { name: "Orbit Assistant" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Message the assistant")).toBeFocused();
  await panel.getByLabel("Message the assistant").fill("What is open?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText("Two open tasks.").first()).toBeVisible();
  await expect(panel.getByText("E2E project")).toBeVisible();
  await panel.getByLabel("Focus").selectOption("");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(bubble).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(panel).toBeVisible();
  await panel.getByRole("link", { name: "Knowledge sources" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${user.projectId}/knowledge$`));
});

test("on a phone the bubble stays above the bottom bar without horizontal scroll", async ({
  page,
}) => {
  const user = await signIn(page);
  await stubAssistant(page, user.projectId);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/p/${user.projectId}`);
  const bubble = page.getByRole("button", { name: /^Open Orbit Assistant/ });
  const nav = page.getByRole("navigation", { name: "Mobile workspace" });
  const [bubbleBox, navBox] = [
    await bubble.boundingBox(),
    await nav.boundingBox(),
  ];
  expect(bubbleBox!.y + bubbleBox!.height).toBeLessThanOrEqual(navBox!.y);
  await bubble.click();
  await expect(
    page.getByRole("dialog", { name: "Orbit Assistant" }),
  ).toBeVisible();
  await expect(nav).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
