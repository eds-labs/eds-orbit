import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * The content module's schema (ADR 0029, CH1.6) as the business role sees
 * it: insert-only revisions and attempts, published entries that can only be
 * archived, status consistent with the revision pointers, revisions bound to
 * their own entry, composite tenant keys, and a project deletion that still
 * removes everything.
 */
describe.skipIf(!enabled)("content module schema", () => {
  const ids = { owner: "", workspaceId: "", projectId: "", otherProjectId: "" };
  const doc = { schema: "orbit-doc", version: 1, blocks: [] };
  const inProject = <T>(work: (tx: DbTx) => Promise<T>, projectId = ids.projectId) => scoped(ids.workspaceId, projectId, work);
  const t = (projectId = ids.projectId) => ({ workspaceId: ids.workspaceId, projectId });

  async function entryWithRevision(projectId = ids.projectId) {
    const entryId = randomUUID();
    const revisionId = randomUUID();
    await inProject(async (tx) => {
      await tx.cmsEntry.create({
        data: { id: entryId, ...t(projectId), type: "article", locale: "de", translationGroupId: randomUUID(), slug: `e-${entryId.slice(0, 8)}`, createdBy: ids.owner },
      });
      await tx.cmsDraft.create({ data: { entryId, ...t(projectId), body: doc, updatedBy: ids.owner } });
      await tx.cmsRevision.create({
        data: {
          id: revisionId, ...t(projectId), entryId, number: 1, slug: "x", title: "T", excerpt: "", body: doc, fields: {}, seo: {},
          authorIds: [], termIds: [], contentHash: "a".repeat(64), bodyHash: "b".repeat(64), wordCount: 0, createdBy: ids.owner,
        },
      });
    }, projectId);
    return { entryId, revisionId };
  }
  const publish = (entryId: string, revisionId: string) =>
    inProject((tx) =>
      tx.cmsEntry.update({
        where: { id: entryId },
        data: { status: "published", publishedRevisionId: revisionId, firstPublishedAt: new Date(), lastPublishedAt: new Date() },
      }),
    );

  beforeAll(async () => {
    const user = await authDb.user.create({ data: { id: randomUUID(), email: `${randomUUID()}@example.invalid`, name: "Synthetic cms schema" } });
    ids.owner = user.id;
    const workspace = await authDb.workspace.create({ data: { name: "Synthetic cms schema", members: { create: [{ userId: user.id, role: "owner" }] } } });
    ids.workspaceId = workspace.id;
    ids.projectId = (await authDb.project.create({ data: { workspaceId: workspace.id, name: "A" } })).id;
    ids.otherProjectId = (await authDb.project.create({ data: { workspaceId: workspace.id, name: "B" } })).id;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: ids.workspaceId } });
    await authDb.user.deleteMany({ where: { id: ids.owner } });
    await closeDatabase();
  });

  it("keeps revisions and publication attempts unchanged", async () => {
    const { entryId, revisionId } = await entryWithRevision();
    await expect(inProject((tx) => tx.cmsRevision.update({ where: { id: revisionId }, data: { title: "changed" } }))).rejects.toThrow();
    await expect(inProject((tx) => tx.cmsRevision.delete({ where: { id: revisionId } }))).rejects.toThrow(/permission denied/);
    const siteId = randomUUID();
    const publicationId = randomUUID();
    await inProject(async (tx) => {
      await tx.cmsSite.create({ data: { id: siteId, ...t(), name: "S", baseUrl: "https://s.example.invalid", locales: ["de"], defaultLocale: "de", createdBy: ids.owner } });
      await tx.cmsPublication.create({
        data: { id: publicationId, ...t(), entryId, revisionId, siteId, action: "publish", idempotencyKey: "c".repeat(64), scheduledAt: new Date(), createdBy: ids.owner },
      });
      await tx.cmsPublicationAttempt.create({ data: { id: randomUUID(), ...t(), publicationId, step: "claim", outcome: "ok" } });
    });
    await expect(inProject((tx) => tx.cmsPublicationAttempt.updateMany({ where: { publicationId }, data: { outcome: "failed" } }))).rejects.toThrow();
    await expect(inProject((tx) => tx.cmsPublication.delete({ where: { id: publicationId } }))).rejects.toThrow(/permission denied/);
  });

  it("deletes a never-published entry but only archives a published one", async () => {
    const draft = await entryWithRevision();
    await inProject((tx) => tx.cmsEntry.delete({ where: { id: draft.entryId } }));
    expect(await inProject((tx) => tx.cmsRevision.count({ where: { entryId: draft.entryId } }))).toBe(0);

    const live = await entryWithRevision();
    await publish(live.entryId, live.revisionId);
    await expect(inProject((tx) => tx.cmsEntry.delete({ where: { id: live.entryId } }))).rejects.toThrow(/CMS_ENTRY_WAS_PUBLISHED/);
    await inProject((tx) =>
      tx.cmsEntry.update({ where: { id: live.entryId }, data: { status: "archived", publishedRevisionId: null, archivedAt: new Date() } }),
    );
  });

  it("keeps the status consistent with the revision pointers", async () => {
    const { entryId, revisionId } = await entryWithRevision();
    for (const data of [
      { status: "published" },
      { status: "scheduled", scheduledRevisionId: revisionId },
      { status: "archived" },
      { status: "draft", publishedRevisionId: revisionId, firstPublishedAt: new Date(), lastPublishedAt: new Date() },
      { status: "published", publishedRevisionId: revisionId },
      { status: "unknown" },
    ]) {
      await expect(inProject((tx) => tx.cmsEntry.update({ where: { id: entryId }, data })), JSON.stringify(data)).rejects.toThrow();
    }
    await inProject((tx) =>
      tx.cmsEntry.update({ where: { id: entryId }, data: { status: "scheduled", scheduledRevisionId: revisionId, scheduledAt: new Date() } }),
    );
  });

  it("points an entry only at its own revisions and keeps projects apart", async () => {
    const a = await entryWithRevision();
    const b = await entryWithRevision();
    await expect(publish(a.entryId, b.revisionId)).rejects.toThrow();
    // A draft in project B cannot reference an entry of project A.
    await expect(
      inProject((tx) => tx.cmsDraft.create({ data: { entryId: a.entryId, ...t(ids.otherProjectId), body: doc, updatedBy: ids.owner } }), ids.otherProjectId),
    ).rejects.toThrow();
  });

  it("checks slugs, locales, bodies, assets and redirects", async () => {
    const base = { ...t(), type: "article", translationGroupId: randomUUID(), createdBy: ids.owner };
    for (const data of [
      { ...base, id: randomUUID(), locale: "de", slug: "Has Spaces" },
      { ...base, id: randomUUID(), locale: "deutsch", slug: "ok" },
      { ...base, id: randomUUID(), locale: "de", slug: "ok", origin: "somewhere" },
    ]) {
      await expect(inProject((tx) => tx.cmsEntry.create({ data })), JSON.stringify(data)).rejects.toThrow();
    }
    const { entryId } = await entryWithRevision();
    await expect(
      inProject((tx) => tx.cmsDraft.update({ where: { entryId }, data: { body: { html: "<script>" } } })),
    ).rejects.toThrow();
    await expect(
      inProject((tx) =>
        tx.cmsAsset.create({
          data: { id: randomUUID(), ...t(), fileId: randomUUID(), mime: "image/svg+xml", width: 1, height: 1, bytes: 1, sha256: "d".repeat(64), createdBy: ids.owner },
        }),
      ),
    ).rejects.toThrow();
    const siteId = randomUUID();
    await inProject((tx) =>
      tx.cmsSite.create({ data: { id: siteId, ...t(), name: "R", baseUrl: "https://r.example.invalid", locales: ["de", "en"], defaultLocale: "de", createdBy: ids.owner } }),
    );
    const redirect = (data: Record<string, unknown>) =>
      inProject((tx) => tx.cmsRedirect.create({ data: { id: randomUUID(), ...t(), siteId, reason: "manual", createdBy: ids.owner, fromPath: "/a/", code: 301, ...data } }));
    await expect(redirect({ code: 410, toPath: "/b/" })).rejects.toThrow();
    await expect(redirect({ toPath: "https://evil.example/" })).rejects.toThrow();
    await expect(redirect({})).rejects.toThrow();
    await redirect({ toPath: "/b/" });
    await expect(redirect({ toPath: "/c/" })).rejects.toThrow();
    await expect(
      inProject((tx) =>
        tx.cmsSite.create({ data: { id: randomUUID(), ...t(), name: "X", baseUrl: "https://x.example.invalid", locales: ["de"], defaultLocale: "en", createdBy: ids.owner } }),
      ),
    ).rejects.toThrow();
  });

  it("removes everything with its project, published entries included", async () => {
    const projectId = (await authDb.project.create({ data: { workspaceId: ids.workspaceId, name: "Doomed" } })).id;
    const { entryId, revisionId } = await entryWithRevision(projectId);
    await inProject(
      (tx) =>
        tx.cmsEntry.update({
          where: { id: entryId },
          data: { status: "published", publishedRevisionId: revisionId, firstPublishedAt: new Date(), lastPublishedAt: new Date() },
        }),
      projectId,
    );
    await authDb.project.delete({ where: { id: projectId } });
    expect(await inProject((tx) => tx.cmsEntry.count(), projectId)).toBe(0);
    expect(await inProject((tx) => tx.cmsRevision.count(), projectId)).toBe(0);
  });
});
