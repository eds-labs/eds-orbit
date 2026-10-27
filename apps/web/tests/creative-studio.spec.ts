import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(
  process.env.CREATIVE_STUDIO_E2E !== "true",
  "Requires scripts/creative-studio-browser.ts (isolated test DB, ORBIT_CREATIVE_STUDIO=true, no worker) and the web server",
);

const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test("owner builds a brand kit, produces a feature highlight from a screenshot, switches the variant and attaches it", async ({
  page,
  context,
  baseURL,
}) => {
  const account = JSON.parse(
    readFileSync(".runtime/creative-studio-browser.json", "utf8"),
  );
  const login = await context.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL! },
    data: { email: account.email, password: account.password },
  });
  expect(login.status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("orbit.locale", "en"));
  const project = `/api/projects/${account.projectId}`;

  // 1. Upload the demo logo and screenshot through the upload route the
  //    library's form uses, then approve their rights.
  const ids: Record<string, string> = {};
  for (const [key, file, type, name] of [
    ["logo", "lumora-logo.png", "logo", "Lumora logo"],
    ["shot", "lumora-screenshot.png", "screenshot", "Lumora app screenshot"],
  ] as const) {
    const upload = await context.request.post(`${project}/assets/upload`, {
      headers: { Origin: baseURL! },
      data: {
        name,
        type,
        mime: "image/png",
        base64: readFileSync(`apps/web/tests/fixtures/${file}`).toString(
          "base64",
        ),
        source: "Fictional demo brand",
        license: "Synthetic fixture, no third-party material",
        validUses: ["brand", "social"],
        confirmRightsInformation: true,
      },
    });
    expect(upload.status()).toBe(201);
    ids[key] = (await upload.json()).id;
  }
  await page.goto(`/p/${account.projectId}/marketing/assets`);
  for (const name of ["Lumora logo", "Lumora app screenshot"]) {
    const card = page.locator("article", { hasText: name });
    await card.getByRole("button", { name: /Approve rights/ }).click();
    await expect(
      card.getByRole("button", { name: /Approve rights/ }),
    ).toHaveCount(0);
  }

  // Brand kit: the primary logo is part of the Marketing profile (its form
  //  needs the whole profile, so the test merges one field through the API the
  //  form uses); the product image is chosen in the brand kit editor.
  const current = await (
    await context.request.get(`${project}/marketing-profile`)
  ).json();
  const saved = await context.request.put(`${project}/marketing-profile`, {
    headers: { Origin: baseURL! },
    data: {
      ...current.data,
      visualIdentity: { ...current.data.visualIdentity, logoAssetId: ids.logo },
      expectedVersion: current.version,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.goto(`/p/${account.projectId}/settings?section=brand`);
  const kit = page.locator("section.brand-kit");
  await expect(
    kit.getByRole("heading", { name: "Creative brand kit" }),
  ).toBeVisible();
  await kit.getByLabel("Lumora app screenshot").check();
  await kit.getByRole("button", { name: "Save brand kit" }).click();
  await expect(kit.getByText("Brand kit saved.")).toBeVisible();

  // 2. The social post of a mission: open its detail from Content Studio.
  await page.goto(`/p/${account.projectId}/marketing/content`);
  await page.getByText("Evenings feel softer").first().click();
  const panel = page.getByRole("region", { name: "Creative" });
  await expect(panel).toBeVisible();

  // 3. Feature highlight from the screenshot, no art: nothing is paid.
  await panel
    .getByLabel("Template")
    .selectOption({ label: "Feature highlight" });
  // The art select keeps its default "No art"; no new art is requested.
  await expect(panel.getByLabel(/Generate new art/)).not.toBeChecked();
  await panel
    .getByLabel("Product image")
    .selectOption({ label: "Lumora app screenshot" });
  await panel.getByLabel(/^Eyebrow/).fill("New this autumn");
  await panel.getByLabel(/^Headline/).fill("Plan every evening in one place");
  await panel
    .getByLabel(/^Subline/)
    .fill("Lists, reminders and routines that keep the home calm.");
  await panel.getByLabel(/^Call to action/).fill("Try Lumora");
  await panel.getByRole("button", { name: "Produce creative" }).click();

  // 4. A 1080x1080 preview, QA passed, no cost.
  const image = panel.locator("img.creative-image");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1080);
  expect(
    await image.evaluate((img: HTMLImageElement) => img.naturalHeight),
  ).toBe(1080);
  await expect(panel.getByText("Passed", { exact: true })).toBeVisible();
  await expect(panel.getByText("$0.00")).toBeVisible();
  const firstSrc = await image.getAttribute("src");

  // 5. Switch the variant: a new image.
  const recompose = panel.locator("details.creative-recompose");
  await recompose.locator("summary").click();
  const variant = recompose.getByLabel("Variant");
  const options = await variant.locator("option").allTextContents();
  const other = options.find(
    (name) => name !== "Automatic" && name !== "Text on top",
  );
  expect(other).toBeTruthy();
  await variant.selectOption({ label: other! });
  await recompose.getByRole("button", { name: "Recompose" }).click();
  await expect
    .poll(() => image.getAttribute("src"), { timeout: 30_000 })
    .not.toBe(firstSrc);
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1080);
  await expect(panel.getByText("Passed", { exact: true })).toBeVisible();

  // 6. Attach: the post goes back to draft with the image.
  await panel.getByRole("button", { name: "Attach to post" }).click();
  await expect(
    panel.getByRole("button", { name: "Already on the post" }),
  ).toBeVisible();
  const posts = await (await context.request.get(`${project}/content`)).json();
  const post = posts.items.find((row: any) => row.id === account.contentId);
  // Attaching sets the post to "draft" and the claim review runs again at once
  // (spec §12); the synthetic post has no evidence, so the review leaves it in
  // "needs_review". Either way it is not "reviewed" or scheduled by the attach.
  expect(["draft", "needs_review"]).toContain(post.data.status);
  expect(post.data.review).toBeTruthy();
  expect(post.data.assetId).toBeTruthy();
  expect(post.data.creativeId).toBeTruthy();

  // 7. At 390 px the panel does not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.goto(`/p/${account.projectId}/marketing/content`);
  await page.getByText("Evenings feel softer").first().click();
  await expect(panel).toBeVisible();
  await expect(panel.locator("img.creative-image")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  const box = await panel.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(
    await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});
