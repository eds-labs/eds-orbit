import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createWebhookEndpoint } from "../src/platform/outbound-webhooks/webhooks.ts";
import { metaContent, runLiveCheck, setLiveCheckFetchForTests } from "../src/modules/cms/sites/live-check.ts";
import { setSiteCheckFetchForTests } from "../src/modules/cms/sites/routes.ts";
import { cmsAttention } from "../src/modules/cms/attention.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

const doc = (...blocks: object[]) => ({ schema: "orbit-doc", version: 1, blocks });
const para = (text: string, extra: object = {}) => ({ type: "paragraph", content: [{ text, ...extra }] });

/**
 * Websites of the content module (ADR 0029 §3.2, CH1.11): the owner manages
 * sites, their routes, notifiers and editorial rules; a site hears only
 * about its own content; the live check confirms the site shows the live
 * revision and asks for a person when it does not.
 */
describe.skipIf(!enabled)("content sites", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const saved = { ...process.env };
  const keys = ["ORBIT_CMS", "ORBIT_WEBHOOKS"];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  type Who = keyof typeof ids;
  const call = (who: Who, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/cms${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ids.owner, role: "owner" });
  const workerScope = (): Scope => ({ workspaceId, projectId, userId: "worker", role: "owner" });

  const site = async (patch: object = {}) => {
    const response = await call("owner", "POST", "/sites", {
      name: `Site ${randomUUID().slice(0, 6)}`,
      baseUrl: "https://site.example.invalid",
      locales: ["de", "en"],
      defaultLocale: "de",
      routes: { article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } },
      ...patch,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().site as { id: string; version: number };
  };
  const endpoint = async (name: string) =>
    run((tx) =>
      createWebhookEndpoint(tx, ownerScope(), {
        ownerModule: "cms",
        name,
        url: `https://${name}.example.invalid/hook`,
        eventTypes: ["cms.entry.published", "cms.entry.updated", "cms.entry.unpublished", "cms.redirect.created"],
      }),
    );
  const liveJobs = (publicationId: string) =>
    run((tx) =>
      tx.entity.findMany({
        where: { projectId, kind: "jobs", AND: [{ data: { path: ["resourceId"], equals: publicationId } }, { data: { path: ["topic"], equals: "cms_live_check" } }] },
      }),
    );
  /** Creates and publishes a German article on the sites; returns its ids. */
  const publish = async (siteIds: string[], body = doc(para("Ein kurzer Text."))) => {
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title: `Artikel ${randomUUID().slice(0, 6)}`, siteIds });
    expect(created.statusCode, created.body).toBe(201);
    const entryId = created.json().entry.id as string;
    const saved = await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 1, body });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion: saved.json().draft.version });
    return { entryId, published, slug: created.json().entry.slug as string };
  };

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of Object.keys(ids) as Who[]) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms sites ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic cms sites",
        members: { create: [{ userId: ids.owner, role: "owner" }, { userId: ids.editor, role: "viewer" }, { userId: ids.viewer, role: "viewer" }] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms sites" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await run((tx) =>
      tx.projectModule.create({ data: { workspaceId, projectId, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner } }),
    );
    for (const who of Object.keys(ids) as Who[]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: accounts[who] });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
    delete process.env.ORBIT_WEBHOOKS;
    setLiveCheckFetchForTests(null);
    setSiteCheckFetchForTests(null);
  });
  afterAll(async () => {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("the owner manages sites; members read them; input is checked", async () => {
    expect((await call("editor", "POST", "/sites", { name: "X", baseUrl: "https://x.example.invalid", locales: ["de"], defaultLocale: "de" })).statusCode).toBe(403);
    const created = await site({ baseUrl: "https://Site.Example.invalid/" });
    const read = (await call("viewer", "GET", `/sites/${created.id}`)).json();
    expect(read).toMatchObject({
      site: { baseUrl: "https://site.example.invalid", adapter: "orbit_pull", verification: "configured", notifiers: [], archived: false, version: 1 },
      entries: 0,
      liveEntries: 0,
    });
    expect(read.site.contentRules).toEqual({ forbiddenPhrases: [], plainText: false, titleMaxLength: null, excerptRequired: false, heroRequired: false });
    const list = (await call("viewer", "GET", "/sites")).json();
    expect(list.items.map((s: { id: string }) => s.id)).toContain(created.id);
    expect(list.adapters).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "orbit_pull", available: true }), expect.objectContaining({ kind: "wordpress", available: false })]));

    const bad = async (patch: object) => code(await call("owner", "POST", "/sites", { name: "B", baseUrl: "https://b.example.invalid", locales: ["de"], defaultLocale: "de", ...patch }));
    expect(await bad({ baseUrl: "http://b.example.invalid" })).toBe("CMS_SITE_URL_INVALID");
    expect(await bad({ baseUrl: "https://b.example.invalid/blog" })).toBe("CMS_SITE_URL_INVALID");
    expect(await bad({ defaultLocale: "en" })).toBe("CMS_SITE_DEFAULT_LOCALE_INVALID");
    expect(await bad({ adapter: "wordpress" })).toBe("CMS_ADAPTER_UNAVAILABLE");
    expect(await bad({ adapterConfig: { liveCheck: "yes" } })).toBe("CMS_ADAPTER_CONFIG_INVALID");
    expect(await bad({ routes: { article: { en: "/en/{slug}/" } } })).toBe("CMS_SITE_ROUTE_LOCALE_UNKNOWN");
    expect(await bad({ notifiers: [{ kind: "coolify_rebuild", connectionId: randomUUID() }] })).toBe("CMS_NOTIFIER_UNAVAILABLE");
    expect(await bad({ notifiers: [{ kind: "webhook", endpointId: randomUUID() }] })).toBe("CMS_NOTIFIER_ENDPOINT_UNKNOWN");

    const stale = await call("owner", "PATCH", `/sites/${created.id}`, { version: 9, name: "Neu" });
    expect(code(stale)).toBe("CMS_VERSION_CONFLICT");
    const renamed = await call("owner", "PATCH", `/sites/${created.id}`, { version: 1, name: "Neu" });
    expect(renamed.json().site).toMatchObject({ name: "Neu", version: 2 });
    expect((await call("editor", "PATCH", `/sites/${created.id}`, { version: 2, name: "Nope" })).statusCode).toBe(403);

    const archived = await call("owner", "POST", `/sites/${created.id}/archive`, { version: 2 });
    expect(archived.json().site).toMatchObject({ archived: true, version: 3 });
    expect((await call("viewer", "GET", "/sites")).json().items.map((s: { id: string }) => s.id)).not.toContain(created.id);
    expect(code(await call("owner", "PATCH", `/sites/${created.id}`, { version: 3, name: "Zu" }))).toBe("CMS_SITE_ARCHIVED");
    const restored = await call("owner", "POST", `/sites/${created.id}/restore`, { version: 3 });
    expect(restored.json().site).toMatchObject({ archived: false, version: 4 });
  });

  it("verifies that Orbit reaches the site; a new origin resets the verification", async () => {
    const created = await site();
    setSiteCheckFetchForTests(async () => new Response("down", { status: 503 }));
    const down = await call("owner", "POST", `/sites/${created.id}/verify`);
    expect(down.statusCode).toBe(422);
    expect(down.json().error).toMatchObject({ code: "CMS_SITE_UNREACHABLE", detail: { httpStatus: 503 } });
    let seen = "";
    setSiteCheckFetchForTests(async (url) => {
      seen = String(url);
      return new Response("<html></html>", { status: 200 });
    });
    const up = await call("owner", "POST", `/sites/${created.id}/verify`);
    expect(up.statusCode, up.body).toBe(200);
    expect(seen).toBe("https://site.example.invalid/");
    expect(up.json().site.verification).toBe("read_verified");
    const moved = await call("owner", "PATCH", `/sites/${created.id}`, { version: 1, baseUrl: "https://other.example.invalid" });
    expect(moved.json().site.verification).toBe("configured");
  });

  it("enforces a site's editorial rules before anyone decides", async () => {
    const strict = await site({ contentRules: { forbiddenPhrases: ["Garantiert"], plainText: true, excerptRequired: true } });
    const { entryId, published } = await publish([strict.id], doc(para("Das ist garantiert gut.", { marks: ["bold"] }), { type: "divider" }));
    expect(published.statusCode).toBe(422);
    expect(published.json().error.detail.issues).toEqual([
      {
        code: "CMS_CONTENT_RULE",
        siteId: strict.id,
        violations: [{ rule: "forbiddenPhrases", phrases: ["Garantiert"] }, { rule: "plainText", blocks: ["divider", "formatting"] }, { rule: "excerptRequired" }],
      },
    ]);
    const check = (await call("viewer", "GET", `/entries/${entryId}/preflight`)).json();
    expect(check.ok).toBe(false);
  });

  it("a site hears only about its own content; unbound endpoints hear about all", async () => {
    process.env.ORBIT_WEBHOOKS = "true";
    const hookA = await endpoint("a");
    const hookB = await endpoint("b");
    const shared = await endpoint("shared");
    const siteA = await site({ notifiers: [{ kind: "webhook", endpointId: hookA.id }] });
    await site({ notifiers: [{ kind: "webhook", endpointId: hookB.id }] });
    const dup = await call("owner", "POST", "/sites", {
      name: "D", baseUrl: "https://d.example.invalid", locales: ["de"], defaultLocale: "de",
      notifiers: [{ kind: "webhook", endpointId: hookA.id }, { kind: "webhook", endpointId: hookA.id }],
    });
    expect(code(dup)).toBe("CMS_NOTIFIER_DUPLICATE");

    const { entryId, published } = await publish([siteA.id]);
    expect(published.statusCode, published.body).toBe(200);
    const deliveries = await run((tx) => tx.webhookDelivery.findMany({ where: { projectId, eventType: "cms.entry.published" } }));
    const mine = deliveries.filter((d) => (d.payload as { entry: { id: string } }).entry.id === entryId);
    expect(mine.map((d) => d.endpointId).sort()).toEqual([hookA.id, shared.id].sort());
    expect(new Set(mine.map((d) => d.eventId)).size).toBe(1);

    const pub = (await call("viewer", "GET", `/entries/${entryId}/publications`)).json().items[0];
    expect(pub).toMatchObject({ status: "notified" });
    expect(pub.notifiedAt).not.toBeNull();
    const steps = (await call("viewer", "GET", `/publications/${pub.id}`)).json().steps.map((s: { step: string; outcome: string }) => `${s.step}:${s.outcome}`);
    expect(steps).toEqual(["switch:ok", "notify:ok"]);

    const test = await call("owner", "POST", `/sites/${siteA.id}/notifiers/test`);
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json().deliveries).toMatchObject([{ endpointId: hookA.id }]);
    for (const hook of [hookA, hookB, shared]) await run((tx) => tx.webhookEndpoint.update({ where: { id: hook.id }, data: { status: "disabled", disabledReason: "test", disabledAt: new Date() } }));
  });

  it("the live check confirms the revision, retries and then asks for a person", async () => {
    const checked = await site({ adapterConfig: { liveCheck: true, liveCheckMinutes: [1, 2] } });
    const { entryId, published, slug } = await publish([checked.id]);
    expect(published.statusCode, published.body).toBe(200);
    const revision = published.json().publishedRevision as { id: string; number: number };
    const pubId = (published.json().publicationIds as string[])[0]!;
    const jobs = await liveJobs(pubId);
    expect(jobs).toHaveLength(1);
    expect(Date.parse((jobs[0]!.data as { availableAt: string }).availableAt)).toBeGreaterThan(Date.now() + 30_000);

    // The site still shows an old revision, then the page is right.
    let html = `<html><head><meta content="0" name="orbit-revision"></head></html>`;
    let url = "";
    setLiveCheckFetchForTests(async (target) => {
      url = String(target);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    expect(await runLiveCheck(workerScope(), pubId)).toEqual({ status: "retry", errorCode: "CMS_LIVE_OLD_REVISION" });
    expect(url).toBe(`https://site.example.invalid/blog/${slug}/`);
    html = `<html><head><meta name='orbit-revision' content='${revision.id}'></head></html>`;
    expect(await runLiveCheck(workerScope(), pubId)).toEqual({ status: "live_verified" });
    const pub = (await call("viewer", "GET", `/publications/${pubId}`)).json();
    expect(pub).toMatchObject({ status: "live_verified", errorCode: null });
    expect(pub.steps.filter((s: { step: string }) => s.step === "live_check").map((s: { outcome: string; httpStatus: number }) => `${s.outcome}:${s.httpStatus}`)).toEqual(["failed:200", "ok:200"]);
    expect((await call("viewer", "GET", `/sites/${checked.id}`)).json().site.verification).toBe("live_verified");
    expect(await runLiveCheck(workerScope(), pubId)).toEqual({ status: "nothing_to_check" });

    // Withdrawn: the old page must be gone; a page that stays asks for a person.
    const withdrawn = await call("editor", "POST", `/entries/${entryId}/unpublish-requests`, { version: (await call("viewer", "GET", `/entries/${entryId}`)).json().entry.version });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const goneId = (withdrawn.json().publicationIds as string[])[0]!;
    setLiveCheckFetchForTests(async () => new Response(html, { status: 200 }));
    expect(await runLiveCheck(workerScope(), goneId)).toEqual({ status: "retry", errorCode: "CMS_LIVE_STILL_SERVED" });
    setLiveCheckFetchForTests(async () => {
      throw new Error("offline");
    });
    expect(await runLiveCheck(workerScope(), goneId)).toEqual({ status: "needs_attention", errorCode: "CMS_LIVE_CHECK_FAILED" });
    expect((await call("viewer", "GET", `/publications/${goneId}`)).json()).toMatchObject({ status: "visible", errorCode: "CMS_LIVE_CHECK_FAILED" });
    const attention = await run((tx) => cmsAttention(tx, ownerScope(), new Date()));
    expect(attention).toContainEqual(expect.objectContaining({ kind: "cms_live_check_failed", count: 1, moduleId: "cms" }));
    const events = await run((tx) => tx.domainEvent.findMany({ where: { projectId, type: "cms.publication.needs_attention" } }));
    expect(events.some((e) => (e.data as { code?: string }).code === "CMS_LIVE_CHECK_FAILED")).toBe(true);

    // A 410 counts as gone.
    const second = await publish([checked.id]);
    const again = await call("editor", "POST", `/entries/${second.entryId}/unpublish-requests`, { version: (await call("viewer", "GET", `/entries/${second.entryId}`)).json().entry.version });
    setLiveCheckFetchForTests(async () => new Response("gone", { status: 410 }));
    expect(await runLiveCheck(workerScope(), (again.json().publicationIds as string[])[0]!)).toEqual({ status: "live_verified" });
  });

  it("sites without the check get no job; disabled module skips quietly", async () => {
    const plain = await site();
    const { published } = await publish([plain.id]);
    const pubId = (published.json().publicationIds as string[])[0]!;
    expect(await liveJobs(pubId)).toHaveLength(0);
    expect(await runLiveCheck(workerScope(), pubId)).toEqual({ status: "skipped", errorCode: "CMS_LIVE_CHECK_OFF" });
    delete process.env.ORBIT_CMS;
    expect(await runLiveCheck(workerScope(), pubId)).toEqual({ status: "skipped", errorCode: "CMS_DISABLED" });
  });

  it("a route change on a site with live entries leaves 301s; live locales cannot be dropped", async () => {
    const moving = await site();
    const { entryId, slug } = await publish([moving.id]);
    const dropped = await call("owner", "PATCH", `/sites/${moving.id}`, { version: 1, locales: ["en"], defaultLocale: "en", routes: { article: { en: "/en/blog/{slug}/" } } });
    expect(code(dropped)).toBe("CMS_SITE_LOCALE_IN_USE");
    const changed = await call("owner", "PATCH", `/sites/${moving.id}`, { version: 1, routes: { article: { de: "/artikel/{slug}/", en: "/en/blog/{slug}/" } } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().redirects).toEqual([{ fromPath: `/blog/${slug}/`, toPath: `/artikel/${slug}/`, entryId }]);
    const redirects = (await call("viewer", "GET", `/sites/${moving.id}/redirects`)).json().items;
    expect(redirects).toMatchObject([{ fromPath: `/blog/${slug}/`, toEntryId: entryId, code: 301 }]);
    expect((await call("viewer", "GET", `/sites/${moving.id}`)).json()).toMatchObject({ entries: 1, liveEntries: 1 });
    const summary = (await call("viewer", "GET", "/summary")).json();
    expect(summary.entries.published).toBeGreaterThanOrEqual(1);
    expect(summary.sites).toBeGreaterThanOrEqual(1);
    expect(summary.recent[0]).toMatchObject({ status: expect.any(String), title: expect.any(String) });
    // The calendar (CH1.14e): the publication of today, one item for the entry.
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const calendar = await call("viewer", "GET", `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(calendar.statusCode, calendar.body).toBe(200);
    expect(calendar.json().items.filter((i: { entryId: string }) => i.entryId === entryId)).toEqual([
      expect.objectContaining({ kind: "published", siteIds: [moving.id], title: expect.any(String) }),
    ]);
    const tooLong = await call("viewer", "GET", `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 90 * 86_400_000).toISOString())}`);
    expect(tooLong.statusCode).toBe(400);
  });

  it("reads the revision meta tag in any attribute order", () => {
    expect(metaContent(`<meta property="og:x" content="a"><META NAME="orbit-revision" CONTENT="7">`, "orbit-revision")).toBe("7");
    expect(metaContent(`<meta content=abc name=orbit-revision>`, "orbit-revision")).toBe("abc");
    expect(metaContent(`<meta name="other" content="1">`, "orbit-revision")).toBeNull();
    expect(metaContent(`<meta data-name="orbit-revision" data-content="x" name="orbit-revision" content="9">`, "orbit-revision")).toBe("9");
    expect(metaContent(`<meta data-name="orbit-revision" content="x">`, "orbit-revision")).toBeNull();
  });
});
