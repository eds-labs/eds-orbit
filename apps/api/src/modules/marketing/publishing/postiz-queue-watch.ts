import { createPostizClient } from "../../../../../../packages/connectors/src/index.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  exception,
  list,
  update,
} from "../../../shared.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";
import {
  connectionVerified,
  connectionAccess,
} from "../../../platform/connections/connections.ts";
import { publishingBackend } from "./backend.ts";
import { postizBacklog } from "./social-migration.ts";

/**
 * Detects a Postiz instance that accepts posts but no longer sends them (for
 * example a hung orchestrator): scheduled posts of the project's assigned
 * channels stay in QUEUE past their publish date. Read-only; the Postiz
 * public API allows only a few calls per hour, so the check is spaced.
 */
export const POSTIZ_QUEUE_CHECK_MS = 10 * 60_000;
export const POSTIZ_QUEUE_OVERDUE_MS = 15 * 60_000;
const LOOKBACK_MS = 7 * 86_400_000;
// A project result older than three check intervals no longer counts.
const HEALTH_MAX_AGE_MS = 3 * POSTIZ_QUEUE_CHECK_MS;
/** The resolution of queue notices closed because the project publishes through Social. */
export const POSTIZ_QUEUE_RETIRED = "publishing_backend_social";

export type PostizQueueStatus = "ok" | "stalled" | "unavailable";
type RemotePost = {
  id: string;
  state: string;
  publishDate: string;
  integration: { id: string };
};

const NOTICES = {
  POSTIZ_QUEUE_STALLED: {
    title: "Postiz is not sending scheduled posts",
    message:
      "At least one scheduled post of an assigned channel is more than 15 minutes overdue in the Postiz queue. Check the Postiz orchestrator (pm2 logs orchestrator) and restart it if it shows no startup lines. This notice closes itself once the queue moves again.",
  },
  POSTIZ_QUEUE_CHECK_FAILED: {
    title: "Orbit cannot read the Postiz queue",
    message:
      "The scheduled Postiz queue check failed. Check that Postiz is reachable and the connector token is valid. This notice closes itself after the next successful check.",
  },
} as const;
type NoticeCode = keyof typeof NOTICES;

export function overduePostizPosts(
  posts: RemotePost[],
  channelIds: string[],
  now: Date,
) {
  const cutoff = now.valueOf() - POSTIZ_QUEUE_OVERDUE_MS;
  return posts.filter((post) => {
    const at = Date.parse(post.publishDate);
    return (
      post.state === "QUEUE" &&
      channelIds.includes(post.integration.id) &&
      Number.isFinite(at) &&
      at <= cutoff
    );
  });
}

/** Public state across projects: stalled wins, otherwise ok once any fresh check passed. */
export function postizQueueHealth(
  entries: Record<string, string>,
  now: Date,
): "ok" | "stalled" | "unknown" {
  const fresh = Object.values(entries).flatMap((raw) => {
    try {
      const value = JSON.parse(raw);
      const at = Date.parse(value.checkedAt);
      return Number.isFinite(at) && now.valueOf() - at <= HEALTH_MAX_AGE_MS
        ? [value.status as string]
        : [];
    } catch {
      return [];
    }
  });
  if (fresh.includes("stalled")) return "stalled";
  return fresh.includes("ok") ? "ok" : "unknown";
}

/**
 * True when the project publishes through Social and Postiz holds nothing
 * of it any more: there is no Postiz queue of this project left to watch.
 * With a backlog, while draining and on Postiz the watch keeps running.
 */
async function retiredOnSocial(tx: DbTx, scope: Scope) {
  return (
    (await publishingBackend(tx, scope)) === "social" &&
    (await postizBacklog(tx, scope)) === 0
  );
}

/** The project's watch: its verified Postiz connector and assigned channels, unless retired on Social. */
async function watchedConnector(tx: DbTx, scope: Scope) {
  return (await retiredOnSocial(tx, scope))
    ? null
    : verifiedConnectorChannels(tx, scope);
}

async function verifiedConnectorChannels(tx: DbTx, scope: Scope) {
  const connector = (await list(tx, scope, "connectors")).find(
    (row) =>
      data(row).provider === "postiz" && connectionVerified(data(row).status),
  );
  if (!connector) return null;
  const channelIds = assignedPostizChannels(data(connector)).map(
    (channel: any) => channel.id as string,
  );
  return channelIds.length ? { connector, channelIds } : null;
}

/** When the project next needs a queue check; null when no Postiz channel is assigned or the watch retired on Social. */
export async function nextPostizQueueCheckAt(tx: DbTx, scope: Scope) {
  if (!(await watchedConnector(tx, scope))) return null;
  const watch = (await list(tx, scope, "postiz_queue_watch"))[0];
  const last = Date.parse(watch ? data(watch).checkedAt : "");
  return Number.isFinite(last) ? new Date(last + POSTIZ_QUEUE_CHECK_MS) : null;
}

async function closeNotice(tx: DbTx, scope: Scope, code: NoticeCode) {
  for (const row of await list(tx, scope, "exceptions"))
    if (data(row).code === code && data(row).status === "open")
      await update(tx, scope, row, {
        ...data(row),
        status: "resolved",
        resolvedBy: "worker",
        resolvedAt: new Date().toISOString(),
      });
}

/**
 * Closes the project's open queue notices once nobody watches the queue
 * any more (the project moved to Social): a stopped check never closes
 * them itself. Resolved with who, when and why, never deleted, and one
 * audit event per notice. Writes nothing when no notice is open, so a
 * worker pass after that changes nothing. Returns how many it closed.
 */
export async function resolvePostizQueueNotices(
  tx: DbTx,
  scope: Scope,
  reason: string,
): Promise<number> {
  const open = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "exceptions",
        data: { path: ["status"], equals: "open" },
      },
    })
  ).filter((row) => String(data(row).code).startsWith("POSTIZ_QUEUE_"));
  for (const row of open) {
    const notice = data(row);
    await update(tx, scope, row, {
      ...notice,
      status: "resolved",
      resolvedBy: scope.userId,
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    });
    await audit(tx, scope, "marketing.postiz_queue_notice_resolved", row.id, {
      code: notice.code,
      count: notice.count ?? 1,
      reason,
    });
  }
  return open.length;
}

async function openNotice(
  tx: DbTx,
  scope: Scope,
  code: NoticeCode,
  resourceId: string,
) {
  const row = await exception(tx, scope, code, resourceId);
  if (data(row).title !== NOTICES[code].title)
    await update(tx, scope, row, { ...data(row), ...NOTICES[code] });
}

/** Worker entry: runs a due check for one project; failures are recorded, never thrown. */
export async function checkPostizQueue(
  scope: Scope,
  now = new Date(),
  deps: {
    createClient: (options: { baseUrl: string; token: string }) => {
      listPosts(range: {
        startDate: string;
        endDate: string;
      }): Promise<RemotePost[]>;
    };
  } = { createClient: createPostizClient },
): Promise<
  | { checked: false }
  | { checked: true; status: PostizQueueStatus; overdue: number }
> {
  const due = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (await retiredOnSocial(tx, scope)) {
      // The watch stopped for good: what it left open is closed here.
      await resolvePostizQueueNotices(tx, scope, POSTIZ_QUEUE_RETIRED);
      return null;
    }
    const watched = await verifiedConnectorChannels(tx, scope);
    if (!watched) return null;
    const watch = (await list(tx, scope, "postiz_queue_watch"))[0];
    const last = Date.parse(watch ? data(watch).checkedAt : "");
    if (Number.isFinite(last) && now.valueOf() - last < POSTIZ_QUEUE_CHECK_MS)
      return null;
    // Claim the check first so a slow Postiz read cannot start twice.
    const claimed = {
      ...(watch ? data(watch) : {}),
      checkedAt: now.toISOString(),
    };
    const row = watch
      ? await update(tx, scope, watch, claimed)
      : await create(tx, scope, "postiz_queue_watch", claimed);
    const c = data(watched.connector);
    return {
      watchId: row.id,
      connectorId: watched.connector.id,
      channelIds: watched.channelIds,
      ...(await connectionAccess(tx, scope, c)),
    };
  });
  if (!due) return { checked: false };
  let status: PostizQueueStatus, overdue: RemotePost[];
  try {
    const posts = await deps
      .createClient({
        baseUrl: due.baseUrl as string,
        token: due.credential,
      })
      .listPosts({
        startDate: new Date(now.valueOf() - LOOKBACK_MS).toISOString(),
        endDate: now.toISOString(),
      });
    overdue = overduePostizPosts(posts, due.channelIds, now);
    status = overdue.length ? "stalled" : "ok";
  } catch {
    status = "unavailable";
    overdue = [];
  }
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const watch = (await list(tx, scope, "postiz_queue_watch")).find(
      (row) => row.id === due.watchId,
    );
    if (watch)
      await update(tx, scope, watch, {
        ...data(watch),
        status,
        overdueCount: overdue.length,
        oldestOverdueAt:
          overdue.map((post) => post.publishDate).sort()[0] ?? null,
      });
    if (status === "unavailable")
      await openNotice(tx, scope, "POSTIZ_QUEUE_CHECK_FAILED", due.connectorId);
    else await closeNotice(tx, scope, "POSTIZ_QUEUE_CHECK_FAILED");
    if (status === "stalled")
      await openNotice(tx, scope, "POSTIZ_QUEUE_STALLED", due.connectorId);
    else if (status === "ok")
      await closeNotice(tx, scope, "POSTIZ_QUEUE_STALLED");
  });
  return { checked: true, status, overdue: overdue.length };
}
