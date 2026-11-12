import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { SEED, signIn } from "./settings-center-helpers";

// The AI area of the settings center (phase 4) in the browser: opening every
// AI section never writes, an organization owner sets the standard and a
// project owner who is no organization owner sees it inherited, the
// organization's projects list, the old AI pages, the assistant budget
// anchor and a phone.
//
// Each scenario gates on the flags and capabilities it needs, read from
// GET /api/management/capabilities (`flags`), and skips otherwise: the suite
// also runs with the settings center off and with the CI flags (no
// connections, no AI flags). Fixtures are created only after a scenario's
// gate passed, so a skipped run leaves nothing behind.
//
// What the file creates and puts back:
// - a project of its own ("AI acceptance project", created once through the
//   API and reused by later runs; projects cannot be removed in the product);
// - a synthetic OpenAI connection of the organization, granted to that
//   project for text. Its secret is no key and it is never checked, so no
//   provider is reached. Grant revoked and connection removed at the end;
//   leftovers of an interrupted run are removed at the start;
// - a second person (organization member, owner of the project) through an
//   invitation link without system mail; removed from the organization at
//   the end;
// - the organization's standard models: restored to what they were before
//   (removed again when there was none), from a baseline file written before
//   the change; a run that finds that file restores from it first.
// The project's own model choice ("Organization standard") stays: the project
// belongs to this file alone.

const STATE = resolve(".runtime/settings-center-ai-state.json");
// The organization's standard as it was before this file changed it, kept
// on disk (`.runtime/` is git-ignored) until it is restored, so a run that
// dies before its cleanup is repaired by the next one instead of the next
// run taking the leftover standard for the original.
const STANDARD_BASELINE = resolve(".runtime/settings-center-ai-standard.json");
const AI_PROJECT = "AI acceptance project";
const RUN = Date.now().toString(36);
const CONNECTION_PREFIX = "Synthetic OpenAI ";
const SECOND_PREFIX = "ai-second-";
// Recognisable and never valid anywhere; no page may ever show it.
const SYNTHETIC_SECRET = `orbit-e2e-synthetic-openai-${randomBytes(6).toString("hex")}`;

type Caps = {
  stage: string;
  flags?: {
    connections: boolean;
    aiCatalog: boolean;
    aiDefaults: boolean;
    aiOrgBudget: boolean;
  };
  system: string[];
  organizations: Array<{ id: string; name: string; capabilities: string[] }>;
  projects: Array<{ id: string; name: string; workspaceId: string; capabilities: string[] }>;
};

let stage: string | undefined;
let administration = false;
let caps: Caps | undefined;
let origin = "";

// Fixtures, created on first need and removed in afterAll.
let aiProject: { id: string; name: string } | undefined;
let connection: { id: string; label: string } | undefined;
let second:
  | { email: string; userId: string; context: import("@playwright/test").BrowserContext }
  | undefined;
// The organization's standard as it was before this file changed it;
// undefined while unchanged.
let savedStandard: { defaults: unknown } | undefined;
// An invitation created for the second person and not yet accepted.
let pendingInvitation: string | undefined;

const flags = () => caps?.flags ?? { connections: false, aiCatalog: false, aiDefaults: false, aiOrgBudget: false };
const org = () => caps!.organizations[0];
const can = {
  organizationAi: () => Boolean(caps?.organizations[0]?.capabilities.includes("organization.ai")),
  systemAi: () => Boolean(caps?.system.includes("system.ai")),
};

/** The seeded project: read only by the scenarios that need no fixture. */
const seededProjectId = () =>
  (JSON.parse(readFileSync(SEED, "utf8")) as { projectId: string }).projectId;

/** Skips unless every flag and capability the scenario needs is there. */
function gate(needs: {
  connections?: boolean;
  aiDefaults?: boolean;
  organizationAi?: boolean;
  systemAi?: boolean;
  administration?: boolean;
}) {
  if (needs.connections) test.skip(!flags().connections, "ORBIT_CONNECTIONS is off");
  if (needs.aiDefaults) test.skip(!flags().aiDefaults, "ORBIT_AI_DEFAULTS is off");
  if (needs.organizationAi)
    test.skip(!can.organizationAi(), "the member owns no organization with AI settings");
  if (needs.systemAi) test.skip(!can.systemAi(), "the member is not a system administrator");
  if (needs.administration) test.skip(!administration, "ORBIT_ADMINISTRATION is off");
}

async function ok(response: import("@playwright/test").APIResponse, what: string) {
  expect(response.ok(), `${what}: ${response.status()} ${await response.text().catch(() => "")}`).toBe(true);
  return response;
}

/** Puts the organization's standard back to `defaults` (removes it when null). */
async function restoreStandard(request: APIRequestContext, organizationId: string, defaults: unknown) {
  const path = `/api/organizations/${organizationId}/ai/defaults`;
  await ok(
    defaults === null
      ? await request.delete(path, { headers: { origin } })
      : await request.put(path, { headers: { origin }, data: defaults }),
    "organization standard restored",
  );
}

/** Records the standard before this run changes it, in memory and in the baseline file. */
async function rememberStandard(request: APIRequestContext) {
  if (savedStandard) return;
  const current = await request.get(`/api/organizations/${org().id}/ai/defaults`).then((r) => r.json());
  savedStandard = { defaults: current.defaults };
  writeFileSync(
    STANDARD_BASELINE,
    JSON.stringify({ organizationId: org().id, defaults: current.defaults }),
  );
}

/** The file's own project; created once through the API. */
async function projectFixture(request: APIRequestContext) {
  if (aiProject) return aiProject;
  const me = await request.get("/api/me").then((r) => r.json());
  const found = (me.projects as Array<{ id: string; name: string; workspaceId: string }>).find(
    (p) => p.name === AI_PROJECT && p.workspaceId === org().id,
  );
  if (found) return (aiProject = { id: found.id, name: found.name });
  const created = await request.post("/api/projects", {
    headers: { origin },
    data: { name: AI_PROJECT, timezone: "Europe/Berlin", language: "en", workspaceId: org().id },
  });
  expect(created.status(), "AI project created").toBe(201);
  const body = (await created.json()) as { id: string; name: string };
  return (aiProject = { id: body.id, name: body.name });
}

const connectionsPath = () => `/api/organizations/${org().id}/connections`;

/** Revokes a connection's grants and removes it. */
async function removeConnection(request: APIRequestContext, id: string) {
  const usage = await request.get(`${connectionsPath()}/${id}/usage`).then((r) => r.json());
  for (const grant of (usage.grants ?? []) as Array<{ id: string }>)
    await ok(
      await request.delete(`/api/organizations/${org().id}/connection-grants/${grant.id}`, {
        headers: { origin },
      }),
      "grant revoked",
    );
  await ok(await request.delete(`${connectionsPath()}/${id}`, { headers: { origin } }), "connection removed");
}

/**
 * The synthetic OpenAI connection, granted to the project for text. Created
 * through the API with a secret that is no key; never checked.
 */
async function connectionFixture(request: APIRequestContext) {
  if (connection) return connection;
  const project = await projectFixture(request);
  const list = await request.get(connectionsPath()).then((r) => r.json());
  const leftovers = ((list.items ?? []) as Array<{ id: string; label: string }>).filter(
    (c) => c.label.startsWith(CONNECTION_PREFIX),
  );
  for (const c of leftovers) await removeConnection(request, c.id);
  if (leftovers.length)
    test.info().annotations.push({
      type: "leftovers removed",
      description: leftovers.map((c) => c.label).join(", "),
    });
  const label = `${CONNECTION_PREFIX}${RUN}`;
  const created = await ok(
    await request.post(connectionsPath(), {
      headers: { origin },
      data: { provider: "openai", label, config: {}, secret: SYNTHETIC_SECRET },
    }),
    "connection created",
  );
  const { id } = (await created.json()) as { id: string };
  await ok(
    await request.post(`${connectionsPath()}/${id}/grants`, {
      headers: { origin },
      data: { projectId: project.id, purposes: ["text"] },
    }),
    "connection granted",
  );
  return (connection = { id, label });
}

type OrgDetail = {
  members: Array<{ id: string; email: string }>;
  invitations: Array<{ id: string; email: string }>;
};

/**
 * A second person: organization member and owner of the project, invited by
 * link (no system mail on this stack) and signed up in a context of their
 * own with their own password.
 */
async function secondPerson(page: Page) {
  if (second) return second;
  const project = await projectFixture(page.request);
  const detail = (await page.request
    .get(`/api/organizations/${org().id}`)
    .then((r) => r.json())) as OrgDetail;
  // What an interrupted run left: its second person and open invitations.
  for (const m of detail.members.filter((m) => m.email.startsWith(SECOND_PREFIX)))
    await ok(
      await page.request.delete(`/api/organizations/${org().id}/members/${m.id}`, {
        headers: { origin },
      }),
      "leftover second person removed",
    );
  for (const i of (detail.invitations ?? []).filter((i) => i.email.startsWith(SECOND_PREFIX)))
    await ok(
      await page.request.delete(`/api/organizations/${org().id}/invitations/${i.id}`, {
        headers: { origin },
      }),
      "leftover invitation revoked",
    );
  const email = `${SECOND_PREFIX}${RUN}@example.invalid`;
  const invited = await ok(
    await page.request.post(`/api/organizations/${org().id}/invitations`, {
      headers: { origin },
      data: { email, role: "member", projects: [{ projectId: project.id, role: "owner" }] },
    }),
    "second person invited",
  );
  const invitation = (await invited.json()) as {
    invitationId?: string;
    delivery?: string;
    link?: string;
  };
  pendingInvitation = invitation.invitationId;
  test.skip(
    invitation.delivery !== "link" || !invitation.link,
    "system mail is configured, so the invitation link is not returned",
  );
  const context = await page.context().browser()!.newContext({
    baseURL: origin,
    storageState: { cookies: [], origins: [] },
  });
  const invitee = await context.newPage();
  const password = randomBytes(18).toString("base64url");
  await invitee.goto(invitation.link!);
  await expect(invitee.getByText(`For ${email}`, { exact: false })).toBeVisible();
  await invitee.getByLabel(/^Your name/).fill("Synthetic project owner");
  await invitee.getByLabel(/^Choose a password/).fill(password);
  await invitee.getByLabel(/^Repeat the password/).fill(password);
  await invitee.getByRole("button", { name: "Create account and accept" }).click();
  await expect(invitee.getByLabel(/^Account menu/)).toBeVisible();
  pendingInvitation = undefined;
  const me = await invitee.request.get("/api/me").then((r) => r.json());
  await invitee.close();
  return (second = { email, userId: me.user.id, context });
}

/** The project follows the organization's standard (the API, as the panel saves it). */
async function followStandard(request: APIRequestContext, projectId: string) {
  await ok(
    await request.post(`/api/projects/${projectId}/actions/ai-configure`, {
      headers: { origin },
      data: { routing: { source: "organization", overrides: {} } },
    }),
    "project follows the organization's standard",
  );
}

/** Removes the keys named `usage` (counters that move on their own). */
function withoutUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUsage);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => k !== "usage").map(([k, v]) => [k, withoutUsage(v)]),
    );
  return value;
}

/** Every stored AI setting the AI sections show, at the project, organization and system. */
async function snapshot(request: APIRequestContext, projectId: string) {
  const get = async (path: string) => {
    const response = await request.get(path);
    expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
    return response.json();
  };
  const o = `/api/organizations/${org().id}/ai`;
  const configuration = await get(`/api/projects/${projectId}/openai-configuration`);
  const spend = await get(`/api/projects/${projectId}/ai-spend-policy`);
  const mandates = await get(`/api/projects/${projectId}/agent-mandates`);
  const orgProfile = await get(`${o}/profile`);
  const defaults = await get(`${o}/defaults`);
  const budget = await get(`${o}/budget`);
  const models = await get(`${o}/models`);
  const systemProfile = await get("/api/admin/ai/profile");
  return {
    projectStored: configuration.stored,
    // The routing the project saved (Task 1's `stored` holds the fields a
    // dialog may write; the model choice is stored next to them).
    projectRouting: configuration.routing,
    spendRecord: spend.record,
    mandates: withoutUsage(mandates),
    orgProfile: { version: orgProfile.version, data: orgProfile.data },
    orgDefaults: { version: defaults.version, defaults: defaults.defaults },
    orgBudget: budget.budget,
    orgModels: (models.models as Array<Record<string, unknown>>).map((m) => ({
      id: m.id,
      active: m.active,
      overridden: m.overridden,
      rate: m.rate,
    })),
    systemProfile: { version: systemProfile.version, data: systemProfile.data },
  };
}

test.describe("settings center AI area", () => {
  test.skip(!existsSync(SEED), "needs the seeded e2e installation");
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: STATE });

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    origin = new URL(baseURL!).origin;
    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await signIn(page);
      const me = await page.request.get("/api/me").then((r) => r.json());
      stage = me.settingsCenter;
      administration = me.administration === true;
      if (stage && stage !== "off")
        caps = await page.request.get("/api/management/capabilities").then((r) => r.json());
      // An earlier run died before restoring the standard: restore it now.
      if (existsSync(STANDARD_BASELINE) && caps?.flags?.connections) {
        const baseline = JSON.parse(readFileSync(STANDARD_BASELINE, "utf8")) as {
          organizationId: string;
          defaults: unknown;
        };
        await restoreStandard(page.request, baseline.organizationId, baseline.defaults);
        unlinkSync(STANDARD_BASELINE);
      }
      await context.storageState({ path: STATE });
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!connection && !second && !savedStandard && !pendingInvitation) return;
    const context = await browser.newContext({ baseURL, storageState: STATE });
    const request = context.request;
    // Every step is attempted, the standard first; failures are reported together.
    const errors: unknown[] = [];
    const attempt = async (step: () => Promise<void>) => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      if (savedStandard)
        await attempt(async () => {
          await restoreStandard(request, org().id, savedStandard!.defaults);
          unlinkSync(STANDARD_BASELINE);
        });
      if (second)
        await attempt(async () => {
          await second!.context.close();
          await ok(
            await request.delete(`/api/organizations/${org().id}/members/${second!.userId}`, {
              headers: { origin },
            }),
            "second person removed",
          );
        });
      if (pendingInvitation)
        await attempt(async () => {
          await ok(
            await request.delete(`/api/organizations/${org().id}/invitations/${pendingInvitation}`, {
              headers: { origin },
            }),
            "pending invitation revoked",
          );
        });
      if (connection) await attempt(() => removeConnection(request, connection!.id));
    } finally {
      await context.close();
    }
    if (errors.length) throw new AggregateError(errors, "cleanup of settings-center-ai.spec.ts failed");
  });

  test.beforeEach(() => {
    test.skip(!stage || stage === "off", "ORBIT_SETTINGS_CENTER is off");
  });

  const main = (page: Page) => page.getByRole("main");
  const heading = (page: Page, name: string) =>
    main(page).getByRole("heading", { name, exact: true });
  const sectionNav = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

  test("stored AI configuration is identical before and after opening every AI section", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // The organization and system AI areas exist only with central connections.
    gate({ connections: true, organizationAi: true, systemAi: true });
    const project = await projectFixture(page.request);
    await connectionFixture(page.request);
    const before = await snapshot(page.request, project.id);

    // Opening or mounting a form never writes: no request but reads leaves
    // the browser while the sections open.
    const writes: string[] = [];
    page.on("request", (r) => {
      if (!["GET", "HEAD"].includes(r.method()) && new URL(r.url()).pathname.startsWith("/api/"))
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });

    const p = `/manage/p/${project.id}/ai`;
    const o = `/manage/o/${org().id}/ai`;
    const visits: Array<[string, (page: Page) => Promise<void>]> = [
      [`${p}/overview`, async (page) => {
        await expect(heading(page, "Readiness per provider")).toBeVisible();
        await expect(heading(page, "Values and where they come from")).toBeVisible();
        await expect(main(page).getByRole("row", { name: /^Default provider / })).toBeVisible();
      }],
      [`${p}/providers`, async (page) => {
        await expect(heading(page, "AI providers")).toBeVisible();
        // The setup panel shows only without a key; the granted connection is one.
        await expect(main(page).getByText("Text (chat, drafts, Support, Finance)", { exact: true })).toBeVisible();
      }],
      [`${p}/models`, async (page) => {
        // The model choice exists only while standard models are switched on.
        if (flags().aiDefaults) await expect(heading(page, "Model choice")).toBeVisible();
        else
          await expect(
            main(page).getByText(/^Standard models and presets are not switched on/),
          ).toBeVisible();
        await main(page).getByText("Models, prices and task routes", { exact: true }).click();
        await expect(heading(page, "AI models")).toBeVisible();
      }],
      [`${p}/budget`, async (page) => {
        await expect(heading(page, "AI spending authority")).toBeVisible();
        await expect(heading(page, "OpenAI budget")).toBeVisible();
        await expect(heading(page, "AI ceilings of the modules")).toBeVisible();
      }],
      [`${p}/usage`, async (page) => {
        await expect(heading(page, "AI usage & costs")).toBeVisible();
      }],
      [`${p}/agents`, async (page) => {
        await expect(main(page).getByText(/^Let the assistant or connected apps/)).toBeVisible();
      }],
      [`${o}/standard`, async (page) => {
        await expect(main(page).getByText(/Saving changes the route version/)).toBeVisible();
        await expect(
          main(page).getByRole("button", { name: /^(Set standard|Change)$/ }),
        ).toBeVisible();
      }],
      [`${o}/models`, async (page) => {
        await expect(heading(page, "Models & prices")).toBeVisible();
        await expect(main(page).getByText(/· gpt-6-astra$/)).toBeVisible();
      }],
      [`${o}/budget`, async (page) => {
        await expect(heading(page, "Organization limit")).toBeVisible();
        await expect(heading(page, "Project limits")).toBeVisible();
      }],
      [`${o}/usage`, async (page) => {
        await expect(main(page).getByText(/^Spend of the current month across projects/)).toBeVisible();
      }],
      [`${o}/projects`, async (page) => {
        await expect(main(page).getByRole("columnheader", { name: "Model choice" })).toBeVisible();
        await expect(main(page).getByRole("row").filter({ hasText: project.name })).toBeVisible();
      }],
      [`${o}/advanced`, async (page) => {
        await main(page).getByText("Advanced", { exact: true }).click();
        await expect(heading(page, "AI profile · Organization")).toBeVisible();
        await expect(main(page).getByRole("button", { name: "Save" })).toBeVisible();
      }],
      ["/manage/system/ai/standard", async (page) => {
        await expect(main(page).getByText(/Saving changes the route version/)).toBeVisible();
        await expect(
          main(page).getByRole("button", { name: /^(Set standard|Change)$/ }),
        ).toBeVisible();
      }],
      ["/manage/system/ai/models", async (page) => {
        await expect(heading(page, "Models & prices")).toBeVisible();
        await expect(main(page).getByText(/· gpt-6-astra$/)).toBeVisible();
      }],
      ["/manage/system/ai/advanced", async (page) => {
        await main(page).getByText("Advanced", { exact: true }).click();
        await expect(heading(page, "AI profile · System")).toBeVisible();
        await expect(main(page).getByRole("button", { name: "Save" })).toBeVisible();
      }],
    ];
    for (const [url, content] of visits) {
      await page.goto(url);
      // The section is the one asked for (not the area's first) ...
      await expect(sectionNav(page).locator("[aria-current=page]"), url).toHaveAttribute(
        "href",
        url,
      );
      await expect(page.getByText("Not available", { exact: true }), url).toHaveCount(0);
      // ... and its own content is there, not just the frame.
      await content(page);
      expect(await page.content(), url).not.toContain(SYNTHETIC_SECRET);
    }
    // Let late effects of the last section settle before reading again.
    await page.waitForTimeout(1000);
    expect(writes).toEqual([]);
    const after = await snapshot(page.request, project.id);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("an organization owner sets the standard; a project owner sees it inherited and can only switch", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    gate({ connections: true, aiDefaults: true, organizationAi: true, administration: true });
    const project = await projectFixture(page.request);
    // The project's first save needs a key it keeps using: the granted connection.
    await connectionFixture(page.request);
    const path = `/api/organizations/${org().id}/ai/defaults`;
    await rememberStandard(page.request);

    await page.goto(`/manage/o/${org().id}/ai/standard`);
    await expect(main(page).getByText(/project of this organization/)).toBeVisible();
    await main(page).getByRole("button", { name: /^(Set standard|Change)$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Standard models" });
    await dialog.getByLabel(/^Provider/).selectOption({ label: "Claude" });
    await dialog.getByLabel(/^Level/).selectOption({ label: "Balanced" });
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === path,
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok(), "standard saved").toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(main(page).getByText("Claude · Balanced", { exact: true })).toBeVisible();

    await followStandard(page.request, project.id);
    const person = await secondPerson(page);
    const owner = await person.context.newPage();
    try {
      await owner.goto(`/manage/p/${project.id}/ai`);
      await expect(main(owner).getByText("Follows the organization's standard.", { exact: true })).toBeVisible();
      await expect(
        main(owner).getByRole("row", { name: /^Default provider / }),
      ).toContainText("Organization");

      await owner.goto(`/manage/p/${project.id}/ai/models`);
      const choice = main(owner)
        .locator("section")
        .filter({ has: owner.getByRole("heading", { name: "Model choice", exact: true }) });
      await expect(choice).toBeVisible();
      await expect(choice.getByText("Organization standard").first()).toBeVisible();
      await expect(choice.getByRole("button", { name: "Change", exact: true })).toBeVisible();
      await main(owner).getByText("Models, prices and task routes", { exact: true }).click();
      await expect(heading(owner, "AI models")).toBeVisible();
      await expect(
        main(owner).getByText(/^The project follows the organization's standard, so models and task routes are not chosen here\./),
      ).toBeVisible();
      await expect(main(owner).getByRole("button", { name: "Task routes" })).toHaveCount(0);

      // Not an organization owner: the organization's settings are not theirs.
      await owner.goto(`/manage/o/${org().id}/ai/standard`);
      await expect(owner.getByText("Page not found").first()).toBeVisible();
      await expect(owner.getByLabel("Applies to")).toHaveCount(0);
    } finally {
      await owner.close();
    }
  });

  test("the organization's projects list shows the project as following", async ({ page }) => {
    gate({ connections: true, aiDefaults: true, organizationAi: true, administration: true });
    const project = await projectFixture(page.request);
    const view = await page.request
      .get(`/api/projects/${project.id}/openai-configuration`)
      .then((r) => r.json());
    if (view.routing?.source !== "organization") {
      await connectionFixture(page.request);
      await followStandard(page.request, project.id);
    }
    await page.goto(`/manage/o/${org().id}/ai/projects`);
    const row = main(page).getByRole("row").filter({ hasText: project.name });
    await expect(row).toContainText("Organization standard");
    // The name shows as stored: the header cell style must not capitalize it.
    const name = row.getByRole("rowheader");
    expect(await name.innerText()).toBe(project.name);
    expect(await name.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
  });

  test("old AI pages keep working", async ({ page }) => {
    test.skip(
      stage === "on",
      "the old AI pages redirect with ORBIT_SETTINGS_CENTER=on; covered by settings-center-on.spec.ts \"every old address opens its section of the center\"",
    );
    const project = { id: seededProjectId() };
    await page.goto(`/p/${project.id}/settings?section=ai`);
    const projectHeadings = ["AI spending authority", "AI providers", "AI models", "AI usage & costs"];
    // The model choice panel renders only while standard models are switched on.
    if (flags().aiDefaults) projectHeadings.push("Model choice");
    for (const name of projectHeadings) await expect(heading(page, name), name).toBeVisible();
    await expect(page.getByLabel("Applies to")).toHaveCount(0);
    if (!flags().connections || !can.organizationAi() || !can.systemAi()) {
      test.info().annotations.push({
        type: "pages skipped",
        description: "the organization and system AI pages need ORBIT_CONNECTIONS and both roles",
      });
      return;
    }
    await page.goto(`/o/${org().id}/settings`);
    for (const name of ["Standard models", "AI budget", "AI usage", "Models & prices", "AI profile · Organization"])
      await expect(heading(page, name), name).toBeVisible();
    await page.goto("/admin/ai");
    await expect(main(page).getByRole("heading", { name: "AI & knowledge" }).first()).toBeVisible();
    for (const name of ["Standard models", "Models & prices", "AI profile · System"])
      await expect(heading(page, name), name).toBeVisible();
    await expect(page.getByLabel("Applies to")).toHaveCount(0);
  });

  test("the assistant budget anchor still works", async ({ page }) => {
    gate({ connections: true, organizationAi: true });
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(`/manage/o/${org().id}/ai/budget#assistant-budget`);
    const anchor = page.locator("#assistant-budget");
    await expect(anchor).toBeVisible();
    await expect(anchor).toBeInViewport();
    await expect(heading(page, "Personal assistant per member")).toBeInViewport();
  });

  test("works on a phone", async ({ page }) => {
    const project = { id: seededProjectId() };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/manage/p/${project.id}/ai`);
    await expect(heading(page, "Values and where they come from")).toBeVisible();
    await expect(page.getByLabel("Section", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  });
});
