import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { sourceSyncScheduler } from "../src/platform/knowledge/source-sync.ts";
import {
  SITE_BATCH,
  runSiteBatch,
  startSiteRun,
} from "../src/platform/knowledge/site-run.ts";
import { ZodError } from "zod";
import { createPackageProject } from "./support/package-project.ts";
import { knowledgeActions } from "../src/modules/knowledge/actions.ts";
import { knowledgeActionPermissions } from "../src/modules/knowledge/permissions.ts";
import { can } from "../src/platform/tenancy/permissions.ts";

// No live site and no paid model: every fetch below is stubbed.
const web = vi.hoisted(() => ({
  pages: new Map<string, string>(),
  sitemap: null as string[] | null,
  // A sitemap index: child URL to its pages, or null when the child fails.
  children: null as Record<string, string[] | null> | null,
  down: new Set<string>(),
  fetched: [] as string[],
  dieAt: null as string | null,
  killNextTransaction: false,
  whileFetching: null as null | ((page: string) => Promise<void>),
  transactions: 0,
  fetchedInsideTransaction: false,
}));

vi.mock("../../../packages/knowledge/src/index.ts", async (original) => {
  const knowledge =
    await original<typeof import("../../../packages/knowledge/src/index.ts")>();
  const noted = () => {
    if (web.transactions > 0) web.fetchedInsideTransaction = true;
  };
  return {
    ...knowledge,
    fetchApprovedDocument: vi.fn(async (url: string) => {
      noted();
      const page = url.replace(/\.md$/, "");
      if (url.endsWith(".md")) web.fetched.push(page);
      if (web.whileFetching) await web.whileFetching(page);
      if (page === web.dieAt) {
        if (!url.endsWith(".md")) {
          web.dieAt = null;
          web.killNextTransaction = true;
        }
        throw new knowledge.KnowledgeError("FETCH_FAILED");
      }
      const body = web.pages.get(page);
      if (body === undefined || web.down.has(page))
        throw new knowledge.KnowledgeError("FETCH_FAILED");
      return { bytes: Buffer.from(body), mimeType: knowledge.MIME.md, url };
    }),
    fetchDiscoveryDocument: vi.fn(async (url: string) => {
      noted();
      const reply = (body: string) => ({
        bytes: Buffer.from(body),
        mimeType: "application/xml",
        url,
      });
      const urlset = (urls: string[]) =>
        `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
      if (web.children) {
        if (url.endsWith("/help/sitemap.xml")) {
          const items = Object.keys(web.children)
            .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
            .join("");
          return reply(`<sitemapindex>${items}</sitemapindex>`);
        }
        const child = web.children[url];
        if (!child) throw new knowledge.KnowledgeError("SOURCE_FETCH_FAILED");
        return reply(urlset(child));
      }
      if (!web.sitemap) throw new knowledge.KnowledgeError("SOURCE_NOT_FOUND");
      return reply(urlset(web.sitemap));
    }),
  };
});
// `killNextTransaction` stands in for a worker that dies between two steps.
vi.mock("../../../packages/db/src/index.ts", async (original) => {
  const db =
    await original<typeof import("../../../packages/db/src/index.ts")>();
  return {
    ...db,
    scoped: async (...args: Parameters<typeof db.scoped>) => {
      if (web.killNextTransaction) {
        web.killNextTransaction = false;
        throw new Error("WORKER_DIED");
      }
      web.transactions++;
      try {
        return await db.scoped(...args);
      } finally {
        web.transactions--;
      }
    },
  };
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const ROOT = "https://docs.example.com/help";
const QUEUE = "knowledge_site_sync";
const KIND = "knowledge_site_runs";
const HOUR = 3600000;
const page = (n: number) => `${ROOT}/de/page-${n}`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const sitePages = (numbers: number[]) =>
  numbers.map((n) => ({ url: page(n), language: "de" }));
function publish(...numbers: number[]) {
  for (const n of numbers)
    web.pages.set(page(n), `# Seite ${n}\n\nInhalt von Seite ${n}.`);
  web.sitemap = numbers.map(page);
}

describe.skipIf(!enabled)("Knowledge site run", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let owner: Scope;
  let worker: Scope;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);

  const siteSource = (extra: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, owner, "sources", {
        name: "Help",
        type: "gitbook",
        status: "active",
        generation: 1,
        publicUse: false,
        modelUse: true,
        authority: "official",
        maxAgeHours: 336,
        allowedOrigins: ["https://docs.example.com"],
        allowedPaths: ["/help"],
        syncEveryHours: 168,
        language: "de",
        site: {
          rootUrl: ROOT,
          discovery: "sitemap",
          excludedPages: [],
          lastRunId: null,
        },
        ...extra,
      }),
    );
  const changeSource = (
    id: string,
    change: (d: Record<string, any>) => Record<string, any>,
  ) =>
    run(async (tx) => {
      const row = await entity(tx, owner, "sources", id);
      await update(tx, owner, row, change(data(row)));
    });
  const exclude = (id: string, ...urls: string[]) =>
    changeSource(id, (d) => ({
      ...d,
      site: { ...d.site, excludedPages: urls },
    }));
  const start = (
    sourceId: string,
    trigger: "initial" | "manual" | "schedule",
    pages: { url: string; language: string }[] = [],
  ) => run((tx) => startSiteRun(tx, owner, sourceId, trigger, pages));
  const state = (runId: string) =>
    run(async (tx) => data(await entity(tx, owner, KIND, runId)));
  const siteJobs = (runId: string) =>
    run(async (tx) =>
      (await list(tx, owner, "jobs"))
        .filter((j) => data(j).topic === QUEUE && data(j).resourceId === runId)
        .map((j) => ({ id: j.id, ...data(j) }) as Record<string, any>),
    );
  const jobKeys = async (runId: string) =>
    (await siteJobs(runId)).map((j) => j.idempotencyKey).sort();
  const batch = async (runId: string, cursor = 0) => {
    const job = (await siteJobs(runId)).find(
      (j) => j.idempotencyKey === `site:${runId}:${cursor}`,
    );
    if (!job) throw new Error(`no job at cursor ${cursor}`);
    await runSiteBatch(worker, runId, job.id);
  };
  async function drain(runId: string) {
    for (let i = 0; i < 20; i++) {
      const r = await state(runId);
      if (r.status !== "queued" && r.status !== "running") return r;
      await batch(runId, r.cursor);
    }
    throw new Error("run did not finish");
  }
  const read = async (sourceId: string, numbers: number[]) =>
    drain((await start(sourceId, "initial", sitePages(numbers))).id);
  const refresh = async (sourceId: string) =>
    drain((await start(sourceId, "manual")).id);
  const documents = (sourceId: string) =>
    run((tx) => tx.knowledgeDocument.findMany({ where: { sourceId } }));
  const live = async (sourceId: string) =>
    (await documents(sourceId)).filter((d) => d.activeVersionId);
  const documentFor = async (sourceId: string, n: number) =>
    (await documents(sourceId)).find((d) => d.externalId === page(n))!;
  const runAudits = () =>
    run(async (tx) =>
      (
        await tx.auditEvent.findMany({
          where: {
            projectId: owner.projectId,
            action: { startsWith: "knowledge.site_run" },
          },
        })
      ).map((a) => ({
        action: a.action,
        resourceId: a.resourceId,
        metadata: a.metadata,
      })),
    );
  const fetchCount = (url: string) =>
    web.fetched.filter((u) => u === url).length;

  beforeEach(async () => {
    web.pages.clear();
    web.sitemap = null;
    web.children = null;
    web.down.clear();
    web.fetched.length = 0;
    web.dieAt = null;
    web.killNextTransaction = false;
    web.whileFetching = null;
    web.fetchedInsideTransaction = false;
    project = await createPackageProject({ name: "Synthetic site run" });
    owner = project.owner;
    worker = { ...owner, userId: "worker" };
  });
  afterEach(async () => {
    expect(web.fetchedInsideTransaction).toBe(false);
    await project?.cleanup();
  });
  afterAll(() => closeDatabase());

  it("reads a site in batches and enqueues the next one", async () => {
    const numbers = range(SITE_BATCH + 5);
    publish(...numbers);
    const source = await siteSource();
    const pages = sitePages(numbers);
    pages[1]!.language = "en";
    const created = await start(source.id, "initial", pages);
    expect(data(created)).toMatchObject({
      sourceId: source.id,
      trigger: "initial",
      generation: 1,
      status: "queued",
      pages: numbers.map(page),
      cursor: 0,
      errorCode: null,
      warning: null,
      completedAt: null,
    });
    const sourceAfter = await run((tx) =>
      entity(tx, owner, "sources", source.id),
    );
    expect(data(sourceAfter).site.lastRunId).toBe(created.id);

    await batch(created.id);
    expect(await state(created.id)).toMatchObject({
      status: "running",
      cursor: SITE_BATCH,
      added: SITE_BATCH,
    });
    expect(await documents(source.id)).toHaveLength(SITE_BATCH);
    expect(await jobKeys(created.id)).toEqual([
      `site:${created.id}:0`,
      `site:${created.id}:${SITE_BATCH}`,
    ]);
    const next = (await siteJobs(created.id)).find(
      (j) => j.idempotencyKey === `site:${created.id}:${SITE_BATCH}`,
    )!;
    expect(
      await run((tx) =>
        tx.outbox.count({ where: { topic: QUEUE, entityId: next.id } }),
      ),
    ).toBe(1);

    await batch(created.id, SITE_BATCH);
    const done = await state(created.id);
    expect(done).toMatchObject({
      status: "completed",
      cursor: SITE_BATCH + 5,
      added: SITE_BATCH + 5,
      removed: 0,
    });
    expect(Date.parse(done.completedAt)).toBeGreaterThan(0);
    expect(await siteJobs(created.id)).toHaveLength(2);

    const doc = await documentFor(source.id, 1);
    expect(doc).toMatchObject({ externalId: page(1), canonicalUrl: page(1) });
    const version = await run((tx) =>
      tx.documentVersion.findFirstOrThrow({
        where: { id: doc.activeVersionId! },
      }),
    );
    expect(version).toMatchObject({ title: "Seite 1", language: "en" });

    // One record for the finished run: ids, trigger and counts, no content.
    expect(await runAudits()).toEqual([
      {
        action: "knowledge.site_run_completed",
        resourceId: created.id,
        metadata: {
          sourceId: source.id,
          trigger: "initial",
          pages: SITE_BATCH + 5,
          unchanged: 0,
          changed: 0,
          added: SITE_BATCH + 5,
          removed: 0,
          failed: 0,
          skippedSensitive: 0,
          embeddingsQueued: done.embeddingsQueued,
        },
      },
    ]);
  });

  it("counts unchanged, changed and added pages", async () => {
    publish(0, 1, 2);
    const source = await siteSource();
    await read(source.id, [0, 1, 2]);
    publish(0, 1, 2, 3);
    web.pages.set(page(1), "# Seite 1\n\nNeuer Inhalt.");
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      unchanged: 2,
      changed: 1,
      added: 1,
      removed: 0,
      pages: [0, 1, 2, 3].map(page),
      languages: ["de", "de", "de", "de"],
    });
  });

  it("retires a page no longer listed", async () => {
    publish(0, 1, 2);
    const source = await siteSource();
    await read(source.id, [0, 1, 2]);
    web.sitemap = [0, 1].map(page);
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      removed: 1,
      warning: null,
    });
    expect((await documentFor(source.id, 2)).activeVersionId).toBeNull();
    expect(await live(source.id)).toHaveLength(2);

    // A page that comes back is read as a new version; no tombstone blocks it.
    web.sitemap = [0, 1, 2].map(page);
    expect(await refresh(source.id)).toMatchObject({ added: 1, removed: 0 });
    expect(await live(source.id)).toHaveLength(3);
  });

  it("does not retire when discovery is empty or would remove more than half, and sets site_shrank", async () => {
    publish(0, 1, 2, 3);
    const source = await siteSource();
    await read(source.id, [0, 1, 2, 3]);

    // No usable sitemap: discovery falls back to the root page only.
    web.pages.set(ROOT, "# Hilfe\n\nStartseite.");
    web.sitemap = null;
    await exclude(source.id, page(0));
    const empty = await refresh(source.id);
    expect(empty).toMatchObject({
      status: "completed",
      warning: "site_shrank",
      removed: 0,
      pages: [ROOT],
    });
    expect((await live(source.id)).length).toBe(5);
    await exclude(source.id);

    // Three of five live documents missing is more than half.
    web.pages.delete(ROOT);
    web.sitemap = [0, 1].map(page);
    await exclude(source.id, page(1));
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      warning: "site_shrank",
      removed: 0,
    });
    expect(await live(source.id)).toHaveLength(5);
  });

  it("treats a vanished sitemap as discovery returning nothing, however small the site", async () => {
    publish(0);
    web.pages.set(ROOT, "# Hilfe\n\nStartseite.");
    const source = await siteSource();
    await drain(
      (
        await start(source.id, "initial", [
          { url: ROOT, language: "de" },
          ...sitePages([0]),
        ])
      ).id,
    );
    // One of two pages missing would pass the half rule on its own.
    web.sitemap = null;
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      warning: "site_shrank",
      removed: 0,
      unchanged: 1,
    });
    expect(await live(source.id)).toHaveLength(2);
  });

  it("retires nothing when one child sitemap fails", async () => {
    publish(0, 1, 2, 3);
    const source = await siteSource();
    await read(source.id, [0, 1, 2, 3]);
    // Two of four is not more than half: only the failed child protects them.
    web.children = {
      [`${ROOT}/sitemap-de.xml`]: [0, 1].map(page),
      [`${ROOT}/sitemap-en.xml`]: null,
    };
    await exclude(source.id, page(1));
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      warning: "site_shrank",
      removed: 0,
      unchanged: 1,
      pages: [0, 1].map(page),
    });
    expect(await live(source.id)).toHaveLength(4);
  });

  it("keeps pages past the 200-page cut and still retires exclusions", async () => {
    publish(0, 1, 500);
    const source = await siteSource();
    await read(source.id, [0, 1, 500]);
    // Page 500 is still listed, but behind the first 200 entries.
    web.sitemap = [...range(201), 500].map(page);
    await exclude(source.id, ...range(200).slice(1).map(page));
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      capped: true,
      warning: null,
      unchanged: 1,
      removed: 1,
    });
    expect((await documentFor(source.id, 500)).activeVersionId).not.toBeNull();
    expect((await documentFor(source.id, 1)).activeVersionId).toBeNull();
  });

  it("removes exactly half and leaves owner exclusions out of the half", async () => {
    publish(0, 1, 2, 3);
    const half = await siteSource();
    await read(half.id, [0, 1, 2, 3]);
    web.sitemap = [0, 1].map(page);
    expect(await refresh(half.id)).toMatchObject({ removed: 2, warning: null });

    publish(0, 1, 2, 3);
    const excluded = await siteSource();
    await read(excluded.id, [0, 1, 2, 3]);
    await exclude(excluded.id, page(0), page(1), page(2));
    expect(await refresh(excluded.id)).toMatchObject({
      removed: 3,
      warning: null,
      unchanged: 1,
    });
    expect(await live(excluded.id)).toHaveLength(1);
  });

  it("keeps the last version of a failing page and lists it", async () => {
    publish(0, 1, 2);
    const source = await siteSource();
    await read(source.id, [0, 1, 2]);
    const before = (await documentFor(source.id, 1)).activeVersionId;
    web.down.add(page(1));
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      errorCode: null,
      unchanged: 2,
      changed: 0,
      removed: 0,
      cursor: 3,
      failed: [{ url: page(1), code: "FETCH_FAILED" }],
    });
    expect((await documentFor(source.id, 1)).activeVersionId).toBe(before);
  });

  it("lists only the first 50 failures", async () => {
    const numbers = range(55);
    publish(...numbers);
    for (const n of numbers) web.down.add(page(n));
    const source = await siteSource();
    const done = await read(source.id, numbers);
    expect(done.failed).toHaveLength(50);
    expect(done.failed[49]).toEqual({ url: page(49), code: "FETCH_FAILED" });
    expect(done).toMatchObject({ status: "completed", cursor: 55 });
  });

  it("lists a page too long for ingest as failed and continues", async () => {
    publish(0, 1);
    web.pages.set(
      page(0),
      `# Lang\n\n${`${"x ".repeat(1300)}\n\n`.repeat(600)}`,
    );
    const source = await siteSource();
    expect(await read(source.id, [0, 1])).toMatchObject({
      status: "completed",
      added: 1,
      failed: [{ url: page(0), code: "TOO_MANY_CHUNKS" }],
    });
    expect(await documents(source.id)).toHaveLength(1);
  });

  it("skips and counts a page with credentials", async () => {
    publish(0, 1);
    const source = await siteSource();
    await read(source.id, [0, 1]);
    const before = (await documentFor(source.id, 0)).activeVersionId;
    web.pages.set(page(0), `# Geheim\n\npassword: "correct-horse-battery"`);
    expect(await refresh(source.id)).toMatchObject({
      status: "completed",
      skippedSensitive: 1,
      unchanged: 1,
      changed: 0,
      failed: [],
      removed: 0,
    });
    expect((await documentFor(source.id, 0)).activeVersionId).toBe(before);
  });

  it.each([
    ["paused", { status: "paused" }],
    ["at a new generation", { generation: 2 }],
  ])(
    "stops when the source is paused or its generation changed: %s",
    async (_name, change) => {
      const numbers = range(SITE_BATCH + 2);
      publish(...numbers);
      const source = await siteSource();
      const created = await start(source.id, "initial", sitePages(numbers));
      await batch(created.id);
      await changeSource(source.id, (d) => ({ ...d, ...change }));
      await batch(created.id, SITE_BATCH);
      expect(await state(created.id)).toMatchObject({
        status: "failed",
        errorCode: "SOURCE_INACTIVE",
        cursor: SITE_BATCH,
      });
      expect(await documents(source.id)).toHaveLength(SITE_BATCH);
      expect(await siteJobs(created.id)).toHaveLength(2);
      expect(await runAudits()).toMatchObject([
        {
          action: "knowledge.site_run_failed",
          resourceId: created.id,
          metadata: {
            sourceId: source.id,
            trigger: "initial",
            added: SITE_BATCH,
          },
        },
      ]);
    },
  );

  it("skips a page excluded during the run", async () => {
    const numbers = range(SITE_BATCH + 3);
    publish(...numbers);
    const source = await siteSource();
    const created = await start(source.id, "initial", sitePages(numbers));
    await batch(created.id);
    await exclude(source.id, page(SITE_BATCH + 1));
    await batch(created.id, SITE_BATCH);
    expect(await state(created.id)).toMatchObject({
      status: "completed",
      cursor: SITE_BATCH + 3,
      added: SITE_BATCH + 2,
      removed: 0,
    });
    expect(fetchCount(page(SITE_BATCH + 1))).toBe(0);
    expect(await documentFor(source.id, SITE_BATCH + 1)).toBeUndefined();
  });

  it("retires a page that was excluded after being read", async () => {
    const numbers = range(SITE_BATCH + 1);
    publish(...numbers);
    const source = await siteSource();
    const created = await start(source.id, "initial", sitePages(numbers));
    await batch(created.id);
    await exclude(source.id, page(3));
    await batch(created.id, SITE_BATCH);
    expect(await state(created.id)).toMatchObject({
      status: "completed",
      removed: 1,
    });
    expect((await documentFor(source.id, 3)).activeVersionId).toBeNull();
  });

  it("returns the active run on a second start", async () => {
    publish(0);
    const source = await siteSource();
    const [first, second] = await Promise.all([
      start(source.id, "initial", sitePages([0])),
      start(source.id, "manual"),
    ]);
    expect(second!.id).toBe(first!.id);
    expect(await run((tx) => list(tx, owner, KIND))).toHaveLength(1);
    expect(await siteJobs(first!.id)).toHaveLength(1);
    await drain(first!.id);
    expect((await start(source.id, "manual")).id).not.toBe(first!.id);
  });

  it("repeating a batch creates no duplicate documents, jobs or counters", async () => {
    const numbers = range(SITE_BATCH + 1);
    publish(...numbers);
    const source = await siteSource();
    const created = await start(source.id, "initial", sitePages(numbers));

    // Page 7 fails, then the worker dies before it could record that.
    web.dieAt = page(7);
    await expect(batch(created.id)).rejects.toThrow("WORKER_DIED");
    expect(await state(created.id)).toMatchObject({
      cursor: 7,
      added: 7,
      failed: [],
    });

    await batch(created.id);
    const once = await state(created.id);
    expect(once).toMatchObject({
      status: "running",
      cursor: SITE_BATCH,
      added: SITE_BATCH,
      failed: [],
    });
    expect(fetchCount(page(0))).toBe(1);
    expect(fetchCount(page(8))).toBe(1);
    expect(await documents(source.id)).toHaveLength(SITE_BATCH);

    // A late duplicate of the finished batch must not start the next one.
    const seen = web.fetched.length;
    await batch(created.id);
    expect(await state(created.id)).toEqual(once);
    expect(web.fetched).toHaveLength(seen);
    expect(await jobKeys(created.id)).toEqual([
      `site:${created.id}:0`,
      `site:${created.id}:${SITE_BATCH}`,
    ]);

    await batch(created.id, SITE_BATCH);
    const done = await state(created.id);
    expect(done).toMatchObject({ status: "completed", added: SITE_BATCH + 1 });
    await batch(created.id, SITE_BATCH);
    expect(await state(created.id)).toEqual(done);
  });

  it("counts a page once when a second delivery overtakes the first", async () => {
    const numbers = range(SITE_BATCH + 1);
    publish(...numbers);
    const source = await siteSource();
    const created = await start(source.id, "initial", sitePages(numbers));
    // While the first delivery fetches page 3, a retry after an expired lease
    // finishes the whole batch; the first must then stop without counting.
    web.whileFetching = async (url) => {
      if (url !== page(3)) return;
      web.whileFetching = null;
      await batch(created.id);
    };
    await batch(created.id);
    expect(await state(created.id)).toMatchObject({
      status: "running",
      cursor: SITE_BATCH,
      added: SITE_BATCH,
      unchanged: 0,
      failed: [],
    });
    expect(await documents(source.id)).toHaveLength(SITE_BATCH);
    const overtaken = await documentFor(source.id, 3);
    expect(
      await run((tx) =>
        tx.documentVersion.count({ where: { documentId: overtaken.id } }),
      ),
    ).toBe(1);
  });

  it("queues embeddings only when the source allows model use and index, key and authority exist", async () => {
    const embeddingJobs = async (sourceId: string) => {
      const ids = (await documents(sourceId)).map((d) => d.id);
      return run(async (tx) =>
        (await list(tx, owner, "jobs")).filter(
          (j) =>
            data(j).topic === "embedding" && ids.includes(data(j).resourceId),
        ),
      );
    };
    const readOne = async (extra: Record<string, unknown> = {}) => {
      publish(0);
      const source = await siteSource(extra);
      return { source, done: await read(source.id, [0]) };
    };
    const editEntity = (
      kind: string,
      change: (d: Record<string, any>) => Record<string, any>,
    ) =>
      run(async (tx) => {
        const row = await tx.entity.findFirstOrThrow({
          where: { projectId: owner.projectId, kind },
        });
        const before = data(row);
        await tx.entity.update({
          where: { id: row.id },
          data: { data: change(before) },
        });
        return async () => {
          await run((t) =>
            t.entity.update({ where: { id: row.id }, data: { data: before } }),
          );
        };
      });

    const ready = await readOne();
    expect(ready.done).toMatchObject({ added: 1, embeddingsQueued: 1 });
    expect(await embeddingJobs(ready.source.id)).toHaveLength(1);
    // An unchanged page queues nothing.
    web.sitemap = [page(0)];
    expect(await refresh(ready.source.id)).toMatchObject({
      unchanged: 1,
      embeddingsQueued: 0,
    });
    expect(await embeddingJobs(ready.source.id)).toHaveLength(1);

    const expectNone = async (extra?: Record<string, unknown>) => {
      const { source, done } = await readOne(extra);
      expect(done).toMatchObject({
        status: "completed",
        added: 1,
        embeddingsQueued: 0,
        failed: [],
      });
      expect(await embeddingJobs(source.id)).toHaveLength(0);
    };
    await expectNone({ modelUse: false });

    const withKey = await editEntity("openai_configuration", (d) => {
      const { encryptedApiKey: _key, ...rest } = d;
      return rest;
    });
    await expectNone();
    await withKey();

    const withAuthority = await editEntity("policies", (d) => ({
      ...d,
      active: false,
    }));
    await expectNone();
    await withAuthority();

    const inWindow = await editEntity("policies", (d) => ({
      ...d,
      endAt: new Date(Date.now() - HOUR).toISOString(),
    }));
    await expectNone();
    await inWindow();

    await run((tx) =>
      tx.chunkEmbedding.deleteMany({ where: { projectId: owner.projectId } }),
    );
    await expectNone();
  });

  it("schedules a run for a site source past its interval", async () => {
    publish(0);
    const startedAt = new Date(Date.now() - 169 * HOUR).toISOString();
    const source = await siteSource();
    const old = await run((tx) =>
      create(tx, owner, KIND, {
        sourceId: source.id,
        status: "completed",
        startedAt,
      }),
    );
    await changeSource(source.id, (d) => ({
      ...d,
      site: { ...d.site, lastRunId: old.id },
    }));

    const at = new Date();
    expect(
      await run((tx) => sourceSyncScheduler.sweep(tx, worker, at)),
    ).toEqual({
      queued: 1,
    });
    // A run started by the sweep discovers its pages in its own first batch.
    const started = (await run((tx) => list(tx, owner, KIND))).find(
      (r) => r.id !== old.id,
    )!;
    expect(data(started)).toMatchObject({
      trigger: "schedule",
      status: "queued",
      pages: [],
    });
    expect(await jobKeys(started.id)).toEqual([`site:${started.id}:0`]);
    expect(
      await run((tx) => sourceSyncScheduler.sweep(tx, worker, at)),
    ).toEqual({
      queued: 0,
    });

    expect(await drain(started.id)).toMatchObject({
      status: "completed",
      added: 1,
      pages: [page(0)],
    });
    expect(
      await run((tx) => sourceSyncScheduler.sweep(tx, worker, at)),
    ).toEqual({
      queued: 0,
    });
    const next = await run((tx) =>
      sourceSyncScheduler.nextDueAt(tx, worker, at),
    );
    expect(next!.valueOf()).toBe(
      Date.parse(data(started).startedAt) + 168 * HOUR,
    );
  });

  it("does not schedule with weekly updates off", async () => {
    await siteSource({ syncEveryHours: undefined });
    const at = new Date();
    expect(
      await run((tx) => sourceSyncScheduler.sweep(tx, worker, at)),
    ).toEqual({
      queued: 0,
    });
    expect(
      await run((tx) => sourceSyncScheduler.nextDueAt(tx, worker, at)),
    ).toBeNull();
    expect(await run((tx) => list(tx, owner, KIND))).toHaveLength(0);
  });

  it("leaves a source with syncEveryHours but no site on today's behaviour", async () => {
    const source = await siteSource({
      site: undefined,
      syncEveryHours: 1,
      lastSuccessfulSyncAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    await run((tx) =>
      create(tx, owner, "sync_requests", {
        sourceId: source.id,
        url: page(0),
        expectedGeneration: 1,
      }),
    );
    expect(
      await run((tx) => sourceSyncScheduler.sweep(tx, worker, new Date())),
    ).toEqual({ queued: 1 });
    expect(await run((tx) => list(tx, owner, KIND))).toHaveLength(0);
    const jobs = await run((tx) => list(tx, owner, "jobs"));
    expect(jobs.map((j) => data(j).topic)).toEqual(["ingestion"]);
  });

  it("registers its queue class with the agreed lease and fails a run its job can no longer serve", async () => {
    const def = registeredJobs().get(QUEUE)!;
    expect(def).toMatchObject({ concurrency: 1, leaseMs: 300000 });

    publish(0);
    const paused = await siteSource();
    const blocked = await start(paused.id, "initial", sitePages([0]));
    await run((tx) =>
      def.onBlockedByPause!(tx, { resourceId: blocked.id }, owner),
    );
    expect(await state(blocked.id)).toMatchObject({
      status: "failed",
      errorCode: "PROJECT_PAUSED",
    });

    const crashed = await siteSource();
    const expired = await start(crashed.id, "initial", sitePages([0]));
    await run((tx) =>
      def.onLeaseExpired!(tx, owner, {
        resourceId: expired.id,
        attempts: 1,
        maxAttempts: 3,
      }),
    );
    expect(await state(expired.id)).toMatchObject({ status: "queued" });
    await run((tx) =>
      def.onLeaseExpired!(tx, owner, {
        resourceId: expired.id,
        attempts: 3,
        maxAttempts: 3,
      }),
    );
    expect(await state(expired.id)).toMatchObject({
      status: "failed",
      errorCode: "JOB_OUTCOME_UNKNOWN",
    });
  });

  it("fails the run with an error of its own only on the job's last attempt", async () => {
    const source = await siteSource({
      site: {
        rootUrl: "not a url",
        discovery: "sitemap",
        excludedPages: [],
        lastRunId: null,
      },
    });
    const created = await start(source.id, "manual");
    await expect(batch(created.id)).rejects.toThrow();
    expect(await state(created.id)).toMatchObject({
      status: "queued",
      errorCode: null,
    });

    const [job] = await siteJobs(created.id);
    await run(async (tx) => {
      const row = await entity(tx, owner, "jobs", job!.id);
      await update(tx, owner, row, {
        ...data(row),
        attempts: data(row).maxAttempts,
      });
    });
    await expect(batch(created.id)).rejects.toThrow();
    expect(await state(created.id)).toMatchObject({
      status: "failed",
      errorCode: "ERR_INVALID_URL",
    });
  });

  describe("site actions", () => {
    const NAMES = [
      "knowledge-site-discover",
      "knowledge-site-start",
      "knowledge-site-refresh",
      "knowledge-site-settings",
    ] as const;
    let flag: string | undefined;
    beforeEach(() => {
      flag = process.env.ORBIT_KNOWLEDGE_WORKSPACE;
      process.env.ORBIT_KNOWLEDGE_WORKSPACE = "true";
    });
    afterEach(() => {
      if (flag === undefined) delete process.env.ORBIT_KNOWLEDGE_WORKSPACE;
      else process.env.ORBIT_KNOWLEDGE_WORKSPACE = flag;
    });
    const act = (
      name: (typeof NAMES)[number],
      input: Record<string, unknown>,
      as: Scope = owner,
    ) => {
      const handler = knowledgeActions[name]!;
      if (handler.transaction !== "own") throw new Error("expected own");
      return handler.run({ scope: as, input } as never) as Promise<any>;
    };
    const startInput = (extra: Record<string, unknown> = {}) => ({
      url: ROOT,
      name: "Help center",
      excludedPages: [],
      autoUpdate: true,
      marketing: true,
      support: true,
      publicUse: false,
      modelUse: true,
      language: "de",
      ...extra,
    });
    const sourceData = (id: string) =>
      run(async (tx) => data(await entity(tx, owner, "sources", id)));
    const counts = () =>
      run(async (tx) => ({
        entities: await tx.entity.count({
          where: { projectId: owner.projectId },
        }),
        audits: await tx.auditEvent.count({
          where: { projectId: owner.projectId },
        }),
        jobs: await tx.entity.count({
          where: { projectId: owner.projectId, kind: "jobs" },
        }),
      }));
    const siteAudits = () =>
      run((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: owner.projectId,
            action: { startsWith: "knowledge.site_" },
            NOT: { action: { startsWith: "knowledge.site_run" } },
          },
        }),
      );
    const refusal = (work: Promise<unknown>, code: string) =>
      expect(work).rejects.toMatchObject({ code });

    it("discover writes nothing", async () => {
      publish(1, 2, 3);
      const before = await counts();
      const found = await act("knowledge-site-discover", { url: ROOT });
      expect(found).toMatchObject({
        rootUrl: ROOT,
        discovery: "sitemap",
        capped: false,
        complete: true,
        excludedPages: [],
      });
      expect(found.pages.map((p: { url: string }) => p.url)).toEqual(
        [1, 2, 3].map(page),
      );
      expect(await counts()).toEqual(before);
    });

    it("discover for a source uses its root and returns its exclusions", async () => {
      publish(1, 2);
      const source = await siteSource();
      await exclude(source.id, page(2));
      const found = await act("knowledge-site-discover", {
        sourceId: source.id,
      });
      expect(found.pages.map((p: { url: string }) => p.url)).toEqual(
        [1, 2].map(page),
      );
      expect(found.excludedPages).toEqual([page(2)]);
    });

    it("discover and start refuse an address that is not a public HTTPS page", async () => {
      for (const url of [
        "http://docs.example.com/help",
        "https://user:pw@docs.example.com/help",
        "https://127.0.0.1/help",
        "not a url",
      ]) {
        await refusal(
          act("knowledge-site-discover", { url }),
          "KNOWLEDGE_SITE_URL_INVALID",
        );
        await refusal(
          act("knowledge-site-start", startInput({ url })),
          "KNOWLEDGE_SITE_URL_INVALID",
        );
      }
      expect(web.fetched).toEqual([]);
    });

    it("start creates a site source with maxAgeHours 336 and syncEveryHours 168", async () => {
      publish(1, 2, 3);
      const { sourceId, run: created } = await act(
        "knowledge-site-start",
        startInput({ excludedPages: [page(3)] }),
      );
      expect(await sourceData(sourceId)).toMatchObject({
        name: "Help center",
        type: "website",
        status: "active",
        generation: 1,
        authority: "official",
        maxAgeHours: 336,
        syncEveryHours: 168,
        publicUse: false,
        modelUse: true,
        audiences: ["marketing", "support"],
        allowedOrigins: ["https://docs.example.com"],
        allowedPaths: ["/help"],
        language: "de",
        site: {
          rootUrl: ROOT,
          discovery: "sitemap",
          excludedPages: [page(3)],
          lastRunId: created.id,
        },
      });
      expect(await state(created.id)).toMatchObject({
        trigger: "initial",
        status: "queued",
        sourceId,
        pages: [page(1), page(2)],
      });
      const drained = await drain(created.id);
      expect(drained).toMatchObject({ status: "completed", added: 2 });
    });

    it("start with weekly updates off leaves syncEveryHours absent", async () => {
      publish(1);
      const { sourceId } = await act(
        "knowledge-site-start",
        startInput({ autoUpdate: false }),
      );
      expect(await sourceData(sourceId)).not.toHaveProperty("syncEveryHours");
    });

    it("start without any audience is refused", async () => {
      publish(1);
      const before = await counts();
      await refusal(
        act(
          "knowledge-site-start",
          startInput({ marketing: false, support: false }),
        ),
        "KNOWLEDGE_NO_AUDIENCE",
      );
      expect(await counts()).toEqual(before);
    });

    it("start reuses an existing empty gitbook source", async () => {
      publish(1, 2);
      const sourcesBefore = (await run((tx) => list(tx, owner, "sources")))
        .length;
      const empty = await siteSource({
        type: "gitbook",
        site: undefined,
        syncEveryHours: undefined,
        audiences: ["marketing", "support"],
      });
      const { sourceId, run: created } = await act(
        "knowledge-site-start",
        startInput({ sourceId: empty.id, name: undefined, type: undefined }),
      );
      expect(sourceId).toBe(empty.id);
      expect(await sourceData(empty.id)).toMatchObject({
        type: "gitbook",
        generation: 1,
        syncEveryHours: 168,
        site: { rootUrl: ROOT, lastRunId: created.id },
      });
      const sources = await run((tx) => list(tx, owner, "sources"));
      expect(sources).toHaveLength(sourcesBefore + 1);
    });

    it("start on a reused source applies changed rights and bumps its generation", async () => {
      publish(1);
      const legacy = await siteSource({
        site: undefined,
        authority: "research",
        maxAgeHours: 168,
        modelUse: false,
      });
      await act(
        "knowledge-site-start",
        startInput({ sourceId: legacy.id, support: false }),
      );
      const d = await sourceData(legacy.id);
      expect(d).toMatchObject({
        authority: "official",
        maxAgeHours: 336,
        modelUse: true,
        audiences: ["marketing"],
      });
      expect(d.generation).toBeGreaterThan(1);
      expect(d.site.lastRunId).toBeTruthy();
    });

    it("start refuses a paused or revoked source and a changed root", async () => {
      publish(1);
      const paused = await siteSource({ status: "paused" });
      const revoked = await siteSource({ status: "revoked" });
      const active = await siteSource();
      await refusal(
        act("knowledge-site-start", startInput({ sourceId: paused.id })),
        "KNOWLEDGE_SOURCE_UNAVAILABLE",
      );
      await refusal(
        act("knowledge-site-start", startInput({ sourceId: revoked.id })),
        "KNOWLEDGE_SOURCE_UNAVAILABLE",
      );
      await refusal(
        act(
          "knowledge-site-start",
          startInput({
            sourceId: active.id,
            url: "https://docs.example.com/other",
          }),
        ),
        "KNOWLEDGE_SITE_ROOT_CHANGED",
      );
    });

    it("start without pages is refused with KNOWLEDGE_NO_PAGES", async () => {
      publish(1);
      const before = await counts();
      await refusal(
        act("knowledge-site-start", startInput({ excludedPages: [page(1)] })),
        "KNOWLEDGE_NO_PAGES",
      );
      expect(await counts()).toEqual(before);
    });

    it("start refuses exclusions outside the root and more than 200", async () => {
      publish(1);
      await refusal(
        act(
          "knowledge-site-start",
          startInput({ excludedPages: ["https://other.example.com/help/a"] }),
        ),
        "KNOWLEDGE_SITE_URL_INVALID",
      );
      await expect(
        act(
          "knowledge-site-start",
          startInput({
            excludedPages: range(201).map((n) => `${ROOT}/x-${n}`),
          }),
        ),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it("start returns the active run instead of a second one", async () => {
      publish(1, 2);
      const first = await act("knowledge-site-start", startInput());
      const second = await act(
        "knowledge-site-start",
        startInput({ sourceId: first.sourceId }),
      );
      expect(second.run.id).toBe(first.run.id);
    });

    it("refresh starts a manual run with no pages and returns the active one", async () => {
      publish(1);
      const source = await siteSource();
      const created = await act("knowledge-site-refresh", {
        sourceId: source.id,
      });
      expect(await state(created.id)).toMatchObject({
        trigger: "manual",
        pages: [],
        status: "queued",
      });
      const again = await act("knowledge-site-refresh", {
        sourceId: source.id,
      });
      expect(again.id).toBe(created.id);
      const audits = (await siteAudits()).filter(
        (a) => a.action === "knowledge.site_refreshed",
      );
      expect(audits).toHaveLength(1);
      expect(await drain(created.id)).toMatchObject({ status: "completed" });
    });

    it("refresh refuses a paused source", async () => {
      const paused = await siteSource({ status: "paused" });
      await refusal(
        act("knowledge-site-refresh", { sourceId: paused.id }),
        "KNOWLEDGE_SOURCE_UNAVAILABLE",
      );
    });

    it("settings without autoUpdate removes syncEveryHours", async () => {
      const source = await siteSource();
      await act("knowledge-site-settings", {
        sourceId: source.id,
        autoUpdate: false,
      });
      expect(await sourceData(source.id)).not.toHaveProperty("syncEveryHours");
      await act("knowledge-site-settings", {
        sourceId: source.id,
        autoUpdate: true,
      });
      expect(await sourceData(source.id)).toMatchObject({
        syncEveryHours: 168,
      });
    });

    it("settings stores validated exclusions and leaves the running run alone", async () => {
      publish(1, 2, 3);
      const source = await siteSource();
      const active = await start(source.id, "initial", sitePages([1, 2, 3]));
      const before = await run((tx) => entity(tx, owner, KIND, active.id));
      await act("knowledge-site-settings", {
        sourceId: source.id,
        excludedPages: [page(2)],
      });
      const d = await sourceData(source.id);
      expect(d.site.excludedPages).toEqual([page(2)]);
      expect(d.site.lastRunId).toBe(active.id);
      const after = await run((tx) => entity(tx, owner, KIND, active.id));
      expect(after.version).toBe(before.version);
      // The run reads the exclusions at its next batch.
      expect(await drain(active.id)).toMatchObject({ added: 2 });
      await refusal(
        act("knowledge-site-settings", {
          sourceId: source.id,
          excludedPages: ["https://docs.example.com/elsewhere"],
        }),
        "KNOWLEDGE_SITE_URL_INVALID",
      );
      await expect(
        act("knowledge-site-settings", {
          sourceId: source.id,
          excludedPages: range(201).map((n) => `${ROOT}/x-${n}`),
        }),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        act("knowledge-site-settings", { sourceId: source.id }),
      ).rejects.toBeInstanceOf(ZodError);
      expect((await sourceData(source.id)).site.excludedPages).toEqual([
        page(2),
      ]);
    });

    it("writes audit records with ids and counts only", async () => {
      publish(1, 2);
      const { sourceId } = await act("knowledge-site-start", startInput());
      await act("knowledge-site-settings", {
        sourceId,
        autoUpdate: false,
        excludedPages: [page(2)],
      });
      const records = await siteAudits();
      expect(records.map((a) => a.action).sort()).toEqual([
        "knowledge.site_settings_changed",
        "knowledge.site_started",
      ]);
      const text = JSON.stringify(records.map((a) => a.metadata));
      expect(text).not.toContain("docs.example.com");
      expect(text).not.toContain("Seite");
      expect(
        records.find((a) => a.action === "knowledge.site_started")?.metadata,
      ).toMatchObject({ pages: 2, excluded: 0, created: true });
    });

    it("only owners can use any site action", async () => {
      publish(1);
      const source = await siteSource();
      for (const name of NAMES) {
        const permission = knowledgeActionPermissions[name]!;
        expect(can({ role: "owner" }, permission)).toBe(true);
        expect(can({ role: "editor" }, permission)).toBe(false);
        expect(can({ role: "viewer" }, permission)).toBe(false);
      }
      const before = await counts();
      for (const as of [project.editor, project.viewer])
        for (const name of NAMES)
          await refusal(
            act(
              name,
              name === "knowledge-site-start"
                ? startInput()
                : { sourceId: source.id, autoUpdate: false },
              as,
            ),
            "OWNER_REQUIRED",
          );
      expect(await counts()).toEqual(before);
      expect(web.fetched).toEqual([]);
    });

    it("site actions stay inside their project", async () => {
      publish(1);
      const other = await createPackageProject({ name: "Synthetic other" });
      try {
        const foreign = await scoped(
          other.owner.workspaceId,
          other.owner.projectId,
          (tx) =>
            create(tx, other.owner, "sources", {
              name: "Foreign",
              type: "gitbook",
              status: "active",
              generation: 1,
              maxAgeHours: 336,
              site: {
                rootUrl: ROOT,
                discovery: "sitemap",
                excludedPages: [],
                lastRunId: null,
              },
            }),
        );
        const notSite = await siteSource({ type: "manual", site: undefined });
        const legacy = await siteSource({ type: "gitbook", site: undefined });
        const before = await counts();
        for (const sourceId of [foreign.id, notSite.id]) {
          await refusal(
            act("knowledge-site-discover", { sourceId }),
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
          );
          await refusal(
            act("knowledge-site-start", startInput({ sourceId })),
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
          );
          await refusal(
            act("knowledge-site-refresh", { sourceId }),
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
          );
          await refusal(
            act("knowledge-site-settings", { sourceId, autoUpdate: false }),
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
          );
        }
        // A legacy source without `site` can be discovered and started, not
        // refreshed or changed.
        await refusal(
          act("knowledge-site-refresh", { sourceId: legacy.id }),
          "KNOWLEDGE_SOURCE_UNAVAILABLE",
        );
        await refusal(
          act("knowledge-site-settings", {
            sourceId: legacy.id,
            autoUpdate: false,
          }),
          "KNOWLEDGE_SOURCE_UNAVAILABLE",
        );
        expect(await counts()).toEqual(before);
        const unchanged = await scoped(
          other.owner.workspaceId,
          other.owner.projectId,
          async (tx) =>
            data(await entity(tx, other.owner, "sources", foreign.id)),
        );
        expect(unchanged.site.lastRunId).toBeNull();
      } finally {
        await other.cleanup();
      }
    });

    it("start requires every owner setting", async () => {
      publish(1);
      for (const key of [
        "excludedPages",
        "autoUpdate",
        "marketing",
        "support",
        "publicUse",
        "modelUse",
        "language",
      ])
        await expect(
          act("knowledge-site-start", startInput({ [key]: undefined })),
        ).rejects.toBeInstanceOf(ZodError);
    });

    it("start refuses a root outside a legacy source that has documents", async () => {
      publish(1);
      const legacy = await siteSource();
      await read(legacy.id, [1]);
      await changeSource(legacy.id, ({ site: _site, ...d }) => d);
      expect(await live(legacy.id)).toHaveLength(1);
      const before = await sourceData(legacy.id);
      for (const url of [
        "https://other.example.com/help",
        "https://docs.example.com/elsewhere",
      ])
        await refusal(
          act("knowledge-site-start", startInput({ sourceId: legacy.id, url })),
          "KNOWLEDGE_SITE_ROOT_CHANGED",
        );
      expect(await sourceData(legacy.id)).toEqual(before);
    });

    it("start may re-point a legacy source without documents", async () => {
      web.pages.set("https://new.example.com/docs/a", "# A\n\nText.");
      web.sitemap = ["https://new.example.com/docs/a"];
      const legacy = await siteSource({ site: undefined });
      await act(
        "knowledge-site-start",
        startInput({
          sourceId: legacy.id,
          url: "https://new.example.com/docs",
        }),
      );
      expect(await sourceData(legacy.id)).toMatchObject({
        allowedOrigins: ["https://new.example.com"],
        allowedPaths: ["/docs"],
        site: { rootUrl: "https://new.example.com/docs" },
      });
    });

    it("a second start with other settings during a run changes nothing and returns the live run", async () => {
      publish(1, 2);
      const first = await act("knowledge-site-start", startInput());
      const before = await sourceData(first.sourceId);
      const audits = (await siteAudits()).length;
      const second = await act(
        "knowledge-site-start",
        startInput({
          sourceId: first.sourceId,
          modelUse: false,
          support: false,
          autoUpdate: false,
          excludedPages: [page(2)],
        }),
      );
      expect(second.run.id).toBe(first.run.id);
      expect(await sourceData(first.sourceId)).toEqual(before);
      expect((await siteAudits()).length).toBe(audits);
      expect(await drain(first.run.id)).toMatchObject({
        status: "completed",
        added: 2,
      });
    });

    it("an initial run does not retire pages missing from its list", async () => {
      publish(1, 2, 3, 4);
      const source = await siteSource();
      await read(source.id, [1, 2, 3, 4]);
      const second = await read(source.id, [1, 2]);
      expect(second).toMatchObject({ status: "completed", removed: 0 });
      expect(second.warning).toBeNull();
      expect(await live(source.id)).toHaveLength(4);
      // Exclusions are still retired by an initial run.
      await exclude(source.id, page(4));
      const third = await read(source.id, [1, 2]);
      expect(third).toMatchObject({ removed: 1 });
      expect(await live(source.id)).toHaveLength(3);
    });
  });
});
