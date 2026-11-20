import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createApiKey } from "../src/platform/api-keys/keys.ts";
import { ingestAsset } from "../src/modules/cms/media/assets.ts";
import { previewToken } from "../src/modules/cms/delivery/preview.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

const doc = (...blocks: object[]) => ({ schema: "orbit-doc", version: 1, blocks });
const para = (text: string) => ({ type: "paragraph", content: [{ text }] });
const heading = (text: string) => ({ type: "heading", level: 2, content: [{ text }] });

/**
 * The delivery API (ADR 0029 §4.2, CH1.12): a website's server reads what is
 * live on its site with a project API key; the key's site filter holds; an
 * entry shows on a site once its live revision went live there; answers are
 * cacheable with ETags; previews read the draft with a signed token.
 */
describe.skipIf(!enabled)("content delivery API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "" };
  const cookies = { owner: "", editor: "" };
  const users: string[] = [];
  const saved = { ...process.env };
  const keys = ["ORBIT_CMS", "ORBIT_API_V1", "ORBIT_FILES", "FILES_BACKEND", "FILES_ENCRYPTION_KEY", "ORBIT_AI_IMAGE_LABELS", "ORBIT_PUBLIC_INGRESS"];
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
  const v1 = (token: string, url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/v1/cms${url}`, headers: { authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: ip(), ...headers } });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ids.owner, role: "owner" });

  let siteId = "";
  let otherSiteId = "";
  let deliveryKey = "";
  let narrowKey = "";
  let previewKey = "";

  const site = async (name: string, patch: object = {}) => {
    const response = await call("owner", "POST", "/sites", {
      name,
      baseUrl: `https://${name.toLowerCase()}.example.invalid`,
      locales: ["de", "en"],
      defaultLocale: "de",
      routes: { article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } },
      ...patch,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().site.id as string;
  };
  const entryOf = async (entryId: string) => (await call("owner", "GET", `/entries/${entryId}`)).json();
  /** A German article on the sites, published by the editor. */
  const publish = async (title: string, siteIds: string[], draft: object = {}) => {
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title, siteIds });
    expect(created.statusCode, created.body).toBe(201);
    const entryId = created.json().entry.id as string;
    await saveAndPublish(entryId, { body: doc(heading("Worum es geht"), para(`${title}: ein kurzer Text.`)), ...draft });
    return entryId;
  };
  const saveAndPublish = async (entryId: string, draft: object) => {
    const current = (await entryOf(entryId)).draft;
    const saved = await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: current.version, ...draft });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await call("editor", "POST", `/entries/${entryId}/publication-requests`, { draftVersion: saved.json().draft.version });
    expect(published.statusCode, published.body).toBe(200);
    return published.json();
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ORBIT_AI_IMAGE_LABELS: "false",
      ORBIT_API_V1: "true",
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of Object.keys(ids) as Who[]) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms delivery ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic cms delivery", members: { create: [{ userId: ids.owner, role: "owner" }, { userId: ids.editor, role: "viewer" }] } },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms delivery" } })).id;
    await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids.editor, role: "editor" } });
    await run((tx) =>
      tx.projectModule.create({ data: { workspaceId, projectId, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner } }),
    );
    for (const who of Object.keys(ids) as Who[]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: accounts[who] });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
    process.env.ORBIT_CMS = "true";
    siteId = await site("Familie");
    otherSiteId = await site("Andere");
    deliveryKey = (await createApiKey(ownerScope(), { name: "site", scopes: ["cms:delivery.read"] })).token;
    narrowKey = (await createApiKey(ownerScope(), { name: "other", scopes: ["cms:delivery.read"], resourceFilter: { siteIds: [otherSiteId] } })).token;
    previewKey = (await createApiKey(ownerScope(), { name: "preview", scopes: ["cms:preview.read"] })).token;
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
    process.env.ORBIT_API_V1 = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
    delete process.env.ORBIT_PUBLIC_INGRESS;
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

  it("authenticates keys, holds scopes, site filters and the module switch", async () => {
    expect((await app.inject({ method: "GET", url: `/api/v1/cms/sites/${siteId}/entries`, headers: { [CLIENT_IP_HEADER]: ip() } })).statusCode).toBe(401);
    expect(code(await v1(previewKey, `/sites/${siteId}/entries`))).toBe("API_KEY_SCOPE_MISSING");
    expect(code(await v1(narrowKey, `/sites/${siteId}/entries`))).toBe("CMS_SITE_NOT_FOUND");
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).statusCode).toBe(200);
    expect(code(await v1(deliveryKey, `/sites/${randomUUID()}/entries`))).toBe("CMS_SITE_NOT_FOUND");
    delete process.env.ORBIT_CMS;
    expect((await v1(deliveryKey, `/sites/${siteId}/entries`)).statusCode).toBe(404);
  });

  it("lists and serves live entries with paths, alternates, HTML, JSON-LD and ETags", async () => {
    const { asset } = await ingestAsset(ownerScope(), { bytes: PNG, name: "familie.png" }, { source: "upload" });
    await call("editor", "PATCH", `/assets/${asset.id}`, { version: asset.version, alt: { de: "Eine Familie am Tisch", en: "A family at the table" } });
    const term = await call("editor", "POST", "/terms", { kind: "category", locale: "de", name: "Alltag" });
    expect(term.statusCode, term.body).toBe(201);
    const termId = (term.json().term?.id ?? term.json().id) as string;
    const deId = await publish("Familienplanung leicht gemacht", [siteId], {
      heroAssetId: asset.id,
      termIds: [termId],
      excerpt: "Kurz erklärt.",
      seo: { metaDescription: "So plant eine Familie ihre Woche." },
      body: doc(heading("Worum es geht"), para("Ein <script>alert(1)</script> Text."), { type: "image", assetId: asset.id }),
    });
    // The English translation on the same site.
    const translated = await call("editor", "POST", `/entries/${deId}/translations`, { locale: "en", slug: "family-planning-made-easy" });
    expect(translated.statusCode, translated.body).toBe(201);
    const enId = translated.json().entry.id as string;
    await saveAndPublish(enId, { title: "Family planning made easy", termIds: [], body: doc(para("A short text.")) });

    const list = await v1(deliveryKey, `/sites/${siteId}/entries?locale=de`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers["cache-control"]).toContain("stale-if-error");
    const items = list.json().items as Array<Record<string, unknown>>;
    const de = items.find((i) => i.id === deId)!;
    expect(de).toMatchObject({
      type: "article",
      locale: "de",
      path: `/blog/${(await entryOf(deId)).entry.slug}/`,
      url: `https://familie.example.invalid/blog/${(await entryOf(deId)).entry.slug}/`,
      title: "Familienplanung leicht gemacht",
      excerpt: "Kurz erklärt.",
      revision: { number: 1 },
      terms: [{ id: termId, kind: "category", name: "Alltag" }],
      hero: { assetId: asset.id, alt: "Eine Familie am Tisch", width: 800, height: 600, aiGenerated: false },
    });
    expect(String((de.hero as { src: string }).src)).toMatch(/\/api\/public\/cms\/media\/[^/]+\/w\d+\.webp$/);
    expect(items.some((i) => i.id === enId)).toBe(false);
    // 304 for an unchanged list.
    const again = await v1(deliveryKey, `/sites/${siteId}/entries?locale=de`, { "if-none-match": String(list.headers.etag) });
    expect(again.statusCode).toBe(304);
    // Category filter by slug; the other site shows nothing.
    const slug = (term.json().term?.slug ?? term.json().slug) as string;
    expect((await v1(deliveryKey, `/sites/${siteId}/entries?locale=de&category=${slug}`)).json().items.map((i: { id: string }) => i.id)).toEqual([deId]);
    expect(code(await v1(deliveryKey, `/sites/${siteId}/entries?category=${slug}`))).toBe("CMS_LOCALE_REQUIRED");
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).json().items).toEqual([]);

    const deSlug = (await entryOf(deId)).entry.slug as string;
    // The renderer takes HTTPS images only; production's origin is HTTPS.
    const appOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://orbit.example.invalid";
    const full = await v1(deliveryKey, `/sites/${siteId}/entries/article/by-slug/${deSlug}?locale=de`).finally(() => {
      process.env.APP_ORIGIN = appOrigin;
    });
    expect(full.statusCode, full.body).toBe(200);
    const entry = full.json();
    expect(entry.body.html).not.toContain("<script");
    expect(entry.body.html).toContain("&lt;script&gt;");
    expect(entry.body.html).toMatch(/<img src="https:\/\/orbit\.example\.invalid\/api\/public\/cms\/media\/[^"]+" srcset="[^"]+ 480w/);
    expect(entry.body.html).toContain('alt="Eine Familie am Tisch"');
    expect(entry.toc).toEqual([{ anchor: "worum-es-geht", level: 2, text: "Worum es geht" }]);
    expect(entry.seo).toMatchObject({
      title: "Familienplanung leicht gemacht",
      description: "So plant eine Familie ihre Woche.",
      canonical: `https://familie.example.invalid/blog/${deSlug}/`,
      robots: { index: true, follow: true },
    });
    expect(entry.alternates).toEqual([
      { locale: "de", path: `/blog/${deSlug}/`, url: `https://familie.example.invalid/blog/${deSlug}/` },
      { locale: "en", path: "/en/blog/family-planning-made-easy/", url: "https://familie.example.invalid/en/blog/family-planning-made-easy/" },
      { locale: "x-default", path: `/blog/${deSlug}/`, url: `https://familie.example.invalid/blog/${deSlug}/` },
    ]);
    expect(entry.structuredData[0]).toMatchObject({ "@type": "BlogPosting", headline: "Familienplanung leicht gemacht", inLanguage: "de", url: entry.seo.canonical });
    expect(entry.structuredData.at(-1)).toMatchObject({ "@type": "BreadcrumbList" });
    expect(JSON.stringify(entry)).not.toMatch(/focusKeyword|createdBy|contentHash/);
    // The default locale applies without ?locale.
    expect((await v1(deliveryKey, `/sites/${siteId}/entries/article/by-slug/${deSlug}`)).statusCode).toBe(200);
    expect(code(await v1(deliveryKey, `/sites/${siteId}/entries/article/by-slug/${deSlug}?locale=en`))).toBe("CMS_ENTRY_NOT_FOUND");

    // Taxonomies with counts (only terms live content uses), authors (none), redirects (none yet).
    expect((await call("editor", "POST", "/terms", { kind: "category", locale: "de", name: "Unbenutzt" })).statusCode).toBe(201);
    const terms = (await v1(deliveryKey, `/sites/${siteId}/taxonomies/category?locale=de`)).json().items;
    expect(terms).toMatchObject([{ id: termId, slug, entries: 1 }]);
    expect(code(await v1(deliveryKey, `/sites/${siteId}/taxonomies/colour`))).toBe("CMS_TAXONOMY_NOT_FOUND");
    expect((await v1(deliveryKey, `/sites/${siteId}/authors`)).json()).toEqual({ items: [] });
  });

  it("changes reach a site with their publication: slugs, sites, withdrawal", async () => {
    const entryId = await publish("Wochenplan", [siteId]);
    const before = (await entryOf(entryId)).entry.slug as string;
    const manifest = (await v1(deliveryKey, `/sites/${siteId}/manifest`)).json();
    expect(manifest.site).toMatchObject({ id: siteId, defaultLocale: "de", trailingSlash: true });

    // A new slug: the old address answers 404 with where it went.
    await saveAndPublish(entryId, { slug: "wochenplan-neu" });
    const old = await v1(deliveryKey, `/sites/${siteId}/entries/article/by-slug/${before}`);
    expect(old.statusCode).toBe(404);
    expect(old.json().error.detail).toEqual({ redirect: { fromPath: `/blog/${before}/`, toPath: "/blog/wochenplan-neu/", code: 301 } });
    const redirects = (await v1(deliveryKey, `/sites/${siteId}/redirects`)).json().items;
    expect(redirects).toContainEqual({ fromPath: `/blog/${before}/`, toPath: "/blog/wochenplan-neu/", code: 301 });
    expect((await v1(deliveryKey, `/sites/${siteId}/manifest`)).json().revision).not.toBe(manifest.revision);

    // Another site assigned: nothing changes there until the next publication.
    const entry = (await entryOf(entryId)).entry;
    expect((await call("editor", "PUT", `/entries/${entryId}/sites`, { siteIds: [siteId, otherSiteId], version: entry.version })).statusCode).toBe(200);
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).json().items).toEqual([]);
    await saveAndPublish(entryId, { excerpt: "Jetzt auch dort." });
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).json().items.map((i: { id: string }) => i.id)).toEqual([entryId]);

    // Withdrawn: gone from lists, the address answers 410.
    const live = (await entryOf(entryId)).entry;
    expect((await call("editor", "POST", `/entries/${entryId}/unpublish-requests`, { version: live.version })).statusCode).toBe(200);
    expect((await v1(deliveryKey, `/sites/${siteId}/entries`)).json().items.map((i: { id: string }) => i.id)).not.toContain(entryId);
    expect((await v1(deliveryKey, `/sites/${siteId}/redirects`)).json().items).toContainEqual({ fromPath: "/blog/wochenplan-neu/", toPath: null, code: 410 });
    // The earlier 301 now ends at a withdrawn entry: 410 too, no dead hop.
    expect((await v1(deliveryKey, `/sites/${siteId}/redirects`)).json().items).toContainEqual({ fromPath: `/blog/${before}/`, toPath: null, code: 410 });
  });

  it("a site dropped by an update stops showing the entry and answers 410", async () => {
    const entryId = await publish("Zwei Websites", [siteId, otherSiteId]);
    const slug = (await entryOf(entryId)).entry.slug as string;
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).json().items.map((i: { id: string }) => i.id)).toContain(entryId);
    const entry = (await entryOf(entryId)).entry;
    expect((await call("editor", "PUT", `/entries/${entryId}/sites`, { siteIds: [siteId], version: entry.version })).statusCode).toBe(200);
    await saveAndPublish(entryId, { excerpt: "Nur noch hier." });
    expect((await v1(narrowKey, `/sites/${otherSiteId}/entries`)).json().items.map((i: { id: string }) => i.id)).not.toContain(entryId);
    expect((await v1(narrowKey, `/sites/${otherSiteId}/redirects`)).json().items).toContainEqual({ fromPath: `/blog/${slug}/`, toPath: null, code: 410 });
    expect((await v1(deliveryKey, `/sites/${siteId}/entries`)).json().items.map((i: { id: string }) => i.id)).toContain(entryId);
  });

  it("withdrawal acts on the sites that show the entry, whatever its assignment says", async () => {
    // Unassigned after publishing: the withdrawal still ends it on its site.
    const lonely = await publish("Abgemeldet", [siteId]);
    const lonelySlug = (await entryOf(lonely)).entry.slug as string;
    let entry = (await entryOf(lonely)).entry;
    expect((await call("editor", "PUT", `/entries/${lonely}/sites`, { siteIds: [], version: entry.version })).statusCode).toBe(200);
    expect((await v1(deliveryKey, `/sites/${siteId}/entries`)).json().items.map((i: { id: string }) => i.id)).toContain(lonely);
    entry = (await entryOf(lonely)).entry;
    const gone = await call("editor", "POST", `/entries/${lonely}/unpublish-requests`, { version: entry.version });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().entry.status).toBe("archived");
    expect((await v1(deliveryKey, `/sites/${siteId}/entries`)).json().items.map((i: { id: string }) => i.id)).not.toContain(lonely);
    expect((await v1(deliveryKey, `/sites/${siteId}/redirects`)).json().items).toContainEqual({ fromPath: `/blog/${lonelySlug}/`, toPath: null, code: 410 });

    // Moved to another site without a new publication: the 410 lands where it was shown.
    const moved = await publish("Umgezogen", [siteId]);
    const movedSlug = (await entryOf(moved)).entry.slug as string;
    entry = (await entryOf(moved)).entry;
    await call("editor", "PUT", `/entries/${moved}/sites`, { siteIds: [otherSiteId], version: entry.version });
    entry = (await entryOf(moved)).entry;
    expect((await call("editor", "POST", `/entries/${moved}/unpublish-requests`, { version: entry.version })).statusCode).toBe(200);
    expect((await v1(deliveryKey, `/sites/${siteId}/redirects`)).json().items).toContainEqual({ fromPath: `/blog/${movedSlug}/`, toPath: null, code: 410 });
    expect((await v1(narrowKey, `/sites/${otherSiteId}/redirects`)).json().items.map((r: { fromPath: string }) => r.fromPath)).not.toContain(`/blog/${movedSlug}/`);
  });

  it("sitemap leaves out noindex pages; the feed comes as data or RSS", async () => {
    const shown = await publish("Sichtbar im Feed", [siteId]);
    const hidden = await publish("Nicht im Index", [siteId], { seo: { robots: { index: false, follow: true } } });
    const sitemap = (await v1(deliveryKey, `/sites/${siteId}/sitemap?locale=de`)).json().items as Array<{ url: string; lastmod: string }>;
    const urls = sitemap.map((i) => i.url);
    expect(urls).toContain(`https://familie.example.invalid/blog/${(await entryOf(shown)).entry.slug}/`);
    expect(urls).not.toContain(`https://familie.example.invalid/blog/${(await entryOf(hidden)).entry.slug}/`);
    expect(sitemap[0]!.lastmod).toMatch(/^\d{4}-/);

    const json = (await v1(deliveryKey, `/sites/${siteId}/feed?limit=5`)).json();
    expect(json).toMatchObject({ title: "Familie", home: "https://familie.example.invalid/", locale: "de" });
    expect(json.items.length).toBeGreaterThan(0);
    const rss = await v1(deliveryKey, `/sites/${siteId}/feed?format=rss`);
    expect(rss.headers["content-type"]).toContain("application/rss+xml");
    expect(rss.body).toContain("<title>Sichtbar im Feed</title>");
    expect(rss.body).toMatch(/^<\?xml version="1.0"/);
  });

  it("previews read the current draft with a signed token", async () => {
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title: "Noch geheim", siteIds: [siteId] });
    const entryId = created.json().entry.id as string;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 1, body: doc(para("Entwurfstext")) });
    // Not live: delivery does not know it.
    expect(code(await v1(deliveryKey, `/sites/${siteId}/entries/article/by-slug/${created.json().entry.slug}`))).toBe("CMS_ENTRY_NOT_FOUND");

    const preview = await call("editor", "POST", `/entries/${entryId}/preview`, { siteId });
    expect(preview.statusCode, preview.body).toBe(200);
    const { token, path, previewUrl } = preview.json();
    expect(path).toBe(`/blog/${created.json().entry.slug}/`);
    expect(previewUrl).toBeNull();
    const read = await v1(previewKey, `/preview/entries?token=${encodeURIComponent(token)}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json()).toMatchObject({ id: entryId, title: "Noch geheim", body: { text: "Entwurfstext" }, preview: { draftVersion: 2, status: "draft" } });

    // Edits show on reload with the same token.
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 2, body: doc(para("Neuer Text")) });
    expect((await v1(previewKey, `/preview/entries?token=${encodeURIComponent(token)}`)).json().body.text).toBe("Neuer Text");

    expect(code(await v1(deliveryKey, `/preview/entries?token=${encodeURIComponent(token)}`))).toBe("API_KEY_SCOPE_MISSING");
    const expired = previewToken({ projectId, entryId, siteId, expiresAt: new Date(Date.now() - 1000) });
    expect(code(await v1(previewKey, `/preview/entries?token=${encodeURIComponent(expired)}`))).toBe("CMS_PREVIEW_NOT_FOUND");
    const forged = `${token.slice(0, -4)}AAAA`;
    expect(code(await v1(previewKey, `/preview/entries?token=${encodeURIComponent(forged)}`))).toBe("CMS_PREVIEW_NOT_FOUND");
    const foreign = previewToken({ projectId: randomUUID(), entryId, siteId, expiresAt: new Date(Date.now() + 60_000) });
    expect(code(await v1(previewKey, `/preview/entries?token=${encodeURIComponent(foreign)}`))).toBe("CMS_PREVIEW_NOT_FOUND");

    // A site with a preview route gets a ready link.
    const linked = await site("Vorschau", { adapterConfig: { previewPath: "/api/orbit/preview" } });
    const linkedPreview = await call("editor", "POST", `/entries/${entryId}/preview`, { siteId: linked });
    expect(linkedPreview.json().previewUrl).toMatch(/^https:\/\/vorschau\.example\.invalid\/api\/orbit\/preview\?token=cmsp\.[^&]+&path=%2Fblog%2F/);
  });

  it("preview images load only with a valid token and only while the draft shows them", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const { asset } = await ingestAsset(ownerScope(), { bytes: PNG, name: "entwurf.png" }, { source: "upload" });
    const { asset: other } = await ingestAsset(ownerScope(), { bytes: Buffer.concat([PNG, Buffer.from([0])]), name: "anderes.png" }, { source: "upload" }).catch(() => ({ asset }));
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title: "Mit Bild", siteIds: [siteId] });
    const entryId = created.json().entry.id as string;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 1, heroAssetId: asset.id });
    const { token } = (await call("editor", "POST", `/entries/${entryId}/preview`, { siteId })).json();
    const read = (await v1(previewKey, `/preview/entries?token=${encodeURIComponent(token)}`)).json();
    const src = new URL(read.hero.src);
    expect(src.pathname).toMatch(new RegExp(`^/api/public/cms/preview-media/${asset.id}/w\\d+\\.webp$`));
    expect(src.searchParams.get("token")).toBe(token);
    const at = (path: string, t: string) => app.inject({ method: "GET", url: `${path}?token=${encodeURIComponent(t)}`, headers: { [CLIENT_IP_HEADER]: ip() } });
    const image = await at(src.pathname, token);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    if (other.id !== asset.id) {
      expect((await at(src.pathname.replace(asset.id, other.id), token)).statusCode).toBe(404);
    }
    const expired = previewToken({ projectId, entryId, siteId, expiresAt: new Date(Date.now() - 1000) });
    expect((await at(src.pathname, expired)).statusCode).toBe(404);
    delete process.env.ORBIT_PUBLIC_INGRESS;
    expect((await at(src.pathname, token)).statusCode).toBe(404);
  });
});
