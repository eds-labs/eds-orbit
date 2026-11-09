import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { validatePublicUrl } from "../../../../../packages/knowledge/src/index.ts";
import {
  setSourceAudiences,
  setSourceRights,
} from "../../platform/knowledge/engine.ts";
import { startSiteRun } from "../../platform/knowledge/site-run.ts";
import {
  discoverSite,
  sitePolicy,
  type SiteDiscovery,
} from "../../platform/knowledge/site-sync.ts";
import {
  audit,
  create,
  data,
  DomainError,
  list,
  update,
} from "../../shared.ts";
import {
  audiencesOf,
  lockKnowledge,
  owner,
  replaceDraft,
} from "./workspace.ts";

// Owner actions for site sources (spec "Add flow"). Every action rechecks the
// owner and works inside the scope it receives. Discovery fetches outside any
// transaction, and audit records hold ids and counts only.

const MAX_EXCLUDED = 200;
const url = z.string().max(2000);
const excludedPages = z.array(url).max(MAX_EXCLUDED);

export const siteDiscoverInput = z
  .object({ url: url.optional(), sourceId: schemas.id.optional() })
  .strict();
export const siteStartInput = z
  .object({
    sourceId: schemas.id.optional(),
    url: url.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(["gitbook", "website"]).optional(),
    excludedPages: excludedPages,
    autoUpdate: z.boolean(),
    marketing: z.boolean(),
    support: z.boolean(),
    publicUse: z.boolean(),
    modelUse: z.boolean(),
    language: schemas.languageCode,
    // The draft this take-over replaces, made while the owner chose a way.
    draftId: schemas.id.optional(),
  })
  .strict();
export const siteRefreshInput = z.object({ sourceId: schemas.id }).strict();
export const siteSettingsInput = z
  .object({
    sourceId: schemas.id,
    autoUpdate: z.boolean().optional(),
    excludedPages: excludedPages.optional(),
  })
  .strict()
  .refine((v) => v.autoUpdate !== undefined || v.excludedPages !== undefined, {
    message: "Nothing to change",
  });

type Fields = Record<string, any>;
const unavailable = (status = 404) =>
  new DomainError("KNOWLEDGE_SOURCE_UNAVAILABLE", status);
const within = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
  scoped(s.workspaceId, s.projectId, work);

/** The source of this project, or the module's not-found error. */
async function siteSource(
  tx: DbTx,
  s: Scope,
  sourceId: string,
  { site }: { site: boolean },
) {
  const row = await tx.entity.findFirst({
    where: {
      id: sourceId,
      kind: "sources",
      workspaceId: s.workspaceId,
      projectId: s.projectId,
    },
  });
  const d = row ? data(row) : null;
  if (!row || !d || !["gitbook", "website"].includes(d.type))
    throw unavailable();
  if (site && !d.site) throw unavailable();
  return row;
}

/** A page address is a page of the root: same origin, inside its path. */
function checkPage(rootUrl: string, page: string) {
  try {
    validatePublicUrl(page, sitePolicy(rootUrl));
  } catch {
    throw new DomainError("KNOWLEDGE_SITE_URL_INVALID", 400);
  }
}

/** The root address as stored: public HTTPS, no trailing slash below `/`. */
function normalizeRoot(input: string) {
  let origin: string;
  try {
    origin = new URL(input).origin;
  } catch {
    throw new DomainError("KNOWLEDGE_SITE_URL_INVALID", 400);
  }
  let root: URL;
  try {
    root = validatePublicUrl(input, {
      allowedOrigins: [origin],
      allowedPaths: ["/"],
      maxBytes: 1_000_000,
    });
  } catch {
    throw new DomainError("KNOWLEDGE_SITE_URL_INVALID", 400);
  }
  const path = root.pathname.replace(/\/+$/, "");
  return path ? root.origin + path + root.search : root.href;
}

/** The address of an existing source: its site root, else origin and path. */
function sourceRoot(d: Fields) {
  if (d.site?.rootUrl) return String(d.site.rootUrl);
  const origin = d.allowedOrigins?.[0];
  if (!origin) throw new DomainError("KNOWLEDGE_SITE_URL_REQUIRED", 400);
  const path = String(d.allowedPaths?.[0] ?? "/");
  return origin.replace(/\/+$/, "") + (path === "/" ? "" : path);
}

const pageKey = (page: string) => page.replace(/\.md$/, "");

/** Whether a gitbook or website source without a site already covers this address. */
function allowlistCovers(d: Fields, rootUrl: string) {
  try {
    validatePublicUrl(rootUrl, {
      allowedOrigins: d.allowedOrigins ?? [],
      allowedPaths: d.allowedPaths ?? [],
      maxBytes: 1_000_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** A second source for one address would hold the same pages twice. */
async function refuseKnownSite(tx: DbTx, s: Scope, rootUrl: string) {
  for (const row of await list(tx, s, "sources")) {
    const d = data(row);
    if (d.status !== "active") continue;
    const taken = d.site
      ? d.site.rootUrl === rootUrl
      : ["gitbook", "website"].includes(d.type) && allowlistCovers(d, rootUrl);
    if (taken) throw new DomainError("KNOWLEDGE_SITE_EXISTS", 409);
  }
}

async function discover(s: Scope, rootUrl: string, d?: Fields) {
  const project = await within(s, (tx) =>
    tx.project.findUniqueOrThrow({
      where: { id: s.projectId },
      select: { language: true, contentLanguages: true },
    }),
  );
  // Fetching stays outside any transaction.
  return discoverSite(rootUrl, {
    languages: project.contentLanguages,
    fallbackLanguage: d?.language ?? project.language,
  });
}

/** Returns the page list of an address or source; writes nothing. */
export async function discoverSitePages(scope: Scope, raw: unknown) {
  await owner(scope);
  const i = siteDiscoverInput.parse(raw);
  const source = i.sourceId
    ? await within(scope, async (tx) =>
        siteSource(tx, scope, i.sourceId!, { site: false }),
      )
    : null;
  const d = source ? data(source) : undefined;
  const target = i.url ?? (d ? sourceRoot(d) : null);
  if (!target) throw new DomainError("KNOWLEDGE_SITE_URL_REQUIRED", 400);
  const rootUrl = normalizeRoot(target);
  if (!source) await within(scope, (tx) => refuseKnownSite(tx, scope, rootUrl));
  const found = await discover(scope, rootUrl, d);
  return {
    ...found,
    excludedPages: (d?.site?.excludedPages ?? []) as string[],
  };
}

/** The rights an owner chose, applied to a reused source without needless generation bumps. */
async function applyRights(
  tx: DbTx,
  s: Scope,
  sourceId: string,
  d: Fields,
  wanted: Fields,
  audiences: string[],
) {
  const changes: Fields = {};
  for (const key of ["publicUse", "modelUse", "authority", "maxAgeHours"])
    if (d[key] !== wanted[key]) changes[key] = wanted[key];
  if (Object.keys(changes).length)
    await setSourceRights(tx, s, sourceId, changes);
  const current = [...(d.audiences ?? [])].sort().join();
  if (current !== [...audiences].sort().join())
    await setSourceAudiences(tx, s, sourceId, audiences);
}

/**
 * Creates the site source, or reuses the one named, and starts its initial
 * run with the pages that remain after the owner's exclusions.
 */
export async function startSite(scope: Scope, raw: unknown) {
  await owner(scope);
  const i = siteStartInput.parse(raw);
  const audiences = audiencesOf(i);
  const existing = i.sourceId
    ? await within(scope, (tx) =>
        siteSource(tx, scope, i.sourceId!, { site: false }),
      )
    : null;
  const before = existing ? data(existing) : undefined;
  if (before && before.status !== "active") throw unavailable(409);
  const target = i.url ?? (before ? sourceRoot(before) : null);
  if (!target) throw new DomainError("KNOWLEDGE_SITE_URL_REQUIRED", 400);
  const rootUrl = normalizeRoot(target);
  // A source keeps its address: its documents are keyed by it.
  if (before?.site && before.site.rootUrl !== rootUrl)
    throw new DomainError("KNOWLEDGE_SITE_ROOT_CHANGED", 409);
  for (const page of i.excludedPages) checkPage(rootUrl, page);
  if (!existing)
    await within(scope, (tx) => refuseKnownSite(tx, scope, rootUrl));
  const found: SiteDiscovery = await discover(scope, rootUrl, before);
  const excluded = new Set(i.excludedPages.map(pageKey));
  const pages = found.pages.filter((p) => !excluded.has(pageKey(p.url)));
  if (!pages.length) throw new DomainError("KNOWLEDGE_NO_PAGES", 422);
  const root = new URL(rootUrl);
  return within(scope, async (tx) => {
    await lockKnowledge(tx, scope);
    const wanted = {
      publicUse: i.publicUse,
      modelUse: i.modelUse,
      authority: "official",
      maxAgeHours: 336,
    };
    let sourceId: string;
    let repoint = true;
    if (existing) {
      // Re-read under the lock: the source may have changed since the check.
      const row = await siteSource(tx, scope, existing.id, { site: false });
      const d = data(row);
      if (d.status !== "active") throw unavailable(409);
      // A run that is active is returned as it is: no setting may change
      // under it, and nothing was started.
      const active = (await list(tx, scope, "knowledge_site_runs")).find(
        (r) =>
          data(r).sourceId === row.id &&
          ["queued", "running"].includes(data(r).status),
      );
      if (active) return { sourceId: row.id, run: active, started: false };
      if (d.site && d.site.rootUrl !== rootUrl)
        throw new DomainError("KNOWLEDGE_SITE_ROOT_CHANGED", 409);
      if (!d.site) {
        const documents = await tx.knowledgeDocument.count({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            sourceId: row.id,
            activeVersionId: { not: null },
          },
        });
        // Its documents belong to its old allowlist: a root outside it would
        // leave them active beside pages of another site.
        if (documents) {
          repoint = false;
          try {
            validatePublicUrl(rootUrl, {
              allowedOrigins: d.allowedOrigins ?? [],
              allowedPaths: d.allowedPaths ?? [],
              maxBytes: 1_000_000,
            });
          } catch {
            throw new DomainError("KNOWLEDGE_SITE_ROOT_CHANGED", 409);
          }
        }
      } else repoint = false;
      await applyRights(tx, scope, row.id, d, wanted, audiences);
      sourceId = row.id;
    } else {
      await refuseKnownSite(tx, scope, rootUrl);
      sourceId = (
        await create(tx, scope, "sources", {
          name: i.name ?? root.hostname,
          type: i.type ?? "website",
          status: "active",
          generation: 1,
          ...wanted,
          audiences,
          allowedOrigins: [root.origin],
          allowedPaths: [root.pathname.replace(/\/+$/, "") || "/"],
          language: i.language,
        })
      ).id;
    }
    const row = await siteSource(tx, scope, sourceId, { site: false });
    const d = data(row);
    const { syncEveryHours: _previous, ...rest } = d;
    await update(tx, scope, row, {
      ...rest,
      ...(i.name && existing ? { name: i.name } : {}),
      ...(i.type && existing ? { type: i.type } : {}),
      language: i.language,
      ...(repoint
        ? {
            allowedOrigins: [root.origin],
            allowedPaths: [root.pathname.replace(/\/+$/, "") || "/"],
          }
        : {}),
      ...(i.autoUpdate ? { syncEveryHours: 168 } : {}),
      site: {
        rootUrl,
        // An unfinished look at the site says nothing about how it is listed.
        discovery:
          found.complete === false && d.site?.discovery
            ? d.site.discovery
            : found.discovery,
        excludedPages: i.excludedPages,
        lastRunId: d.site?.lastRunId ?? null,
      },
    });
    const run = await startSiteRun(tx, scope, sourceId, "initial", pages);
    if (i.draftId) await replaceDraft(tx, scope, i.draftId);
    await audit(tx, scope, "knowledge.site_started", sourceId, {
      runId: run.id,
      created: !existing,
      pages: pages.length,
      excluded: i.excludedPages.length,
      autoUpdate: i.autoUpdate,
    });
    return { sourceId, run, started: true };
  });
}

/** Starts a manual run; its first batch discovers the pages. */
export async function refreshSite(scope: Scope, raw: unknown) {
  await owner(scope);
  const i = siteRefreshInput.parse(raw);
  return within(scope, async (tx) => {
    await lockKnowledge(tx, scope);
    const source = await siteSource(tx, scope, i.sourceId, { site: true });
    const d = data(source);
    if (d.status !== "active") throw unavailable(409);
    const run = await startSiteRun(tx, scope, source.id, "manual", []);
    // A run already active is returned as it is and is not a new start.
    if (run.id !== d.site.lastRunId)
      await audit(tx, scope, "knowledge.site_refreshed", source.id, {
        runId: run.id,
      });
    return run;
  });
}

/** Weekly updates on or off and the excluded pages; a running run reads them at each batch. */
export async function changeSiteSettings(scope: Scope, raw: unknown) {
  await owner(scope);
  const i = siteSettingsInput.parse(raw);
  return within(scope, async (tx) => {
    await lockKnowledge(tx, scope);
    const source = await siteSource(tx, scope, i.sourceId, { site: true });
    const d = data(source);
    if (d.status === "revoked") throw unavailable(409);
    if (i.excludedPages)
      for (const page of i.excludedPages) checkPage(d.site.rootUrl, page);
    const { syncEveryHours: _previous, ...rest } = d;
    const syncEveryHours =
      i.autoUpdate === undefined ? d.syncEveryHours : i.autoUpdate ? 168 : null;
    const row = await update(tx, scope, source, {
      ...rest,
      ...(syncEveryHours ? { syncEveryHours } : {}),
      site: {
        ...d.site,
        ...(i.excludedPages ? { excludedPages: i.excludedPages } : {}),
      },
    });
    await audit(tx, scope, "knowledge.site_settings_changed", source.id, {
      ...(i.autoUpdate === undefined ? {} : { autoUpdate: i.autoUpdate }),
      ...(i.excludedPages ? { excluded: i.excludedPages.length } : {}),
    });
    return row;
  });
}
