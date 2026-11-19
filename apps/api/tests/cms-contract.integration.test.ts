import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { createSite } from "../src/modules/cms/sites/sites.ts";
import { requestPublication } from "../src/modules/cms/publishing/approval.ts";
import {
  cancelOriginRequest,
  cmsAvailable,
  entryStatus,
  entryUrlMap,
  publishedEntries,
  requestOriginPublication,
  submitOriginDraft,
} from "../src/modules/cms/contract.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const doc = (text: string) => ({ schema: "orbit-doc", version: 1, blocks: [{ type: "paragraph", content: [{ text }] }] });

/**
 * The content module's interface for other modules (ADR 0029 §6, CH1.15):
 * drafts from an origin record are created once and updated by newer
 * versions; publication goes through the approval with the origin's
 * requester; reads give live entries and their URLs.
 */
describe.skipIf(!enabled)("content contract", () => {
  let workspaceId = "";
  let projectId = "";
  let ownerId = "";
  let siteId = "";
  const saved = process.env.ORBIT_CMS;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const owner = (): Scope => ({ workspaceId, projectId, userId: ownerId, role: "owner" });
  const agent = { kind: "agent" as const, userId: "", agentRunId: null };

  beforeAll(async () => {
    process.env.ORBIT_CMS = "true";
    ownerId = (
      await makeAuth().api.signUpEmail({
        body: { email: `${randomUUID()}@example.invalid`, name: "Synthetic cms contract", password: randomBytes(24).toString("base64url") },
      })
    ).user.id;
    agent.userId = ownerId;
    workspaceId = (await authDb.workspace.create({ data: { name: "Synthetic cms contract", members: { create: [{ userId: ownerId, role: "owner" }] } } })).id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms contract" } })).id;
    await run((tx) =>
      tx.projectModule.create({ data: { workspaceId, projectId, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ownerId } }),
    );
    siteId = (
      await run((tx) =>
        createSite(tx, owner(), { name: "Familie", baseUrl: "https://familie.example.invalid", locales: ["de"], defaultLocale: "de" }),
      )
    ).site.id;
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.ORBIT_CMS;
    else process.env.ORBIT_CMS = saved;
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: ownerId } });
    await closeDatabase();
  });

  it("creates a draft once per origin record and updates it with newer versions", async () => {
    const origin = { module: "marketing" as const, type: "blog_draft", id: randomUUID(), version: 1 };
    const first = await run((tx) =>
      submitOriginDraft(tx, owner(), { origin, locale: "de", title: "Aus Marketing", body: doc("Version eins"), siteIds: [siteId] }),
    );
    expect(first).toMatchObject({ created: true, deduplicated: false });
    const again = await run((tx) => submitOriginDraft(tx, owner(), { origin, locale: "de", title: "Aus Marketing", body: doc("Version eins") }));
    expect(again).toMatchObject({ entryId: first.entryId, created: false, deduplicated: true });
    const newer = await run((tx) =>
      submitOriginDraft(tx, owner(), { origin: { ...origin, version: 2 }, locale: "de", title: "Aus Marketing, neu", body: doc("Version zwei") }),
    );
    expect(newer).toMatchObject({ entryId: first.entryId, created: false, deduplicated: false });
    const entry = await run((tx) => tx.cmsEntry.findFirstOrThrow({ where: { id: first.entryId } }));
    expect(entry).toMatchObject({ origin: "marketing", originRef: { ...origin, version: 2 } });
    const draft = await run((tx) => tx.cmsDraft.findFirstOrThrow({ where: { entryId: first.entryId } }));
    expect(draft.title).toBe("Aus Marketing, neu");
    // A different locale for the same record is refused, not silently forked.
    await expect(
      run((tx) => submitOriginDraft(tx, owner(), { origin: { ...origin, version: 3 }, locale: "en", title: "X", body: doc("x") })),
    ).rejects.toMatchObject({ code: "CMS_ORIGIN_MISMATCH" });
  });

  it("an origin's publication waits for a decision; status, URLs and published entries follow", async () => {
    const origin = { module: "marketing" as const, type: "blog_draft", id: randomUUID(), version: 1 };
    const { entryId, draftVersion } = await run((tx) =>
      submitOriginDraft(tx, owner(), { origin, locale: "de", title: "Zur Freigabe", body: doc("Text"), siteIds: [siteId] }),
    );
    const asked = await run((tx) => requestOriginPublication(tx, owner(), entryId, { draftVersion }, agent));
    expect(asked).toMatchObject({ mode: "requested", status: "draft" });
    expect((await run((tx) => entryStatus(tx, owner(), [entryId])))[0]).toMatchObject({ status: "draft", pendingRequestId: asked.requestId, urls: [] });
    expect(await run((tx) => cancelOriginRequest(tx, owner(), entryId))).toEqual({ cancelled: true });
    expect(await run((tx) => cancelOriginRequest(tx, owner(), entryId))).toEqual({ cancelled: false });

    // The owner publishes it (directly, as a member).
    await run((tx) => requestPublication(tx, owner(), entryId, {}));
    const [status] = await run((tx) => entryStatus(tx, owner(), [entryId]));
    const slug = (await run((tx) => tx.cmsEntry.findFirstOrThrow({ where: { id: entryId } }))).slug;
    expect(status).toMatchObject({ status: "published", liveRevision: 1, pendingRequestId: null, urls: [{ siteId, url: `https://familie.example.invalid/blog/${slug}/` }] });
    const published = await run((tx) => publishedEntries(tx, owner(), { locale: "de" }));
    expect(published.find((p) => p.entryId === entryId)).toMatchObject({ title: "Zur Freigabe", revision: 1, urls: [{ siteId }] });
    expect((await run((tx) => publishedEntries(tx, owner(), { siteId }))).map((p) => p.entryId)).toContain(entryId);
    const map = await run((tx) => entryUrlMap(tx, owner(), siteId));
    expect(map.get(`https://familie.example.invalid/blog/${slug}/`)).toBe(entryId);
  });

  it("reports the module's availability; writes refuse while it is off", async () => {
    expect(await run((tx) => cmsAvailable(tx, owner()))).toBe(true);
    delete process.env.ORBIT_CMS;
    expect(await run((tx) => cmsAvailable(tx, owner()))).toBe(false);
    await expect(
      run((tx) =>
        submitOriginDraft(tx, owner(), { origin: { module: "marketing", type: "x_y", id: "1", version: 1 }, locale: "de", title: "x", body: doc("x") }),
      ),
    ).rejects.toMatchObject({ code: "CMS_DISABLED" });
  });
});
