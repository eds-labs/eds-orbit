import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { registeredActionType } from "../src/platform/modules/contributions.ts";
import { createWebhookEndpoint } from "../src/platform/outbound-webhooks/webhooks.ts";
import { ingestAsset } from "../src/modules/cms/media/assets.ts";
import { publishDue } from "../src/modules/cms/publishing/worker.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

const doc = (...blocks: object[]) => ({ schema: "orbit-doc", version: 1, blocks });
const para = (text: string) => ({ type: "paragraph", content: [{ text }] });

/**
 * The content module's publishing core (ADR 0029 §4.6, CH1.10, decision
 * E-4): a member who may decide publishes directly, anyone else asks; the
 * owner or a content editor decides (setting), optionally under four eyes;
 * the approval binds revision, sites and time; scheduled publications go
 * live on the worker within the late window; withdrawal leaves a 410 or a
 * 301; slug changes leave a 301; websites hear about it by signed webhook.
 */
describe.skipIf(!enabled)("content publishing", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", editor2: "", viewer: "" };
  const cookies = { owner: "", editor: "", editor2: "", viewer: "" };
  const users: string[] = [];
  const saved = { ...process.env };
  const keys = ["ORBIT_CMS", "ORBIT_FILES", "FILES_BACKEND", "FILES_ENCRYPTION_KEY", "ORBIT_AI_IMAGE_LABELS", "ORBIT_WEBHOOKS"];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  type Who = keyof typeof ids;
  const call = (who: Who, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url: url.startsWith("/api/") ? url : `/api/projects/${projectId}/cms${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ids.owner, role: "owner" });
  const workerScope = (): Scope => ({ workspaceId, projectId, userId: "worker", role: "owner" });

  let siteId = "";
  const addSite = async (locales = ["de", "en"]) => {
    const id = randomUUID();
    await run((tx) =>
      tx.cmsSite.create({
        data: {
          id,
          workspaceId,
          projectId,
          name: `Site ${id.slice(0, 4)}`,
          baseUrl: "https://site.example.invalid",
          locales,
          defaultLocale: locales[0]!,
          routes: { article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } },
          createdBy: ids.owner,
        },
      }),
    );
    return id;
  };
  /** A draft entry with text, assigned to the site, as an editor makes it. */
  const article = async (title = `Artikel ${randomUUID().slice(0, 6)}`, sites = [siteId]) => {
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title, siteIds: sites });
    expect(created.statusCode, created.body).toBe(201);
    const entryId = created.json().entry.id as string;
    const saved = await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 1, body: doc(para("Ein kurzer Text.")) });
    expect(saved.statusCode, saved.body).toBe(200);
    return { entryId, draftVersion: saved.json().draft.version as number, slug: created.json().entry.slug as string };
  };
  const entryOf = async (entryId: string) => (await call("owner", "GET", `/entries/${entryId}`)).json();
  const setSettings = async (patch: object) => {
    const status = (await call("owner", "GET", "/status")).json();
    const response = await call("owner", "PUT", "/settings", { settings: { ...status.settings, ...patch }, version: status.settingsVersion });
    expect(response.statusCode, response.body).toBe(200);
  };
  /** The member's open decisions about one entry. */
  const decisions = async (who: Who, entryId: string) =>
    (
      (await call(who, "GET", `/api/projects/${projectId}/action-requests`)).json().items as Array<{
        id: string;
        actionType: string;
        summary: { operation?: { entryId?: string } };
      }>
    ).filter((item) => item.actionType.startsWith("cms.") && item.summary.operation?.entryId === entryId);
  const decide = async (who: Who, requestId: string, decision: "approve" | "reject") => {
    const request = await run((tx) => tx.entity.findFirstOrThrow({ where: { id: requestId } }));
    return call(who, "POST", `/api/projects/${projectId}/action-requests/${requestId}/decide`, {
      version: request.version,
      packageHash: (request.data as { packageHash: string }).packageHash,
      decision,
    });
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ORBIT_AI_IMAGE_LABELS: "false",
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of Object.keys(ids) as Who[]) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms publishing ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic cms publishing",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.editor2, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms publishing" } })).id;
    for (const [who, role] of [["editor", "editor"], ["editor2", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await run((tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
    for (const who of Object.keys(ids) as Who[]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: accounts[who] });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
    process.env.ORBIT_CMS = "true";
    siteId = await addSite();
  });
  beforeEach(async () => {
    process.env.ORBIT_CMS = "true";
    await setSettings({ publishApprovers: "owner_or_editor", fourEyes: false });
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
    delete process.env.ORBIT_WEBHOOKS;
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

  it("registers both types as W2 decided by editors, never mandatable or MCP-proposable", () => {
    for (const type of ["cms.entry.publish", "cms.entry.unpublish"]) {
      const def = registeredActionType(type);
      expect(def, type).toMatchObject({ riskClass: "W2", deciderRole: "editor", inbox: "editors", policyRequired: false });
      expect(def?.mandate, type).toBeUndefined();
      expect(def?.mcpProposable, type).not.toBe(true);
    }
  });

  it("an editor publishes directly by default; viewers cannot; preflight names what is missing", async () => {
    const { entryId, draftVersion } = await article();
    expect((await call("viewer", "POST", `/entries/${entryId}/publication-requests`, { draftVersion })).statusCode).toBe(403);

    // Without a site nothing can go live.
    const lonely = await call("editor", "POST", "/entries", { type: "article", locale: "de", title: "Ohne Website" });
    const lonelyId = lonely.json().entry.id;
    const check = (await call("viewer", "GET", `/entries/${lonelyId}/preflight`)).json();
    expect(check).toMatchObject({ ok: false, issues: [{ code: "CMS_SITE_REQUIRED" }] });
    const refused = await call("editor", "POST", `/entries/${lonelyId}/publication-requests`, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: "CMS_PREFLIGHT_FAILED", detail: { issues: [{ code: "CMS_SITE_REQUIRED" }] } });

    expect((await call("viewer", "GET", `/entries/${entryId}/preflight`)).json()).toEqual({ ok: true, issues: [] });
    const published = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion, changeNote: "Erste Fassung" });
    expect(published.statusCode, published.body).toBe(200);
    const body = published.json();
    expect(body).toMatchObject({ mode: "direct", requestId: null, entry: { status: "published" }, publishedRevision: { number: 1 }, pendingRequest: null });
    expect(body.publicationIds).toHaveLength(1);

    const list = (await call("viewer", "GET", `/entries/${entryId}/publications`)).json();
    expect(list.items).toMatchObject([{ action: "publish", status: "visible", siteId, approvalRequestId: null, attempts: 1 }]);
    const one = (await call("viewer", "GET", `/publications/${list.items[0].id}`)).json();
    expect(one.steps).toMatchObject([{ step: "switch", outcome: "ok" }, { step: "notify", outcome: "skipped", errorCode: "CMS_NO_NOTIFIER" }]);

    // The same revision again is refused; facts for other modules and the audit are content-free.
    const again = await call("editor", "POST", `/entries/${entryId}/publication-requests`, {});
    expect(code(again)).toBe("CMS_REVISION_ALREADY_LIVE");
    const event = await run((tx) => tx.domainEvent.findFirstOrThrow({ where: { subjectId: entryId, type: "cms.entry.published" } }));
    expect(event.data).toEqual({ revision: 1, previousRevision: null, sites: 1 });
    const audits = await run((tx) => tx.auditEvent.findMany({ where: { projectId, resourceId: entryId, action: "cms.publication.approved" } }));
    expect(audits.map((a) => a.metadata)).toEqual([{ channel: "direct", revision: 1, mode: "now", sites: 1 }]);
  });

  it("with owner approval an editor asks; only the owner decides; a rejection leaves nothing waiting", async () => {
    await setSettings({ publishApprovers: "owner" });
    const { entryId, draftVersion } = await article();
    const asked = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion });
    expect(asked.statusCode, asked.body).toBe(202);
    const requestId = asked.json().requestId as string;
    expect(asked.json()).toMatchObject({ mode: "requested", entry: { status: "draft" }, pendingRequest: { id: requestId, actionType: "cms.entry.publish", requesterId: ids.editor } });
    expect(code(await call("editor2", "POST", `/entries/${entryId}/publication-requests`, {}))).toBe("CMS_REQUEST_PENDING");
    expect(code(await call("editor", "POST", `/entries/${entryId}/archive`, { version: asked.json().entry.version }))).toBe("CMS_ENTRY_IN_REVIEW");

    expect(await decisions("editor2", entryId)).toEqual([]);
    expect(code(await decide("editor2", requestId, "approve"))).toBe("DECIDER_NOT_ALLOWED");
    expect((await decisions("owner", entryId)).map((d) => d.id)).toEqual([requestId]);
    const approved = await decide("owner", requestId, "approve");
    expect(approved.statusCode, approved.body).toBe(200);
    const entry = await entryOf(entryId);
    expect(entry).toMatchObject({ entry: { status: "published" }, pendingRequest: null, publishedRevision: { number: 1 } });
    const [pub] = (await call("owner", "GET", `/entries/${entryId}/publications`)).json().items;
    expect(pub).toMatchObject({ approvalRequestId: requestId, status: "visible", createdBy: ids.editor });
    const request = await run((tx) => tx.entity.findFirstOrThrow({ where: { id: requestId } }));
    expect((request.data as { status: string }).status).toBe("consumed");

    // A second change, rejected: the entry stays as it is and may be asked for again.
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: entry.draft.version, title: "Neuer Titel" });
    const second = (await call("editor", "POST", `/entries/${entryId}/publication-requests`, {})).json();
    expect((await decide("owner", second.requestId, "reject")).statusCode).toBe(200);
    expect(await entryOf(entryId)).toMatchObject({ entry: { status: "published" }, pendingRequest: null, publishedRevision: { number: 1 } });
    expect((await call("editor", "POST", `/entries/${entryId}/publication-requests`, {})).statusCode).toBe(202);
  });

  it("four eyes: nobody decides their own request; the current settings decide", async () => {
    await setSettings({ fourEyes: true });
    const { entryId, draftVersion } = await article();
    const own = await call("owner", "POST", `/entries/${entryId}/publication-requests`, { draftVersion });
    expect(own.json().mode).toBe("requested");
    expect(await decisions("owner", entryId)).toEqual([]);
    expect(code(await decide("owner", own.json().requestId, "approve"))).toBe("DECIDER_NOT_ALLOWED");
    expect((await decisions("editor", entryId)).map((d) => d.id)).toEqual([own.json().requestId]);
    expect((await decide("editor", own.json().requestId, "approve")).statusCode).toBe(200);
    expect((await entryOf(entryId)).entry.status).toBe("published");

    // Tightened after the request: editors no longer decide, even if listed before.
    const draft = (await entryOf(entryId)).draft;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: draft.version, excerpt: "Kurz gefasst." });
    const update = (await call("editor", "POST", `/entries/${entryId}/publication-requests`, {})).json();
    await setSettings({ publishApprovers: "owner" });
    expect(code(await decide("editor2", update.requestId, "approve"))).toBe("CMS_DECIDER_NOT_ALLOWED");
    expect((await decide("owner", update.requestId, "approve")).statusCode).toBe(200);
    const live = await entryOf(entryId);
    expect(live.publishedRevision.number).toBe(2);
    const updated = await run((tx) => tx.domainEvent.findFirstOrThrow({ where: { subjectId: entryId, type: "cms.entry.updated" } }));
    expect(updated.data).toEqual({ revision: 2, previousRevision: 1, sites: 1 });
  });

  it("a request goes stale when its sites change", async () => {
    await setSettings({ publishApprovers: "owner" });
    const second = await addSite(["de"]);
    const { entryId, draftVersion } = await article();
    const asked = (await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion })).json();
    const sites = await call("owner", "PUT", `/entries/${entryId}/sites`, { siteIds: [siteId, second], version: asked.entry.version });
    expect(sites.statusCode, sites.body).toBe(200);
    const decided = await decide("owner", asked.requestId, "approve");
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error).toMatchObject({ code: "CMS_REQUEST_STALE", detail: { reason: "sites" } });
  });

  it("a slug change of live content leaves a 301; sites hear about it by webhook", async () => {
    process.env.ORBIT_WEBHOOKS = "true";
    await run((tx) =>
      createWebhookEndpoint(tx, ownerScope(), {
        ownerModule: "cms",
        name: "Pilot site",
        url: "https://hooks.example.invalid/orbit",
        eventTypes: ["cms.entry.published", "cms.entry.updated", "cms.redirect.created"],
      }),
    );
    const { entryId, draftVersion, slug } = await article("Familienkalender teilen");
    await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion });
    const draft = (await entryOf(entryId)).draft;
    const moved = await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: draft.version, slug: "kalender-teilen" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await call("editor", "POST", `/entries/${entryId}/publication-requests`, {})).statusCode).toBe(200);
    const redirects = (await call("owner", "GET", `/sites/${siteId}/redirects`)).json().items;
    expect(redirects).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromPath: `/blog/${slug}/`, toEntryId: entryId, code: 301, reason: "slug_changed" })]),
    );
    const deliveries = await run((tx) => tx.webhookDelivery.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }));
    expect(deliveries.map((d) => d.eventType)).toEqual(["cms.entry.published", "cms.entry.updated", "cms.redirect.created"]);
    expect(deliveries[1]!.payload).toEqual({
      siteId,
      entry: { id: entryId, type: "article", locale: "de", slug: "kalender-teilen", path: "/blog/kalender-teilen/", revision: 2 },
      previousPath: `/blog/${slug}/`,
      tags: [`orbit:entry:${entryId}`, `orbit:list:${siteId}:article:de`, `orbit:sitemap:${siteId}`],
    });
    expect(deliveries[2]!.payload).toMatchObject({ siteId, fromPath: `/blog/${slug}/`, toPath: "/blog/kalender-teilen/", code: 301 });
  });

  it("schedules, goes live on the worker, waits for a person when late, and can be cancelled or superseded", async () => {
    const at = new Date(Date.now() + 3_600_000);
    const { entryId, draftVersion } = await article();
    const scheduled = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion, at: at.toISOString() });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json().entry).toMatchObject({ status: "scheduled", scheduledAt: at.toISOString() });
    const job = await run((tx) =>
      tx.entity.findFirstOrThrow({ where: { projectId, kind: "jobs", data: { path: ["resourceId"], equals: entryId } } }),
    );
    expect(job.data).toMatchObject({ topic: "cms_publish", availableAt: at.toISOString() });

    // Not yet due: nothing happens; due: it goes live.
    expect(await publishDue(workerScope(), entryId, new Date())).toMatchObject({ status: "nothing_due" });
    expect(await publishDue(workerScope(), entryId, new Date(at.getTime() + 60_000))).toMatchObject({ status: "succeeded" });
    expect((await entryOf(entryId)).entry).toMatchObject({ status: "published", scheduledAt: null, scheduledRevisionId: null });

    // Late beyond the window (24 h): a person decides again.
    let draft = (await entryOf(entryId)).draft;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: draft.version, title: "Spät" });
    await call("editor", "POST", `/entries/${entryId}/publication-requests`, { at: at.toISOString() });
    expect(await publishDue(workerScope(), entryId, new Date(at.getTime() + 25 * 3_600_000))).toMatchObject({
      status: "needs_attention",
      errorCode: "CMS_PUBLICATION_LATE",
    });
    let state = await entryOf(entryId);
    expect(state).toMatchObject({ entry: { status: "published", scheduledAt: null }, publishedRevision: { number: 1 } });
    const late = (await call("owner", "GET", `/entries/${entryId}/publications`)).json().items[0];
    expect(late).toMatchObject({ status: "needs_attention", errorCode: "CMS_PUBLICATION_LATE" });

    // Cancelled before its time: nothing goes live.
    const latest = state.latestRevision.id as string;
    await call("editor", "POST", `/entries/${entryId}/publication-requests`, { revisionId: latest, at: at.toISOString() });
    state = await entryOf(entryId);
    expect(state.entry.status).toBe("scheduled");
    const cancelled = await call("editor", "POST", `/entries/${entryId}/publication/cancel`, { version: state.entry.version });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().entry).toMatchObject({ status: "published", scheduledRevisionId: null });
    expect((await call("owner", "GET", `/entries/${entryId}/publications`)).json().items[0]).toMatchObject({ status: "cancelled", errorCode: "CMS_CANCELLED" });
    expect(await publishDue(workerScope(), entryId, new Date(at.getTime() + 60_000))).toMatchObject({ status: "nothing_due" });
    state = await entryOf(entryId);
    expect(code(await call("editor", "POST", `/entries/${entryId}/publication/cancel`, { version: state.entry.version }))).toBe("CMS_NOTHING_TO_CANCEL");

    // A schedule replaced by an immediate publication of the same revision.
    await call("editor", "POST", `/entries/${entryId}/publication-requests`, { revisionId: latest, at: at.toISOString() });
    const now = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { revisionId: latest });
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json()).toMatchObject({ entry: { status: "published", scheduledAt: null }, publishedRevision: { number: 2 } });
    const items = (await call("owner", "GET", `/entries/${entryId}/publications`)).json().items;
    expect(items.slice(0, 2).map((p: { status: string; errorCode: string | null }) => [p.status, p.errorCode])).toEqual([
      ["visible", null],
      ["cancelled", "CMS_SUPERSEDED"],
    ]);

    // Sites changed after the approval: the worker stops instead of reaching other sites.
    draft = (await entryOf(entryId)).draft;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: draft.version, title: "Noch einmal" });
    await call("editor", "POST", `/entries/${entryId}/publication-requests`, { at: at.toISOString() });
    await run((tx) => tx.cmsEntrySite.deleteMany({ where: { entryId } }));
    expect(await publishDue(workerScope(), entryId, new Date(at.getTime() + 60_000))).toMatchObject({ errorCode: "CMS_SITES_CHANGED" });
    expect((await entryOf(entryId)).publishedRevision.number).toBe(2);
  });

  it("withdraws live content with a 410, or a 301 to a replacement", async () => {
    const a = await article("Alter Ratgeber");
    const b = await article("Neuer Ratgeber");
    const c = await article("Dritter Ratgeber");
    for (const x of [a, b, c]) expect((await call("editor", "POST", `/entries/${x.entryId}/publication-requests`, { draftVersion: x.draftVersion })).statusCode).toBe(200);

    let state = await entryOf(a.entryId);
    expect(code(await call("editor", "POST", `/entries/${a.entryId}/archive`, { version: state.entry.version }))).toBe("CMS_ENTRY_LIVE");
    expect(code(await call("editor", "POST", `/entries/${a.entryId}/unpublish-requests`, { version: state.entry.version, replacementEntryId: a.entryId }))).toBe(
      "CMS_REPLACEMENT_INVALID",
    );
    const withdrawn = await call("editor", "POST", `/entries/${a.entryId}/unpublish-requests`, { version: state.entry.version, replacementEntryId: b.entryId });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json()).toMatchObject({ mode: "direct", entry: { status: "archived", publishedRevisionId: null } });
    state = await entryOf(c.entryId);
    await call("editor", "POST", `/entries/${c.entryId}/unpublish-requests`, { version: state.entry.version });
    const redirects = (await call("owner", "GET", `/sites/${siteId}/redirects`)).json().items;
    expect(redirects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromPath: `/blog/${a.slug}/`, toEntryId: b.entryId, code: 301, reason: "archived" }),
        expect.objectContaining({ fromPath: `/blog/${c.slug}/`, toEntryId: null, code: 410, reason: "archived" }),
      ]),
    );
    const archived = await entryOf(c.entryId);
    expect(code(await call("editor", "POST", `/entries/${c.entryId}/unpublish-requests`, { version: archived.entry.version }))).toBe("CMS_ENTRY_NOT_LIVE");
    expect((await run((tx) => tx.domainEvent.count({ where: { subjectId: c.entryId, type: "cms.entry.unpublished" } })))).toBe(1);
  });

  it("images in the article need alt text in its language before it goes live", async () => {
    const { asset } = await ingestAsset(ownerScope(), { bytes: PNG, name: "familie.png" }, { source: "upload" });
    const { entryId } = await article();
    const draft = (await entryOf(entryId)).draft;
    const withImage = await call("editor", "PATCH", `/entries/${entryId}/draft`, {
      version: draft.version,
      heroAssetId: asset.id,
      body: doc(para("Mit Bild."), { type: "image", assetId: asset.id }),
    });
    expect(withImage.statusCode, withImage.body).toBe(200);
    const refused = await call("editor", "POST", `/entries/${entryId}/publication-requests`, {});
    expect(refused.json().error).toMatchObject({ code: "CMS_PREFLIGHT_FAILED", detail: { issues: [{ code: "CMS_ALT_TEXT_MISSING", assetIds: [asset.id] }] } });
    // English alt text does not cover a German article.
    const en = await call("editor", "PATCH", `/assets/${asset.id}`, { version: asset.version, alt: { en: "A family at the table" } });
    expect(en.statusCode, en.body).toBe(200);
    expect(code(await call("editor", "POST", `/entries/${entryId}/publication-requests`, {}))).toBe("CMS_PREFLIGHT_FAILED");
    await call("editor", "PATCH", `/assets/${asset.id}`, { version: en.json().version, alt: { de: "Eine Familie am Tisch", en: "A family at the table" } });
    expect((await call("editor", "POST", `/entries/${entryId}/publication-requests`, {})).statusCode).toBe(200);
  });
});
