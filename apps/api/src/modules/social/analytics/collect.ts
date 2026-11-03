import { randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { accountCredentials } from "../accounts/vault.ts";
import { socialActive } from "../gate.ts";
import { readSocialSettings } from "../settings.ts";
import { readMetrics } from "./readers.ts";

// Collecting post figures (ADR 0020, S8): every six hours the periodic task
// reads the public figures of live publications at most 30 days old, at
// most 50 provider calls per project and run, least recently read first.
// X bills its reads, so X figures are read only when the owner switched on
// `xMetrics`, and at most once a day. Every attempt leaves an `orbit_read`
// row (1 read, 0 failed, also when the account's credentials fail), so a
// post that fails does not starve the others or bring the run straight back.
// Runs are at least five minutes apart and stop starting calls after 30 s,
// so a large backlog is read in paced batches and never holds the project.

const EVERY_MS = 6 * 3_600_000;
const X_EVERY_MS = 24 * 3_600_000;
const WINDOW_MS = 30 * 86_400_000;
const CALLS_PER_RUN = 50;
const X_BATCH = 100;
const PACE_MS = 5 * 60_000;
const RUN_BUDGET_MS = 30_000;
// Metric names start with a letter (database check).
const READ_MARK = "orbit_read";

type Candidate = {
  publicationId: string;
  accountId: string;
  platform: SocialPlatform;
  externalPostId: string;
  publishedAt: Date;
  lastRead: Date | null;
};

async function candidates(tx: DbTx, scope: Scope, now: Date): Promise<Candidate[]> {
  const { settings } = await readSocialSettings(tx, scope);
  const publications = await tx.socialPublication.findMany({
    where: {
      projectId: scope.projectId,
      status: "published",
      externalPostId: { not: null },
      // History mirrored from Postiz (S10) carries no platform id.
      legacyEntityId: null,
      publishedAt: { gte: new Date(now.getTime() - WINDOW_MS) },
    },
    select: { id: true, accountId: true, externalPostId: true, publishedAt: true, providerState: true },
  });
  // Test publications reached no platform.
  const live = publications.filter((p) => (p.providerState as { test?: boolean } | null)?.test !== true);
  if (!live.length) return [];
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: [...new Set(live.map((p) => p.accountId))] }, status: "active" },
    select: { id: true, platform: true },
  });
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform as SocialPlatform]));
  const reads = await tx.socialMetricSnapshot.groupBy({
    by: ["publicationId"],
    where: { projectId: scope.projectId, publicationId: { in: live.map((p) => p.id) }, metric: READ_MARK, period: "lifetime" },
    _max: { observedAt: true },
  });
  const lastReadOf = new Map(reads.map((r) => [r.publicationId, r._max.observedAt]));
  return live.flatMap((p) => {
    const platform = platformOf.get(p.accountId);
    // Telegram's Bot API has no figures for channel posts.
    if (!platform || platform === "telegram") return [];
    if (platform === "x" && !settings.xMetrics) return [];
    return [
      {
        publicationId: p.id,
        accountId: p.accountId,
        platform,
        externalPostId: p.externalPostId!,
        publishedAt: p.publishedAt!,
        lastRead: lastReadOf.get(p.id) ?? null,
      },
    ];
  });
}

const dueAt = (c: Candidate) =>
  new Date((c.lastRead ?? c.publishedAt).getTime() + (c.platform === "x" ? X_EVERY_MS : EVERY_MS));

/** The due candidates that fit into one run's calls, least recently read first. */
function pick(due: Candidate[]): Candidate[] {
  const ordered = [...due].sort(
    (a, b) => (a.lastRead?.getTime() ?? 0) - (b.lastRead?.getTime() ?? 0) || a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
  const picked: Candidate[] = [];
  const xPicks = new Map<string, number>();
  let calls = 0;
  for (const c of ordered) {
    // X reads up to 100 posts of an account in one call.
    const n = xPicks.get(c.accountId) ?? 0;
    const cost = c.platform === "x" ? (n % X_BATCH === 0 ? 1 : 0) : 1;
    if (calls + cost > CALLS_PER_RUN) continue;
    calls += cost;
    if (c.platform === "x") xPicks.set(c.accountId, n + 1);
    picked.push(c);
  }
  return picked;
}

/** The earliest time the next run may start: the first due post, but never sooner than PACE_MS after the last one. */
function nextRunAt(all: Candidate[]): Date | null {
  if (!all.length) return null;
  const firstDue = Math.min(...all.map((c) => dueAt(c).getTime()));
  const lastRun = Math.max(0, ...all.map((c) => c.lastRead?.getTime() ?? 0));
  return new Date(Math.max(firstDue, lastRun ? lastRun + PACE_MS : 0));
}

type SnapshotRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  publicationId: string;
  metric: string;
  value: number;
  unit: string | null;
  period: string;
  observedAt: Date;
};

export const socialMetrics: PeriodicTask = {
  name: "social-metrics",
  async nextDueAt(tx, scope) {
    if (!(await socialActive(tx, scope))) return null;
    return nextRunAt(await candidates(tx, scope, new Date()));
  },
  async run(scope) {
    const now = new Date();
    const all = await scoped(scope.workspaceId, scope.projectId, async (tx) =>
      (await socialActive(tx, scope)) ? candidates(tx, scope, now) : [],
    );
    const next = nextRunAt(all);
    if (!next || next.getTime() > now.getTime()) return { status: "nothing due" };
    const due = all.filter((c) => dueAt(c).getTime() <= now.getTime());
    const picked = pick(due);
    const byAccount = new Map<string, Candidate[]>();
    for (const c of picked) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
    const deadline = now.getTime() + RUN_BUDGET_MS;
    const base = (c: Candidate) => ({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      publicationId: c.publicationId,
      period: "lifetime",
      observedAt: now,
    });
    const marker = (c: Candidate, ok: boolean): SnapshotRow => ({ ...base(c), id: randomUUID(), metric: READ_MARK, value: ok ? 1 : 0, unit: null });
    const save = (rows: SnapshotRow[]) =>
      rows.length ? scoped(scope.workspaceId, scope.projectId, (tx) => tx.socialMetricSnapshot.createMany({ data: rows })) : null;
    let read = 0;
    let failed = 0;
    for (const [accountId, items] of byAccount) {
      let rows: SnapshotRow[];
      try {
        const credentials = await accountCredentials(scope, accountId);
        const result = await readMetrics(credentials, items.map((c) => c.externalPostId), { deadline });
        // A post the deadline left out was not tried: no marker, it stays due.
        rows = items.flatMap((c) => {
          if (!result.values.has(c.externalPostId)) return [];
          const values = result.values.get(c.externalPostId) ?? null;
          if (values) read++;
          else failed++;
          return [
            marker(c, values !== null),
            ...(values ?? []).map((v) => ({ ...base(c), id: randomUUID(), metric: v.metric, value: v.value, unit: "count" })),
          ];
        });
      } catch {
        // Credentials that cannot be read (a reconnect is the health task's
        // business) still mark the posts as tried: no run comes straight back.
        failed += items.length;
        rows = items.map((c) => marker(c, false));
      }
      try {
        await save(rows);
      } catch {
        // The figures could not be stored: keep at least the attempt.
        await save(rows.filter((r) => r.metric === READ_MARK).map((r) => ({ ...r, value: 0 })))?.catch(() => null);
      }
    }
    return { status: `read ${read}, failed ${failed}, left ${due.length - read - failed}` };
  },
};

export type PostMetrics = {
  postId: string;
  publications: Array<{
    publicationId: string;
    accountId: string;
    platform: SocialPlatform;
    /** False where the platform offers no figures (Telegram). */
    available: boolean;
    observedAt: string | null;
    metrics: Record<string, number>;
  }>;
};

/** The latest figures of the posts' published publications (also for Marketing, S9). */
export async function postMetrics(tx: DbTx, scope: Scope, postIds: string[]): Promise<PostMetrics[]> {
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, postId: { in: postIds } },
    select: { id: true, postId: true },
  });
  const postOf = new Map(variants.map((v) => [v.id, v.postId]));
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) }, status: "published" },
    select: { id: true, variantId: true, accountId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: [...new Set(publications.map((p) => p.accountId))] } },
    select: { id: true, platform: true },
  });
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform as SocialPlatform]));
  // Only the latest successful read of each publication, not its history.
  const reads = await tx.socialMetricSnapshot.groupBy({
    by: ["publicationId"],
    where: { projectId: scope.projectId, publicationId: { in: publications.map((p) => p.id) }, metric: READ_MARK, value: 1 },
    _max: { observedAt: true },
  });
  const snapshots = reads.length
    ? await tx.socialMetricSnapshot.findMany({
        where: {
          projectId: scope.projectId,
          NOT: { metric: READ_MARK },
          OR: reads.map((r) => ({ publicationId: r.publicationId, observedAt: r._max.observedAt! })),
        },
        select: { publicationId: true, metric: true, value: true, observedAt: true },
      })
    : [];
  const latest = new Map<string, { observedAt: Date; metrics: Record<string, number> }>();
  for (const s of snapshots) {
    const entry = latest.get(s.publicationId) ?? { observedAt: s.observedAt, metrics: {} };
    entry.metrics[s.metric] = Number(s.value);
    latest.set(s.publicationId, entry);
  }
  return postIds
    .filter((id) => variants.some((v) => v.postId === id))
    .map((postId) => ({
      postId,
      publications: publications
        .filter((p) => postOf.get(p.variantId) === postId)
        .map((p) => {
          const platform = platformOf.get(p.accountId)!;
          const found = latest.get(p.id);
          return {
            publicationId: p.id,
            accountId: p.accountId,
            platform,
            available: platform !== "telegram",
            observedAt: found?.observedAt.toISOString() ?? null,
            metrics: found?.metrics ?? {},
          };
        }),
    }));
}

const RECENT_POSTS = 100;

/** The posts published in the last `days` days (at most 30), newest first, with their latest figures. */
export async function recentPostMetrics(tx: DbTx, scope: Scope, days: number) {
  const since = new Date(Date.now() - Math.min(days, 30) * 86_400_000);
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, status: "published", publishedAt: { gte: since } },
    select: { variantId: true, publishedAt: true },
    orderBy: { publishedAt: "desc" },
  });
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, id: { in: [...new Set(publications.map((p) => p.variantId))] } },
    select: { id: true, postId: true },
  });
  const postOf = new Map(variants.map((v) => [v.id, v.postId]));
  const firstPublished = new Map<string, Date>();
  for (const p of publications) {
    const postId = postOf.get(p.variantId);
    if (postId && !firstPublished.has(postId)) firstPublished.set(postId, p.publishedAt!);
  }
  const postIds = [...firstPublished.keys()].slice(0, RECENT_POSTS);
  const posts = await tx.socialPost.findMany({
    where: { projectId: scope.projectId, id: { in: postIds } },
    select: { id: true, title: true, baseText: true },
  });
  const postById = new Map(posts.map((p) => [p.id, p]));
  const metrics = new Map((await postMetrics(tx, scope, postIds)).map((m) => [m.postId, m.publications]));
  return {
    items: postIds.map((postId) => ({
      postId,
      title: postById.get(postId)?.title ?? null,
      excerpt: (postById.get(postId)?.baseText ?? "").slice(0, 120),
      publishedAt: firstPublished.get(postId)!.toISOString(),
      publications: metrics.get(postId) ?? [],
    })),
  };
}
