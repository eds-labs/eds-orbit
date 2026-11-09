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
import { createPackageProject } from "./support/package-project.ts";

// No live site and no paid model: every fetch below is stubbed.
const web = vi.hoisted(() => ({
  pages: new Map<string, string>(),
  sitemap: null as string[] | null,
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
      if (!web.sitemap) throw new knowledge.KnowledgeError("SOURCE_NOT_FOUND");
      const body = web.sitemap
        .map((u) => `<url><loc>${u}</loc></url>`)
        .join("");
      return {
        bytes: Buffer.from(`<urlset>${body}</urlset>`),
        mimeType: "application/xml",
        url,
      };
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
  const fetchCount = (url: string) =>
    web.fetched.filter((u) => u === url).length;

  beforeEach(async () => {
    web.pages.clear();
    web.sitemap = null;
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
});
