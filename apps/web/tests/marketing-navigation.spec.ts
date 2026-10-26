import { test, expect, type BrowserContext } from "./fixtures";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
test.skip(
  process.env.MARKETING_NAV_E2E !== "true",
  "Requires isolated synthetic MA-08 fixture",
);
const fixture = () =>
  JSON.parse(
    readFileSync(".runtime/marketing-navigation-browser.json", "utf8"),
  );
async function signIn(
  context: BrowserContext,
  baseURL: string | undefined,
  account: { email: string; password: string },
) {
  const response = await context.request.post("/api/auth/sign-in/email", {
    headers: {
      Origin: baseURL!,
      "x-forwarded-for": `198.18.${randomInt(1, 254)}.${randomInt(1, 254)}`,
    },
    data: { email: account.email, password: account.password },
  });
  expect(response.status()).toBe(200);
}
for (const width of [1280, 390])
  test(`project → assistant → plan → pending review at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    const f = fixture();
    await signIn(context, baseURL, f.owner);
    await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") writes.push(r.url());
    });
    await page.goto(`/o/${f.workspaceId}`);
    await page.getByRole("link", { name: /Synthetic MA-08 Marketing/ }).click();
    await page
      .getByRole("button", { name: "Plan with assistant", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/p/${f.projectId}/assistant$`));
    await expect(page.getByLabel("Message Orbit")).toHaveValue(/human_each/);
    await page.getByRole("link", { name: "Saved plans", exact: true }).focus();
    await page.keyboard.press("Enter");
    const list = page.locator(".marketing-plan-list");
    await expect(list).toContainText("Strategy awaits approval");
    await list.getByRole("link").first().click();
    await expect(
      page.getByRole("button", { name: "Approve strategy only", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Next step", exact: true }),
    ).toContainText("Strategy awaits approval");
    expect(
      await page
        .getByRole("button", {
          name: "Continue planning in assistant",
          exact: true,
        })
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.runtime/ma08-plan-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    // Inspect all manual entry paths, retaining their existing workflows.
    for (const [name, title] of [
      ["Creator / Content", "Content Studio"],
      ["Missions", "Missions"],
      ["Assignments", "Assignments"],
    ]) {
      await page
        .getByRole("navigation", { name: "Manual marketing tools" })
        .getByRole("link", { name, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: title, exact: true }).first(),
      ).toBeVisible();
      await page.goto(`/p/${f.projectId}/marketing/plans?plan=${f.planId}`);
    }
    await page.goto("/chat");
    await expect(page).toHaveURL(new RegExp(`/p/${f.projectId}/assistant$`));
    await page.goto("/content");
    await expect(page).toHaveURL(
      new RegExp(`/p/${f.projectId}/marketing/content$`),
    );
    expect(writes).toEqual([]);
    for (const kind of ["assignments", "publications", "postiz_drafts"]) {
      const response = await context.request.get(
        `/api/projects/${f.projectId}/${kind}`,
      );
      expect(response.status()).toBe(200);
      expect((await response.json()).items).toEqual([]);
    }
  });
test("Marketing disabled preserves pending Support app approvals", async ({
  page,
  context,
  baseURL,
}) => {
  const f = fixture();
  await signIn(context, baseURL, f.owner);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
  await page.goto(`/p/${f.supportProjectId}`);
  await expect(
    page.getByRole("button", { name: "Plan with assistant", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "App approvals", exact: true }).click();
  await expect(
    page.getByText("Synthetic pending Support note", { exact: false }),
  ).toBeVisible();
  await page.goto(`/p/${f.supportProjectId}/assistant`);
  await expect(
    page.getByRole("navigation", { name: "Marketing in the assistant" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Plan marketing", exact: true }),
  ).toHaveCount(0);
});
for (const role of ["viewer", "hidden"])
  test(`server-advertised Marketing ${role} access`, async ({
    page,
    context,
    baseURL,
  }) => {
    const f = fixture();
    await signIn(context, baseURL, f[role]);
    await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
    await page.goto(`/p/${f.projectId}/assistant`);
    await expect(
      page.getByRole("heading", { name: "Orbit Chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Plan marketing", exact: true }),
    ).toHaveCount(0);
    if (role === "hidden") {
      await expect(
        page.getByRole("navigation", { name: "Marketing in the assistant" }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("button", {
          name: "Check marketing status",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Saved plans", exact: true })
        .click();
      await page
        .locator(".marketing-plan-list")
        .getByRole("link")
        .first()
        .click();
      await expect(
        page.getByRole("button", {
          name: "Approve strategy only",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Continue planning in assistant",
          exact: true,
        }),
      ).toHaveCount(0);
    }
  });
