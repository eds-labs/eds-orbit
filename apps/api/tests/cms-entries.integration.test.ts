import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { clearRedirectsAt, redirectSlugChange, redirectWithdrawn } from "../src/modules/cms/entries/redirects.ts";
import { diffBlocks } from "../src/modules/cms/entries/revisions.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

const para = (text: string) => ({ type: "paragraph", content: [{ text }] });
const doc = (...texts: string[]) => ({ schema: "orbit-doc", version: 1, blocks: texts.map(para) });

/**
 * The content module's entry service through its internal routes (ADR 0029,
 * CH1.8): drafts with optimistic versions, immutable revisions with diff and
 * restore, slugs that stay reserved while live, translations, archive, terms,
 * authors, site assignment and redirects; viewers only read.
 */
describe.skipIf(!enabled)("content entries", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    project = projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project}/cms${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ids.owner, role: "owner" });
  const createEntry = async (payload: object, who: keyof typeof ids = "editor") => {
    const response = await call(who, "POST", "/entries", payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const saveDraft = (entryId: string, payload: object, who: keyof typeof ids = "editor") =>
    call(who, "PATCH", `/entries/${entryId}/draft`, payload);
  const addSite = async (locales = ["de", "en"]) => {
    const id = randomUUID();
    await scoped(workspaceId, projectId, (tx) =>
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
  /** Marks an entry live with its latest revision, as the publishing core will (CH1.10). */
  const markLive = (entryId: string, revisionId: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.cmsEntry.update({
        where: { id: entryId },
        data: { status: "published", publishedRevisionId: revisionId, firstPublishedAt: new Date(), lastPublishedAt: new Date() },
      }),
    );

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms entries ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic cms entries",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms entries" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms entries B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    for (const project of [projectId, otherProjectId])
      await scoped(workspaceId, project, (tx) =>
        tx.projectModule.create({
          data: { workspaceId, projectId: project, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
        }),
      );
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
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
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("creates entries with slugs from titles; viewers only read", async () => {
    const first = await createEntry({ type: "article", locale: "de", title: "Familienkalender für Großeltern" });
    expect(first.entry).toMatchObject({ type: "article", locale: "de", status: "draft", slug: "familienkalender-fuer-grosseltern", origin: "manual" });
    expect(first.draft).toMatchObject({ title: "Familienkalender für Großeltern", version: 1, fields: { faqs: [], cta: null } });
    expect(first.unsavedChanges).toBe(true);
    const second = await createEntry({ type: "article", locale: "de", title: "Familienkalender für Großeltern" });
    expect(second.entry.slug).toBe("familienkalender-fuer-grosseltern-2");
    // The same slug in another locale is fine; an explicit duplicate is not.
    expect((await createEntry({ type: "article", locale: "en", slug: "familienkalender-fuer-grosseltern" })).entry.slug).toBe(
      "familienkalender-fuer-grosseltern",
    );
    const taken = await call("editor", "POST", "/entries", { type: "article", locale: "de", slug: "familienkalender-fuer-grosseltern" });
    expect([taken.statusCode, code(taken)]).toEqual([409, "CMS_SLUG_TAKEN"]);
    const off = await call("editor", "POST", "/entries", { type: "faq", locale: "de", title: "x" });
    expect([off.statusCode, code(off)]).toEqual([422, "CMS_TYPE_UNAVAILABLE"]);
    const viewer = await call("viewer", "POST", "/entries", { type: "article", locale: "de", title: "x" });
    expect([viewer.statusCode, code(viewer)]).toEqual([403, "FORBIDDEN"]);
    expect((await call("viewer", "GET", `/entries/${first.entry.id}`)).statusCode).toBe(200);
    // Another project of the same workspace does not see the entry.
    const foreign = await call("owner", "GET", `/entries/${first.entry.id}`, undefined, otherProjectId);
    expect([foreign.statusCode, code(foreign)]).toEqual([404, "CMS_ENTRY_NOT_FOUND"]);
  });

  it("saves drafts with optimistic versions and validated content", async () => {
    const { entry } = await createEntry({ type: "article", locale: "de", title: "Entwurf" });
    const saved = await saveDraft(entry.id, {
      version: 1,
      title: "Entwurf eins",
      body: { schema: "orbit-doc", version: 1, blocks: [para("Hallo"), { type: "paragraph", content: [] }, para("Welt")] },
      fields: { faqs: [{ question: "Kostet es etwas?", answer: "Nein." }] },
      seo: { seoTitle: "Entwurf eins", robots: { index: true, follow: true } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const body = saved.json();
    expect(body.draft.version).toBe(2);
    // Stored canonical: the empty paragraph is gone.
    expect(body.draft.body.blocks).toHaveLength(2);
    expect(body.draft.fields).toMatchObject({ faqs: [{ question: "Kostet es etwas?" }], checklist: [] });
    const stale = await saveDraft(entry.id, { version: 1, title: "Alt" });
    expect([stale.statusCode, code(stale)]).toEqual([409, "CMS_DRAFT_STALE"]);
    expect(stale.json().error.detail).toEqual({ version: 2 });
    const script = await saveDraft(entry.id, { version: 2, body: { schema: "orbit-doc", version: 1, blocks: [{ type: "html", html: "<script>" }] } });
    expect([script.statusCode, code(script)]).toEqual([422, "CMS_BODY_INVALID"]);
    expect(script.json().error.detail.problems[0]).toMatchObject({ path: expect.any(String), code: expect.any(String) });
    const link = await saveDraft(entry.id, {
      version: 2,
      body: { schema: "orbit-doc", version: 1, blocks: [{ type: "paragraph", content: [{ text: "x", link: { href: "javascript:alert(1)" } }] }] },
    });
    expect([link.statusCode, code(link)]).toEqual([422, "CMS_BODY_INVALID"]);
    const unknownAuthor = await saveDraft(entry.id, { version: 2, authorIds: [randomUUID()] });
    expect([unknownAuthor.statusCode, code(unknownAuthor)]).toEqual([422, "CMS_REFERENCE_UNKNOWN"]);
    const badFields = await saveDraft(entry.id, { version: 2, fields: { cta: { label: "x", href: "http://insecure.example" } } });
    expect(badFields.statusCode).toBe(400);
    const badSeo = await saveDraft(entry.id, { version: 2, seo: { seoTitle: "x".repeat(71) } });
    expect(badSeo.statusCode).toBe(400);
    const viewer = await saveDraft(entry.id, { version: 2, title: "Viewer" }, "viewer");
    expect([viewer.statusCode, code(viewer)]).toEqual([403, "FORBIDDEN"]);
    const after = (await call("editor", "GET", `/entries/${entry.id}`)).json();
    expect(after.draft).toMatchObject({ title: "Entwurf eins", version: 2 });
    // Content-free audit, one record per member and editing session: the
    // editor's saves follow the creation record; the owner's save opens one.
    expect((await saveDraft(entry.id, { version: 2, seo: { seoTitle: "Neu" }, excerpt: "Kurz" }, "owner")).statusCode).toBe(200);
    const audits = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({ where: { projectId, resourceId: entry.id, action: "cms.draft.saved" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ fields: ["excerpt", "seo"] });
    expect(audits[0]!.actorId).toBe(ids.owner);
  });

  it("keeps revisions, diffs them and restores one into the draft", async () => {
    const { entry } = await createEntry({ type: "article", locale: "de", title: "Version" });
    await saveDraft(entry.id, { version: 1, body: doc("Eins", "Zwei") });
    const first = await call("editor", "POST", `/entries/${entry.id}/revisions`, { changeNote: "Erste Fassung" });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ created: true, revision: { number: 1, changeNote: "Erste Fassung", wordCount: 2 } });
    const again = await call("editor", "POST", `/entries/${entry.id}/revisions`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, revision: { id: first.json().revision.id } });
    expect((await call("editor", "GET", `/entries/${entry.id}`)).json().unsavedChanges).toBe(false);

    await saveDraft(entry.id, { version: 2, title: "Version zwei", slug: "version-zwei", body: doc("Eins", "Drei", "Vier") });
    const staleDraft = await call("editor", "POST", `/entries/${entry.id}/revisions`, { draftVersion: 2 });
    expect([staleDraft.statusCode, code(staleDraft)]).toEqual([409, "CMS_DRAFT_STALE"]);
    const second = (await call("editor", "POST", `/entries/${entry.id}/revisions`, { draftVersion: 3 })).json().revision;
    expect(second).toMatchObject({ number: 2, slug: "version-zwei", basedOnRevisionId: first.json().revision.id });
    expect(second.contentHash).not.toBe(first.json().revision.contentHash);

    const list = (await call("viewer", "GET", `/entries/${entry.id}/revisions?limit=1`)).json();
    expect(list.items.map((r: { number: number }) => r.number)).toEqual([2]);
    expect(list.nextBefore).toBe(2);
    expect((await call("viewer", "GET", `/entries/${entry.id}/revisions?before=2`)).json().items[0].number).toBe(1);

    const diff = (await call("viewer", "GET", `/entries/${entry.id}/revisions/diff?from=${first.json().revision.id}&to=${second.id}`)).json();
    expect(diff.fields.map((f: { name: string }) => f.name)).toEqual(["slug", "title"]);
    expect(diff.body).toEqual([
      { op: "equal", count: 1 },
      { op: "removed", type: "paragraph", text: "Zwei" },
      { op: "added", type: "paragraph", text: "Drei" },
      { op: "added", type: "paragraph", text: "Vier" },
    ]);
    const toDraft = (await call("viewer", "GET", `/entries/${entry.id}/revisions/diff?from=${second.id}`)).json();
    expect(toDraft).toMatchObject({ to: "draft", changed: false, fields: [], body: [] });

    const restored = await call("editor", "POST", `/entries/${entry.id}/revisions/${first.json().revision.id}/restore`, { draftVersion: 3 });
    expect(restored.statusCode, restored.body).toBe(200);
    const now = (await call("editor", "GET", `/entries/${entry.id}`)).json();
    expect(now.entry.slug).toBe("version");
    expect(now.draft).toMatchObject({ title: "Version", version: 4 });
    expect(now.draft.body.blocks).toHaveLength(2);
    const full = (await call("viewer", "GET", `/entries/${entry.id}/revisions/${first.json().revision.id}`)).json();
    expect(full.body.blocks).toHaveLength(2);
    const missing = await call("viewer", "GET", `/entries/${entry.id}/revisions/${randomUUID()}`);
    expect([missing.statusCode, code(missing)]).toEqual([404, "CMS_REVISION_NOT_FOUND"]);
  });

  it("keeps a live slug reserved after the draft moved to a new one", async () => {
    const { entry } = await createEntry({ type: "article", locale: "de", slug: "live-artikel", title: "Live" });
    const revision = (await call("editor", "POST", `/entries/${entry.id}/revisions`, {})).json().revision;
    await markLive(entry.id, revision.id);
    const moved = await saveDraft(entry.id, { version: 1, slug: "live-artikel-neu" });
    expect(moved.json().entry).toMatchObject({ slug: "live-artikel-neu", status: "published" });
    const other = await call("editor", "POST", "/entries", { type: "article", locale: "de", slug: "live-artikel" });
    expect([other.statusCode, code(other)]).toEqual([409, "CMS_SLUG_TAKEN"]);
    // A generated slug steps around it.
    expect((await createEntry({ type: "article", locale: "de", title: "Live Artikel" })).entry.slug).toBe("live-artikel-2");
    // Live content is withdrawn through approval (CH1.10), not archived directly.
    const archived = await call("editor", "POST", `/entries/${entry.id}/archive`, { version: 1 });
    expect([archived.statusCode, code(archived)]).toEqual([409, "CMS_ENTRY_LIVE"]);
  });

  it("archives and restores entries that are not live", async () => {
    const { entry } = await createEntry({ type: "article", locale: "de", title: "Archiv" });
    const stale = await call("editor", "POST", `/entries/${entry.id}/archive`, { version: 9 });
    expect([stale.statusCode, code(stale)]).toEqual([409, "CMS_VERSION_CONFLICT"]);
    const archived = (await call("editor", "POST", `/entries/${entry.id}/archive`, { version: 1 })).json();
    expect(archived.entry).toMatchObject({ status: "archived", version: 2 });
    const locked = await saveDraft(entry.id, { version: 1, title: "Neu" });
    expect([locked.statusCode, code(locked)]).toEqual([409, "CMS_ENTRY_ARCHIVED"]);
    const listed = (await call("viewer", "GET", "/entries?status=archived")).json();
    expect(listed.items.some((item: { id: string }) => item.id === entry.id)).toBe(true);
    expect((await call("viewer", "GET", "/entries")).json().items.some((item: { id: string }) => item.id === entry.id)).toBe(false);
    const restored = (await call("editor", "POST", `/entries/${entry.id}/unarchive`, { version: 2 })).json();
    expect(restored.entry).toMatchObject({ status: "draft", archivedAt: null, version: 3 });
  });

  it("lists entries newest first with filters, search and cursors", async () => {
    const marker = randomBytes(4).toString("hex");
    const made = [];
    for (let n = 0; n < 3; n++) made.push((await createEntry({ type: "article", locale: "de", title: `Liste ${marker} ${n}` })).entry.id);
    const first = (await call("viewer", "GET", `/entries?q=${marker}&limit=2`)).json();
    expect(first.items.map((i: { id: string }) => i.id)).toEqual([made[2], made[1]]);
    expect(first.items[0].title).toBe(`Liste ${marker} 2`);
    const rest = (await call("viewer", "GET", `/entries?q=${marker}&limit=2&cursor=${first.nextCursor}`)).json();
    expect(rest.items.map((i: { id: string }) => i.id)).toEqual([made[0]]);
    expect(rest.nextCursor).toBeNull();
    expect((await call("viewer", "GET", `/entries?q=${marker}&locale=en`)).json().items).toEqual([]);
    const badCursor = await call("viewer", "GET", "/entries?cursor=bm9wZQ");
    expect([badCursor.statusCode, code(badCursor)]).toEqual([422, "CURSOR_INVALID"]);
  });

  it("manages categories and tags with translations and a cycle-free hierarchy", async () => {
    const parent = (await call("editor", "POST", "/terms", { kind: "category", locale: "de", name: "Familie & Alltag" })).json();
    expect(parent).toMatchObject({ slug: "familie-alltag", parentId: null, version: 1 });
    const child = (await call("editor", "POST", "/terms", { kind: "category", locale: "de", name: "Kalender", parentId: parent.id })).json();
    expect(child.parentId).toBe(parent.id);
    const cycle = await call("editor", "PATCH", `/terms/${parent.id}`, { version: 1, parentId: child.id });
    expect([cycle.statusCode, code(cycle)]).toEqual([422, "CMS_TERM_PARENT_INVALID"]);
    const tagParent = await call("editor", "POST", "/terms", { kind: "tag", locale: "de", name: "Tipps", parentId: parent.id });
    expect([tagParent.statusCode, code(tagParent)]).toEqual([422, "CMS_TERM_PARENT_INVALID"]);
    const dup = await call("editor", "POST", "/terms", { kind: "category", locale: "de", name: "Familie Alltag" });
    expect([dup.statusCode, code(dup)]).toEqual([409, "CMS_SLUG_TAKEN"]);
    const en = (await call("editor", "POST", "/terms", { kind: "category", locale: "en", name: "Family life", translationOf: parent.id })).json();
    expect(en.translationGroupId).toBe(parent.translationGroupId);
    const enAgain = await call("editor", "POST", "/terms", { kind: "category", locale: "en", name: "Family", translationOf: parent.id });
    expect([enAgain.statusCode, code(enAgain)]).toEqual([409, "CMS_TRANSLATION_EXISTS"]);
    const renamed = (await call("editor", "PATCH", `/terms/${child.id}`, { version: 1, name: "Familienkalender" })).json();
    expect(renamed).toMatchObject({ name: "Familienkalender", slug: "kalender", version: 2 });
    // Archiving a category lifts its children one level.
    const archived = (await call("editor", "POST", `/terms/${parent.id}/archive`, { version: 1 })).json();
    expect(archived.archived).toBe(true);
    const terms = (await call("viewer", "GET", "/terms?kind=category&locale=de")).json().items;
    expect(terms.find((t: { id: string }) => t.id === child.id).parentId).toBeNull();
    expect(terms.some((t: { id: string }) => t.id === parent.id)).toBe(false);
    // Archived terms and terms of another locale cannot be put on a draft.
    const { entry } = await createEntry({ type: "article", locale: "de", title: "Mit Begriffen" });
    for (const termId of [parent.id, en.id]) {
      const refused = await saveDraft(entry.id, { version: 1, termIds: [termId] });
      expect([refused.statusCode, code(refused)]).toEqual([422, "CMS_REFERENCE_UNKNOWN"]);
    }
    expect((await saveDraft(entry.id, { version: 1, termIds: [child.id] })).statusCode).toBe(200);
  });

  it("creates translations in the same group with mapped terms and sites", async () => {
    const deTerm = (await call("editor", "POST", "/terms", { kind: "tag", locale: "de", name: "Ordnung" })).json();
    const enTerm = (await call("editor", "POST", "/terms", { kind: "tag", locale: "en", name: "Order", translationOf: deTerm.id })).json();
    const loneTerm = (await call("editor", "POST", "/terms", { kind: "tag", locale: "de", name: "Nur deutsch" })).json();
    const bothSite = await addSite(["de", "en"]);
    const deSite = await addSite(["de"]);
    const source = await createEntry({ type: "article", locale: "de", title: "Ordnung im Alltag", siteIds: [bothSite, deSite] });
    await saveDraft(source.entry.id, { version: 1, body: doc("Text"), termIds: [deTerm.id, loneTerm.id] });
    const created = await call("editor", "POST", `/entries/${source.entry.id}/translations`, { locale: "en" });
    expect(created.statusCode, created.body).toBe(201);
    const translation = created.json();
    expect(translation.entry).toMatchObject({ locale: "en", translationGroupId: source.entry.translationGroupId, slug: "ordnung-im-alltag" });
    expect(translation.draft).toMatchObject({ title: "Ordnung im Alltag", termIds: [enTerm.id] });
    expect(translation.siteIds).toEqual([bothSite]);
    expect(translation.translations).toEqual([expect.objectContaining({ id: source.entry.id, locale: "de" })]);
    const twice = await call("editor", "POST", `/entries/${source.entry.id}/translations`, { locale: "en" });
    expect([twice.statusCode, code(twice)]).toEqual([409, "CMS_TRANSLATION_EXISTS"]);
    const empty = (await call("editor", "POST", `/entries/${source.entry.id}/translations`, { locale: "fr", copy: false })).json();
    expect(empty.draft).toMatchObject({ title: "", termIds: [] });
    expect(empty.draft.body.blocks).toEqual([]);
  });

  it("manages authors with versions and assigns sites by locale", async () => {
    const author = (await call("editor", "POST", "/authors", { name: "Mario Euchner", bio: { de: "Gründer" }, sameAs: ["https://www.linkedin.com/in/x"] })).json();
    expect(author).toMatchObject({ slug: "mario-euchner", version: 1 });
    const insecure = await call("editor", "POST", "/authors", { name: "X", sameAs: ["http://example.com"] });
    expect(insecure.statusCode).toBe(400);
    const updated = (await call("editor", "PATCH", `/authors/${author.id}`, { version: 1, name: "Mario E." })).json();
    expect(updated).toMatchObject({ name: "Mario E.", slug: "mario-euchner", version: 2 });
    const stale = await call("editor", "PATCH", `/authors/${author.id}`, { version: 1, name: "Alt" });
    expect([stale.statusCode, code(stale)]).toEqual([409, "CMS_VERSION_CONFLICT"]);

    const { entry } = await createEntry({ type: "article", locale: "en", title: "Sites" });
    expect((await saveDraft(entry.id, { version: 1, authorIds: [author.id] })).statusCode).toBe(200);
    const deOnly = await addSite(["de"]);
    const wrong = await call("editor", "PUT", `/entries/${entry.id}/sites`, { siteIds: [deOnly], version: 1 });
    expect([wrong.statusCode, code(wrong)]).toEqual([422, "CMS_SITE_LOCALE_MISSING"]);
    const site = await addSite(["de", "en"]);
    const set = (await call("editor", "PUT", `/entries/${entry.id}/sites`, { siteIds: [site], version: 1 })).json();
    expect(set).toMatchObject({ siteIds: [site], entry: { version: 2 } });
    expect((await call("editor", "PUT", `/entries/${entry.id}/sites`, { siteIds: [], version: 2 })).json().siteIds).toEqual([]);
  });

  it("records redirects for moved and withdrawn entries and manual ones per site", async () => {
    const site = await addSite(["de", "en"]);
    const { entry } = await createEntry({ type: "article", locale: "de", slug: "alter-pfad", title: "Pfad", siteIds: [site] });
    const scope = ownerScope();
    const ref = { id: entry.id, type: "article", locale: "de" };
    expect(await scoped(workspaceId, projectId, (tx) => redirectSlugChange(tx, scope, ref, "alter-pfad", "neuer-pfad"))).toBe(1);
    let redirects = (await call("viewer", "GET", `/sites/${site}/redirects`)).json().items;
    expect(redirects).toEqual([expect.objectContaining({ fromPath: "/blog/alter-pfad/", toEntryId: entry.id, code: 301, reason: "slug_changed" })]);
    // Moving back: the entry lives at the old path again, so that redirect ends.
    await scoped(workspaceId, projectId, (tx) => redirectSlugChange(tx, scope, ref, "neuer-pfad", "alter-pfad"));
    redirects = (await call("viewer", "GET", `/sites/${site}/redirects`)).json().items;
    expect(redirects.map((r: { fromPath: string }) => r.fromPath)).toEqual(["/blog/neuer-pfad/"]);
    await scoped(workspaceId, projectId, (tx) => redirectWithdrawn(tx, scope, ref, "alter-pfad", null));
    redirects = (await call("viewer", "GET", `/sites/${site}/redirects`)).json().items;
    expect(redirects.find((r: { fromPath: string }) => r.fromPath === "/blog/alter-pfad/")).toMatchObject({ code: 410, reason: "archived" });
    await scoped(workspaceId, projectId, (tx) => clearRedirectsAt(tx, scope, ref, "alter-pfad"));
    expect((await call("viewer", "GET", `/sites/${site}/redirects`)).json().items).toHaveLength(1);

    const manual = await call("editor", "POST", `/sites/${site}/redirects`, { fromPath: "/alt/", toPath: "/neu/", code: 301 });
    expect(manual.statusCode, manual.body).toBe(201);
    const loop = await call("editor", "POST", `/sites/${site}/redirects`, { fromPath: "/neu/", toPath: "/alt/", code: 301 });
    expect([loop.statusCode, code(loop)]).toEqual([422, "CMS_REDIRECT_LOOP"]);
    const gone = await call("editor", "POST", `/sites/${site}/redirects`, { fromPath: "/weg/", toPath: "/x/", code: 410 });
    expect([gone.statusCode, code(gone)]).toEqual([422, "CMS_REDIRECT_TARGET_INVALID"]);
    const external = await call("editor", "POST", `/sites/${site}/redirects`, { fromPath: "/weg/", toPath: "//evil.example/", code: 301 });
    expect(external.statusCode).toBe(400);
    const viewer = await call("viewer", "POST", `/sites/${site}/redirects`, { fromPath: "/v/", code: 410 });
    expect([viewer.statusCode, code(viewer)]).toEqual([403, "FORBIDDEN"]);
    const removed = await call("editor", "DELETE", `/sites/${site}/redirects/${manual.json().id}`);
    expect(removed.statusCode).toBe(200);
    const again = await call("editor", "DELETE", `/sites/${site}/redirects/${manual.json().id}`);
    expect([again.statusCode, code(again)]).toEqual([404, "CMS_REDIRECT_NOT_FOUND"]);
    const otherProject = await call("owner", "GET", `/sites/${site}/redirects`, undefined, otherProjectId);
    expect([otherProject.statusCode, code(otherProject)]).toEqual([404, "CMS_SITE_NOT_FOUND"]);
  });
});

describe("block diff", () => {
  const block = (text: string) => ({ type: "paragraph" as const, content: [{ text }] });
  it("reports equal runs, removals and additions in order", () => {
    expect(diffBlocks([block("a"), block("b"), block("c")], [block("a"), block("c"), block("d")])).toEqual([
      { op: "equal", count: 1 },
      { op: "removed", type: "paragraph", text: "b" },
      { op: "equal", count: 1 },
      { op: "added", type: "paragraph", text: "d" },
    ]);
    expect(diffBlocks([], [block("x")])).toEqual([{ op: "added", type: "paragraph", text: "x" }]);
  });
});
