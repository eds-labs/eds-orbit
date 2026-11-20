import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createApiKey, revokeApiKey } from "../src/platform/api-keys/keys.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
const doc = (...blocks: object[]) => ({ schema: "orbit-doc", version: 1, blocks });
const para = (text: string) => ({ type: "paragraph", content: [{ text }] });

/**
 * The management API (ADR 0029 §4.3, CH1.13): integrations create and edit
 * drafts, media, terms and authors with a project API key; writes replay by
 * Idempotency-Key; a key only ever proposes a publication, a person in Orbit
 * decides, and a revoked key's proposal no longer executes.
 */
describe.skipIf(!enabled)("content management API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let ownerId = "";
  let cookie = "";
  const users: string[] = [];
  const saved = { ...process.env };
  const envKeys = ["ORBIT_CMS", "ORBIT_API_V1", "ORBIT_FILES", "FILES_BACKEND", "FILES_ENCRYPTION_KEY", "ORBIT_AI_IMAGE_LABELS"];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const tokens = { read: "", write: "", propose: "", filtered: "" };
  let proposeKeyId = "";
  let siteId = "";
  const api = (token: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `/api/v1/cms${url}`,
      headers: { authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: ip(), ...headers },
      ...(payload ? { payload } : {}),
    });
  const member = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() }, ...(payload ? { payload } : {}) });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ownerId, role: "owner" });

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ORBIT_AI_IMAGE_LABELS: "false",
      ORBIT_API_V1: "true",
      ORBIT_CMS: "true",
    });
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    ownerId = (await makeAuth().api.signUpEmail({ body: { email, name: "Synthetic cms management owner", password } })).user.id;
    users.push(ownerId);
    workspaceId = (await authDb.workspace.create({ data: { name: "Synthetic cms management", members: { create: [{ userId: ownerId, role: "owner" }] } } })).id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms management" } })).id;
    await run((tx) =>
      tx.projectModule.create({ data: { workspaceId, projectId, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ownerId } }),
    );
    const signIn = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: { email, password } });
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    const site = await member("POST", `/api/projects/${projectId}/cms/sites`, {
      name: "Familie",
      baseUrl: "https://familie.example.invalid",
      locales: ["de", "en"],
      defaultLocale: "de",
    });
    expect(site.statusCode, site.body).toBe(201);
    siteId = site.json().site.id;
    tokens.read = (await createApiKey(ownerScope(), { name: "read", scopes: ["cms:manage.read"] })).token;
    tokens.write = (await createApiKey(ownerScope(), { name: "write", scopes: ["cms:manage.read", "cms:manage.write"], confirmWrite: true })).token;
    const propose = await createApiKey(ownerScope(), { name: "propose", scopes: ["cms:manage.read", "cms:publish.propose"], confirmWrite: true });
    tokens.propose = propose.token;
    proposeKeyId = propose.id;
    tokens.filtered = (
      await createApiKey(ownerScope(), { name: "filtered", scopes: ["cms:manage.read"], resourceFilter: { siteIds: [siteId] } })
    ).token;
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
    process.env.ORBIT_API_V1 = "true";
  });
  afterAll(async () => {
    for (const key of envKeys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  /** An entry made through the API with text, ready to publish. */
  const draftEntry = async (title: string) => {
    const created = await api(tokens.write, "POST", "/entries", { type: "article", locale: "de", title, siteIds: [siteId] });
    expect(created.statusCode, created.body).toBe(201);
    const entryId = created.json().entry.id as string;
    const saved = await api(tokens.write, "PATCH", `/entries/${entryId}/draft`, { version: 1, body: doc(para("Aus einer Integration.")) });
    expect(saved.statusCode, saved.body).toBe(200);
    return { entryId, draftVersion: saved.json().draft.version as number };
  };

  it("holds scopes and refuses site-filtered keys", async () => {
    expect((await api(tokens.read, "GET", "/entries")).statusCode).toBe(200);
    expect(code(await api(tokens.read, "POST", "/entries", { type: "article", locale: "de", title: "Nein" }))).toBe("API_KEY_SCOPE_MISSING");
    expect(code(await api(tokens.filtered, "GET", "/entries"))).toBe("API_KEY_SITE_FILTER_UNSUPPORTED");
    expect(code(await api(tokens.write, "POST", "/entries/x/publication-requests", {}))).toBe("API_KEY_SCOPE_MISSING");
    const sites = (await api(tokens.read, "GET", "/sites")).json();
    expect(sites.items.map((s: { id: string }) => s.id)).toEqual([siteId]);
    delete process.env.ORBIT_CMS;
    expect((await api(tokens.read, "GET", "/entries")).statusCode).toBe(404);
  });

  it("creates and edits drafts, replays writes by Idempotency-Key", async () => {
    const key = { "idempotency-key": `create-${randomUUID()}` };
    const body = { type: "article", locale: "de", title: "Import aus dem Altsystem", siteIds: [siteId] };
    const first = await api(tokens.write, "POST", "/entries", body, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().entry).toMatchObject({ origin: "api", status: "draft" });
    const replay = await api(tokens.write, "POST", "/entries", body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json().entry.id).toBe(first.json().entry.id);
    expect(code(await api(tokens.write, "POST", "/entries", { ...body, title: "Anders" }, key))).toBe("IDEMPOTENCY_KEY_REUSED");
    const count = await run((tx) => tx.cmsEntry.count({ where: { projectId, id: first.json().entry.id } }));
    expect(count).toBe(1);

    const entryId = first.json().entry.id as string;
    const saved = await api(tokens.write, "PATCH", `/entries/${entryId}/draft`, { version: 1, body: doc(para("Text.")), excerpt: "Kurz." });
    expect(saved.statusCode, saved.body).toBe(200);
    const revision = await api(tokens.write, "POST", `/entries/${entryId}/revisions`, { changeNote: "Import" });
    expect(revision.statusCode, revision.body).toBe(201);
    const revisions = (await api(tokens.read, "GET", `/entries/${entryId}/revisions`)).json();
    expect(revisions.items).toHaveLength(1);
    expect((await api(tokens.read, "GET", `/entries/${entryId}/preflight`)).json()).toEqual({ ok: true, issues: [] });
    const translated = await api(tokens.write, "POST", `/entries/${entryId}/translations`, { locale: "en" });
    expect(translated.statusCode, translated.body).toBe(201);

    const term = await api(tokens.write, "POST", "/terms", { kind: "tag", locale: "de", name: "Import" });
    expect(term.statusCode, term.body).toBe(201);
    const author = await api(tokens.write, "POST", "/authors", { name: "Redaktion" });
    expect(author.statusCode, author.body).toBe(201);
    expect((await api(tokens.read, "GET", "/terms")).statusCode).toBe(200);
    expect((await api(tokens.read, "GET", "/authors")).statusCode).toBe(200);
  });

  it("uploads images as raw bytes; identical images are stored once", async () => {
    const upload = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/cms/assets",
        headers: { authorization: `Bearer ${tokens.write}`, "content-type": "application/octet-stream", "x-file-name": "familie.png", [CLIENT_IP_HEADER]: ip() },
        payload: PNG,
      });
    const first = await upload();
    expect(first.statusCode, first.body).toBe(201);
    const second = await upload();
    expect(second.statusCode).toBe(200);
    expect(second.json().asset.id).toBe(first.json().asset.id);
    const asset = first.json().asset;
    const alt = await api(tokens.write, "PATCH", `/assets/${asset.id}`, { version: asset.version, alt: { de: "Eine Familie" } });
    expect(alt.statusCode, alt.body).toBe(200);
    const refusedRead = await app.inject({
      method: "POST",
      url: "/api/v1/cms/assets",
      headers: { authorization: `Bearer ${tokens.read}`, "content-type": "application/octet-stream", [CLIENT_IP_HEADER]: ip() },
      payload: PNG,
    });
    expect(code(refusedRead)).toBe("API_KEY_SCOPE_MISSING");
    expect((await api(tokens.read, "GET", `/assets/${asset.id}`)).json()).toMatchObject({ alt: { de: "Eine Familie" } });
  });

  it("a key cannot change an author that live content shows", async () => {
    const shown = await api(tokens.write, "POST", "/authors", { name: "Live-Redaktion" });
    const unused = await api(tokens.write, "POST", "/authors", { name: "Ungenutzt" });
    expect(shown.statusCode, shown.body).toBe(201);
    const a = shown.json() as { id: string; version: number };
    const b = unused.json() as { id: string; version: number };
    const { entryId, draftVersion } = await draftEntry("Mit Autorin");
    const linked = await api(tokens.write, "PATCH", `/entries/${entryId}/draft`, { version: draftVersion, authorIds: [a.id] });
    expect(linked.statusCode, linked.body).toBe(200);
    const published = await member("POST", `/api/projects/${projectId}/cms/entries/${entryId}/publication-requests`, {
      draftVersion: linked.json().draft.version,
    });
    expect(published.statusCode, published.body).toBe(200);
    const refusedChange = await api(tokens.write, "PATCH", `/authors/${a.id}`, { version: a.version, bio: { de: "Neu" } });
    expect(refusedChange.statusCode).toBe(409);
    expect(code(refusedChange)).toBe("CMS_LIVE_REFERENCE");
    expect((await api(tokens.write, "PATCH", `/authors/${b.id}`, { version: b.version, name: "Noch ungenutzt" })).statusCode).toBe(200);
  });

  it("four-eyes keeps the member who created the key from approving its proposal", async () => {
    const status = (await member("GET", `/api/projects/${projectId}/cms/status`)).json();
    const set = (fourEyes: boolean, version: number) =>
      member("PUT", `/api/projects/${projectId}/cms/settings`, { version, settings: { ...status.settings, fourEyes } });
    const on = await set(true, status.settingsVersion);
    expect(on.statusCode, on.body).toBe(200);
    try {
      const key = await createApiKey(ownerScope(), { name: "four eyes", scopes: ["cms:manage.read", "cms:publish.propose"], confirmWrite: true });
      const { entryId, draftVersion } = await draftEntry("Vier Augen");
      const proposed = await api(key.token, "POST", `/entries/${entryId}/publication-requests`, { draftVersion });
      expect(proposed.statusCode, proposed.body).toBe(202);
      const requestId = proposed.json().requestId as string;
      const row = await run((tx) => tx.entity.findFirstOrThrow({ where: { id: requestId } }));
      expect((row.data as { payload: { accountableUserId?: string } }).payload.accountableUserId).toBe(ownerId);
      const decided = await member("POST", `/api/projects/${projectId}/action-requests/${requestId}/decide`, {
        version: row.version,
        packageHash: (row.data as { packageHash: string }).packageHash,
        decision: "approve",
      });
      expect(decided.statusCode).toBe(403);
      expect((await api(tokens.read, "GET", `/entries/${entryId}`)).json().entry.status).toBe("draft");
    } finally {
      const now = (await member("GET", `/api/projects/${projectId}/cms/status`)).json();
      expect((await set(false, now.settingsVersion)).statusCode).toBe(200);
    }
  });

  it("a key proposes; a person decides; a revoked key's proposal no longer executes", async () => {
    const { entryId, draftVersion } = await draftEntry("Vorschlag einer Integration");
    const proposed = await api(tokens.propose, "POST", `/entries/${entryId}/publication-requests`, { draftVersion });
    expect(proposed.statusCode, proposed.body).toBe(202);
    expect(proposed.json()).toMatchObject({ mode: "requested", entry: { status: "draft" } });
    const requestId = proposed.json().requestId as string;
    const request = await run((tx) => tx.entity.findFirstOrThrow({ where: { id: requestId } }));
    expect((request.data as { requestedBy: object }).requestedBy).toMatchObject({ kind: "api_key", keyId: proposeKeyId });
    const audits = await run((tx) => tx.auditEvent.findMany({ where: { projectId, action: "action_request.proposed", resourceId: requestId } }));
    expect(audits).toHaveLength(1);

    const decide = async (id: string) => {
      const row = await run((tx) => tx.entity.findFirstOrThrow({ where: { id } }));
      return member("POST", `/api/projects/${projectId}/action-requests/${id}/decide`, {
        version: row.version,
        packageHash: (row.data as { packageHash: string }).packageHash,
        decision: "approve",
      });
    };
    const approved = await decide(requestId);
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await api(tokens.read, "GET", `/entries/${entryId}`)).json().entry.status).toBe("published");

    // A second proposal, then the key is revoked: the approval is refused.
    const other = await draftEntry("Noch ein Vorschlag");
    const second = await api(tokens.propose, "POST", `/entries/${other.entryId}/publication-requests`, { draftVersion: other.draftVersion });
    expect(second.statusCode, second.body).toBe(202);
    await revokeApiKey(ownerScope(), proposeKeyId);
    const refused = await decide(second.json().requestId);
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe("API_KEY_ENDED");
    expect((await api(tokens.read, "GET", `/entries/${other.entryId}`)).json().entry.status).toBe("draft");
  });
});
