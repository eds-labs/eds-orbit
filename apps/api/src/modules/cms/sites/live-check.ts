import { randomUUID } from "node:crypto";
import { scoped, type DbTx, type Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { boundedFetch, type FetchLike } from "../../../../../../packages/connectors/src/http.ts";
import { publishEvent } from "../../../platform/events/events.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import type { JobDef } from "../../../platform/jobs/types.ts";
import { audit } from "../../../shared.ts";
import { cmsActive } from "../gate.ts";
import { absoluteUrl, entryPath, siteRoutes } from "../types/routes.ts";
import { adapterFor, pullSettings } from "./adapters.ts";
import { raiseVerification } from "./sites.ts";

// The live check (ADR 0029 §2.3, CH1.11): after a publication Orbit fetches
// the entry's page on the site and looks for `<meta name="orbit-revision"
// content="…">` with the live revision's id or number. A withdrawn entry's
// old page must answer 404 or 410, or redirect away. Sites opt in per site
// (`adapterConfig.liveCheck`), because the page must render the tag. Checks
// repeat on the site's schedule (ISR sites are quick, rebuilding sites slow);
// the last miss marks the publication for a person. Orbit's own state is
// already live; the check only says whether visitors see it.

export const CMS_LIVE_CHECK_QUEUE = "cms_live_check";
const LIVE = ["visible", "notified"];

let fetcher: FetchLike = boundedFetch;
/** Test hook: the real transport refuses private addresses by design. */
export function setLiveCheckFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

const minutesFor = (adapterConfig: unknown) => pullSettings(adapterConfig).liveCheckMinutes;

/** Queues the first live check of each publication whose site asks for one. */
export async function scheduleLiveChecks(tx: DbTx, scope: Scope, publicationIds: readonly string[]) {
  if (!publicationIds.length) return 0;
  const pubs = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, id: { in: [...publicationIds] } },
    select: { id: true, siteId: true },
  });
  const sites = await tx.cmsSite.findMany({
    where: { projectId: scope.projectId, id: { in: pubs.map((p) => p.siteId) } },
    select: { id: true, adapter: true, adapterConfig: true },
  });
  let queued = 0;
  for (const pub of pubs) {
    const site = sites.find((s) => s.id === pub.siteId);
    if (!site || !adapterFor(site.adapter)?.capabilities.liveCheck || !pullSettings(site.adapterConfig).liveCheck) continue;
    const at = new Date(Date.now() + minutesFor(site.adapterConfig)[0]! * 60_000);
    await enqueue(tx, scope, CMS_LIVE_CHECK_QUEUE, pub.id, `cms-live:${pub.id}:0`, at);
    queued++;
  }
  return queued;
}

interface Plan {
  publicationId: string;
  siteId: string;
  url: string;
  expect: { kind: "revision"; ids: string[]; meta: string } | { kind: "gone"; path: string };
  attempt: number;
  minutes: number[];
  visibleAt: Date;
}

async function step(
  tx: DbTx,
  scope: Scope,
  publicationId: string,
  outcome: "ok" | "failed" | "skipped",
  extra: { errorCode?: string | null; httpStatus?: number | null; durationMs?: number; detail?: Record<string, unknown> } = {},
) {
  await tx.cmsPublicationAttempt.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      publicationId,
      step: "live_check",
      outcome,
      httpStatus: extra.httpStatus ?? null,
      errorCode: extra.errorCode ?? null,
      durationMs: extra.durationMs ?? null,
      detail: (extra.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** What the check expects, or the reason it is not needed any more. */
async function prepare(tx: DbTx, scope: Scope, publicationId: string): Promise<Plan | { skip: string } | null> {
  const pub = await tx.cmsPublication.findFirst({ where: { id: publicationId, projectId: scope.projectId } });
  if (!pub || !LIVE.includes(pub.status)) return null;
  const site = await tx.cmsSite.findFirst({ where: { id: pub.siteId, projectId: scope.projectId } });
  if (!site || site.archivedAt) return { skip: "CMS_SITE_UNAVAILABLE" };
  const settings = pullSettings(site.adapterConfig);
  if (!settings.liveCheck) return { skip: "CMS_LIVE_CHECK_OFF" };
  const entry = await tx.cmsEntry.findFirst({ where: { id: pub.entryId, projectId: scope.projectId } });
  if (!entry) return { skip: "CMS_ENTRY_NOT_FOUND" };
  // A newer publication of the entry on this site has its own check.
  const newer = await tx.cmsPublication.findFirst({
    where: { projectId: scope.projectId, entryId: pub.entryId, siteId: pub.siteId, createdAt: { gt: pub.createdAt }, status: { in: [...LIVE, "live_verified"] } },
    select: { id: true },
  });
  if (newer) return { skip: "CMS_SUPERSEDED" };
  const routes = siteRoutes.parse(site.routes);
  const attempt = await tx.cmsPublicationAttempt.count({ where: { projectId: scope.projectId, publicationId, step: "live_check" } });
  const base = { publicationId, siteId: site.id, attempt, minutes: settings.liveCheckMinutes, visibleAt: pub.visibleAt ?? pub.createdAt };

  if (pub.action === "unpublish") {
    const before = await tx.cmsPublication.findFirst({
      where: { projectId: scope.projectId, entryId: pub.entryId, siteId: pub.siteId, action: { not: "unpublish" }, createdAt: { lt: pub.createdAt }, status: { in: [...LIVE, "live_verified"] } },
      orderBy: { createdAt: "desc" },
      select: { revisionId: true },
    });
    const revision = before?.revisionId
      ? await tx.cmsRevision.findFirst({ where: { id: before.revisionId, projectId: scope.projectId }, select: { slug: true } })
      : null;
    if (!revision) return { skip: "CMS_PREVIOUS_PATH_UNKNOWN" };
    const path = entryPath(routes, entry.type, entry.locale, revision.slug, site.trailingSlash);
    return { ...base, url: absoluteUrl(site.baseUrl, path), expect: { kind: "gone", path } };
  }
  if (entry.publishedRevisionId !== pub.revisionId) return { skip: "CMS_SUPERSEDED" };
  const revision = await tx.cmsRevision.findFirst({ where: { id: pub.revisionId!, projectId: scope.projectId }, select: { id: true, number: true, slug: true } });
  if (!revision) return { skip: "CMS_REVISION_NOT_FOUND" };
  const path = entryPath(routes, entry.type, entry.locale, revision.slug, site.trailingSlash);
  return {
    ...base,
    url: absoluteUrl(site.baseUrl, path),
    expect: { kind: "revision", ids: [revision.id, String(revision.number)], meta: settings.revisionMeta },
  };
}

/** The `content` of `<meta name="…">` in an HTML page, or null. */
export function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    // The attribute name must follow whitespace: `data-name=` is not `name=`.
    const attr = (key: string) => tag.match(new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
    const found = attr("name");
    if ((found?.[1] ?? found?.[2] ?? found?.[3])?.toLowerCase() !== name) continue;
    const content = attr("content");
    return (content?.[1] ?? content?.[2] ?? content?.[3] ?? "").trim();
  }
  return null;
}

/** Fetches the page (outside any transaction) and judges it. */
async function look(plan: Plan): Promise<{ ok: boolean; errorCode: string | null; httpStatus: number | null; durationMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(plan.url, {
      method: "GET",
      headers: { accept: "text/html", "user-agent": "OrbitLiveCheck/1" },
      signal: controller.signal,
    });
    const status = response.status;
    const durationMs = Date.now() - started;
    if (plan.expect.kind === "gone") {
      if (status === 404 || status === 410) return { ok: true, errorCode: null, httpStatus: status, durationMs };
      if ([301, 302, 307, 308].includes(status)) {
        const location = response.headers.get("location");
        const target = location ? new URL(location, plan.url).pathname : null;
        const ok = Boolean(target) && target !== plan.expect.path;
        return { ok, errorCode: ok ? null : "CMS_LIVE_STILL_SERVED", httpStatus: status, durationMs };
      }
      return { ok: false, errorCode: "CMS_LIVE_STILL_SERVED", httpStatus: status, durationMs };
    }
    if (status !== 200) return { ok: false, errorCode: "CMS_LIVE_HTTP_STATUS", httpStatus: status, durationMs };
    const shown = metaContent(await response.text(), plan.expect.meta);
    if (shown === null) return { ok: false, errorCode: "CMS_LIVE_META_MISSING", httpStatus: status, durationMs };
    const ok = plan.expect.ids.includes(shown);
    return { ok, errorCode: ok ? null : "CMS_LIVE_OLD_REVISION", httpStatus: status, durationMs };
  } catch {
    return { ok: false, errorCode: "CMS_LIVE_UNREACHABLE", httpStatus: null, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** One live check of one publication; queues the next one or asks for a person. */
export async function runLiveCheck(scope: Scope, publicationId: string) {
  const plan = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await cmsActive(tx, scope))) return { skip: "CMS_DISABLED", silent: true } as const;
    const prepared = await prepare(tx, scope, publicationId);
    if (prepared && "skip" in prepared) await step(tx, scope, publicationId, "skipped", { errorCode: prepared.skip });
    return prepared;
  });
  if (!plan) return { status: "nothing_to_check" };
  if ("skip" in plan) return { status: "skipped", errorCode: plan.skip };

  const result = await look(plan);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    // The publication may have moved on while the page was fetched.
    const pub = await tx.cmsPublication.findFirst({ where: { id: publicationId, projectId: scope.projectId } });
    if (!pub || !LIVE.includes(pub.status)) return { status: "nothing_to_check" };
    const detail = { attempt: plan.attempt + 1 };
    if (result.ok) {
      await step(tx, scope, publicationId, "ok", { httpStatus: result.httpStatus, durationMs: result.durationMs, detail });
      await tx.cmsPublication.update({
        where: { id: publicationId },
        data: { status: "live_verified", liveVerifiedAt: new Date(), errorCode: null, version: { increment: 1 } },
      });
      await raiseVerification(tx, scope, plan.siteId, "live_verified");
      return { status: "live_verified" };
    }
    await step(tx, scope, publicationId, "failed", { errorCode: result.errorCode, httpStatus: result.httpStatus, durationMs: result.durationMs, detail });
    const next = plan.attempt + 1;
    if (next < plan.minutes.length) {
      const at = new Date(Math.max(Date.now() + 30_000, plan.visibleAt.getTime() + plan.minutes[next]! * 60_000));
      await enqueue(tx, scope, CMS_LIVE_CHECK_QUEUE, publicationId, `cms-live:${publicationId}:${next}`, at);
      return { status: "retry", errorCode: result.errorCode };
    }
    // The site still does not show it: Orbit is live, visitors are not.
    await tx.cmsPublication.update({ where: { id: publicationId }, data: { errorCode: "CMS_LIVE_CHECK_FAILED", version: { increment: 1 } } });
    await publishEvent(tx, scope, {
      type: "cms.publication.needs_attention",
      subject: { type: "cms.entry", id: pub.entryId },
      actor: { kind: "system", id: null },
      origin: "cms",
      data: { code: "CMS_LIVE_CHECK_FAILED", publications: 1, reason: result.errorCode },
    });
    await audit(tx, scope, "cms.publication.live_check_failed", pub.entryId, { publicationId, reason: result.errorCode });
    return { status: "needs_attention", errorCode: "CMS_LIVE_CHECK_FAILED" };
  });
}

export const cmsLiveCheckJob: JobDef = {
  queueClass: CMS_LIVE_CHECK_QUEUE,
  handler: async ({ scope, job }) => {
    const result = await runLiveCheck(scope, String(job.resourceId));
    return { status: "succeeded", errorCode: "errorCode" in result ? (result.errorCode ?? null) : null };
  },
};
