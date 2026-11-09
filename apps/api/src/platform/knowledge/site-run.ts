import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  assertActiveEmbeddingProfile,
  containsCredentials,
} from "../../../../../packages/knowledge/src/index.ts";
import { activeSpendMandateRef } from "../ai/spend-mandate.ts";
import { runtimeOpenAiConfiguration } from "../ai/openai-configuration.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { create, data, DomainError, entity, list, update } from "../shared.ts";
import { ingest, retireDocument } from "./engine.ts";
import { queueDocumentEmbedding } from "./ingestion.ts";
import { indexHasEmbeddings } from "./retrieval.ts";
import {
  discoverSite,
  readSitePage,
  sitePolicy,
  type SitePage,
} from "./site-sync.ts";

export const SITE_BATCH = 20;
export const SITE_QUEUE = "knowledge_site_sync";
const RUN_KIND = "knowledge_site_runs";
const MAX_LISTED_FAILURES = 50;
const ACTIVE = ["queued", "running"];

type Row = Awaited<ReturnType<typeof entity>>;
type Fields = Record<string, any>;
type Step = { row: Row; run: Fields; source: Fields };
/** What one batch needs to take a step: `end` is the cursor it stops at. */
type Batch = { s: Scope; runId: string; end: number };

const within = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
  scoped(s.workspaceId, s.projectId, work);
const owned = (s: Scope, id: string, kind: string) => ({
  id,
  kind,
  workspaceId: s.workspaceId,
  projectId: s.projectId,
});
/** A page's document key: the page URL, whichever format it was read in. */
const pageId = (url: string) => url.replace(/\.md$/, "");
const excludedPages = (source: Fields) =>
  new Set<string>((source.site.excludedPages ?? []).map(pageId));
/** Codes only: a run never records a page's content or an error's text. */
function codeOf(error: unknown, fallback: string) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.slice(0, 100) : fallback;
}
const closed = (
  run: Fields,
  status: string,
  errorCode: string | null = null,
) => ({
  ...run,
  status,
  errorCode,
  completedAt: new Date().toISOString(),
});

/**
 * Starts a read of a site source, or returns the run already active for it.
 * Only `initial` runs bring a page list; the others discover in their first
 * batch, because the sweep must not fetch inside its transaction.
 */
export async function startSiteRun(
  tx: DbTx,
  s: Scope,
  sourceId: string,
  trigger: "initial" | "manual" | "schedule",
  pages: SitePage[],
) {
  // A concurrent start waits here and then finds the run this one created.
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${sourceId}::uuid AND "projectId"=${s.projectId}::uuid FOR UPDATE`;
  const active = (await list(tx, s, RUN_KIND)).find(
    (r) => data(r).sourceId === sourceId && ACTIVE.includes(data(r).status),
  );
  if (active) return active;
  const source = await entity(tx, s, "sources", sourceId);
  const d = data(source);
  if (d.status !== "active" || !d.site)
    throw new DomainError("SOURCE_UNAVAILABLE", 409);
  const run = await create(tx, s, RUN_KIND, {
    sourceId,
    trigger,
    generation: d.generation,
    status: "queued",
    // `pages` is the URL list; `languages` holds each page's language at the same index.
    pages: pages.map((p) => p.url),
    languages: pages.map((p) => p.language),
    cursor: 0,
    unchanged: 0,
    changed: 0,
    added: 0,
    removed: 0,
    failed: [],
    skippedSensitive: 0,
    embeddingsQueued: 0,
    warning: null,
    errorCode: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });
  await update(tx, s, source, { ...d, site: { ...d.site, lastRunId: run.id } });
  await enqueue(tx, s, SITE_QUEUE, run.id, `site:${run.id}:0`);
  return run;
}

/** When a site source is due next in ms; null while its last run is still active. */
export async function siteRunDueAt(tx: DbTx, s: Scope, source: Fields) {
  const { lastRunId } = source.site;
  if (!lastRunId) return 0;
  const last = data(
    await tx.entity.findFirst({ where: owned(s, lastRunId, RUN_KIND) }),
  );
  if (ACTIVE.includes(last.status)) return null;
  return (Date.parse(last.startedAt) || 0) + source.syncEveryHours * 3600000;
}

/** Ends a run that its job can no longer serve, so the source can run again. */
export async function failSiteRun(
  tx: DbTx,
  s: Scope,
  runId: string,
  errorCode: string,
) {
  const row = await tx.entity.findFirst({ where: owned(s, runId, RUN_KIND) });
  if (row && ACTIVE.includes(data(row).status))
    await update(tx, s, row, closed(data(row), "failed", errorCode));
}

/**
 * The run inside the current transaction, or null when nothing may be done
 * for it. The source's status and generation are read here at every step, so
 * pausing a source stops its run. With `cursor` the page must still be the
 * next one, so a repeated delivery cannot process or count a page twice.
 */
async function currentStep(
  tx: DbTx,
  s: Scope,
  runId: string,
  cursor?: number,
): Promise<Step | null> {
  const row = await entity(tx, s, RUN_KIND, runId);
  const run = data(row);
  if (!ACTIVE.includes(run.status)) return null;
  if (cursor !== undefined && run.cursor !== cursor) return null;
  const source = data(
    await tx.entity.findFirst({ where: owned(s, run.sourceId, "sources") }),
  );
  if (source.status !== "active" || source.generation !== run.generation) {
    await update(tx, s, row, closed(run, "failed", "SOURCE_INACTIVE"));
    return null;
  }
  return { row, run, source };
}

/** Moves past one page; the step that finishes the batch enqueues the next. */
async function advance(
  tx: DbTx,
  { s, end }: Batch,
  { row, run }: Step,
  counters: Fields,
) {
  const cursor = run.cursor + 1;
  await update(tx, s, row, { ...run, ...counters, cursor });
  if (cursor === end && end < run.pages.length)
    await enqueue(tx, s, SITE_QUEUE, row.id, `site:${row.id}:${end}`);
}

/** Moves past a page without touching its document. False stops the batch. */
function passPage(
  batch: Batch,
  cursor: number,
  counters: (run: Fields) => Fields,
) {
  return within(batch.s, async (tx) => {
    const step = await currentStep(tx, batch.s, batch.runId, cursor);
    if (!step) return false;
    await advance(tx, batch, step, counters(step.run));
    return true;
  });
}

/** Without any of these the page simply stays full-text searchable. */
async function embeddingAllowed(tx: DbTx, s: Scope, source: Fields) {
  if (!source.modelUse) return false;
  const index = await assertActiveEmbeddingProfile(tx, s).catch(() => null);
  if (!index || !(await indexHasEmbeddings(tx, s, index))) return false;
  if (!(await runtimeOpenAiConfiguration(tx, s)).apiKey) return false;
  const authority = await activeSpendMandateRef(tx, s);
  if (!authority) return false;
  const now = Date.now();
  return (
    now >= Date.parse(authority.data.startAt) &&
    now < Date.parse(authority.data.endAt)
  );
}

/** Ingesting and advancing are one transaction: a retry resumes at this page. */
function takePage(
  batch: Batch,
  cursor: number,
  page: SitePage,
  read: Awaited<ReturnType<typeof readSitePage>>,
) {
  const { s, runId } = batch;
  return within(s, async (tx) => {
    const step = await currentStep(tx, s, runId, cursor);
    if (!step) return false;
    const { run, source } = step;
    const externalId = pageId(page.url);
    const before = await tx.knowledgeDocument.findUnique({
      where: {
        workspaceId_projectId_sourceId_externalId: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          sourceId: run.sourceId,
          externalId,
        },
      },
      select: { activeVersionId: true },
    });
    const result = await ingest(tx, s, {
      sourceId: run.sourceId,
      externalId,
      canonicalUrl: externalId,
      title: read.title,
      text: read.text,
      mimeType: read.mimeType,
      language: page.language,
      expectedGeneration: run.generation,
    });
    const counter = result.unchanged
      ? "unchanged"
      : before?.activeVersionId
        ? "changed"
        : "added";
    const queued =
      !result.unchanged && (await embeddingAllowed(tx, s, source))
        ? await queueDocumentEmbedding(tx, s, result.documentId)
        : null;
    await advance(tx, batch, step, {
      [counter]: run[counter] + 1,
      embeddingsQueued:
        run.embeddingsQueued + (queued && "id" in queued ? 1 : 0),
    });
    return true;
  });
}

/** Fetches outside any transaction. False stops the batch. */
async function readPage(
  batch: Batch,
  cursor: number,
  page: SitePage,
  rootUrl: string,
) {
  try {
    const read = await readSitePage(page.url, sitePolicy(rootUrl));
    return containsCredentials(read.text)
      ? await passPage(batch, cursor, (run) => ({
          skippedSensitive: run.skippedSensitive + 1,
        }))
      : await takePage(batch, cursor, page, read);
  } catch (error) {
    // The page keeps its last version; the run goes on and still completes.
    const entry = { url: page.url, code: codeOf(error, "SITE_PAGE_FAILED") };
    return passPage(batch, cursor, (run) => ({
      failed:
        run.failed.length < MAX_LISTED_FAILURES
          ? [...run.failed, entry]
          : run.failed,
    }));
  }
}

/** The first batch settles the page list: stored once, so a retry never rediscovers. */
async function beginRun(
  s: Scope,
  runId: string,
  opened: Step & { project: { language: string; contentLanguages: string[] } },
): Promise<Fields | null> {
  const { run, source, project } = opened;
  const found =
    run.trigger === "initial"
      ? null
      : await discoverSite(source.site.rootUrl, {
          languages: project.contentLanguages,
          fallbackLanguage: source.language ?? project.language,
        });
  return within(s, async (tx) => {
    const step = await currentStep(tx, s, runId);
    if (!step || step.run.status !== "queued") return step?.run ?? null;
    const pages = found ? found.pages.map((p) => p.url) : step.run.pages;
    // A site with a sitemap that now offers none has not shrunk to its root
    // page: discovery returned nothing (D-6).
    const nothing =
      !pages.length ||
      (found?.discovery === "single" && source.site.discovery === "sitemap");
    const next = {
      ...step.run,
      status: "running",
      pages,
      languages: found
        ? found.pages.map((p) => p.language)
        : step.run.languages,
      warning: nothing ? "site_shrank" : null,
    };
    await update(tx, s, step.row, next);
    return next;
  });
}

/**
 * Removals once the last page is done, one short transaction per document so
 * a large removal cannot time out. Missing pages go before excluded ones: a
 * retry after a partial removal then cannot trip D-6 where the first try did not.
 */
async function finishRun(s: Scope, runId: string) {
  const retiring = await within(s, async (tx) => {
    const step = await currentStep(tx, s, runId);
    if (!step) return null;
    const { row, run, source } = step;
    const documents = await tx.knowledgeDocument.findMany({
      where: {
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        sourceId: run.sourceId,
        activeVersionId: { not: null },
      },
      select: { id: true, externalId: true },
    });
    const listed = new Set<string>(run.pages.map(pageId));
    const excluded = excludedPages(source);
    const missing = documents.filter(
      (d) => !listed.has(d.externalId) && !excluded.has(d.externalId),
    );
    if (run.warning || missing.length * 2 > documents.length) {
      await update(tx, s, row, {
        ...closed(run, "completed"),
        warning: "site_shrank",
      });
      return null;
    }
    return [
      ...missing,
      ...documents.filter((d) => excluded.has(d.externalId)),
    ].map((d) => d.id);
  });
  if (!retiring) return;
  for (const documentId of retiring) {
    const goOn = await within(s, async (tx) => {
      const step = await currentStep(tx, s, runId);
      if (!step) return false;
      const { retired } = await retireDocument(tx, s, documentId);
      await update(tx, s, step.row, {
        ...step.run,
        removed: step.run.removed + (retired ? 1 : 0),
      });
      return true;
    });
    if (!goOn) return;
  }
  await within(s, async (tx) => {
    const step = await currentStep(tx, s, runId);
    if (step) await update(tx, s, step.row, closed(step.run, "completed"));
  });
}

async function readBatch(s: Scope, runId: string, jobId: string) {
  const opened = await within(s, async (tx) => {
    const job = data(await entity(tx, s, "jobs", jobId));
    const step = await currentStep(tx, s, runId);
    if (!step) return null;
    const project = await tx.project.findUniqueOrThrow({
      where: { id: s.projectId },
      select: { language: true, contentLanguages: true },
    });
    // The job's key fixes the pages it covers: a late duplicate of a finished
    // batch finds them done instead of reading the next batch's pages.
    const from = Number(String(job.idempotencyKey).split(":").pop());
    return { ...step, project, from };
  });
  if (!opened) return;
  const run =
    opened.run.status === "queued"
      ? await beginRun(s, runId, opened)
      : opened.run;
  if (!run) return;
  const excluded = excludedPages(opened.source);
  const end = Math.min(opened.from + SITE_BATCH, run.pages.length);
  const batch: Batch = { s, runId, end };
  for (let cursor = run.cursor; cursor < end; cursor++) {
    const url: string = run.pages[cursor];
    const going = excluded.has(pageId(url))
      ? await passPage(batch, cursor, () => ({}))
      : await readPage(
          batch,
          cursor,
          { url, language: run.languages[cursor] },
          opened.source.site.rootUrl,
        );
    if (!going) return;
  }
  if (end === run.pages.length) await finishRun(s, runId);
}

/** One bounded batch per durable job (D-3). */
export async function runSiteBatch(s: Scope, runId: string, jobId: string) {
  try {
    await readBatch(s, runId, jobId);
  } catch (error) {
    // A retry resumes where this one stopped; only the last attempt ends the
    // run, which would otherwise stay active and block the source for good.
    await within(s, async (tx) => {
      const job = data(
        await tx.entity.findFirst({ where: owned(s, jobId, "jobs") }),
      );
      if (job.attempts >= job.maxAttempts)
        await failSiteRun(tx, s, runId, codeOf(error, "SITE_RUN_FAILED"));
    });
    throw error;
  }
}
