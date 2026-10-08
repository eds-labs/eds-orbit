import { z } from "zod";
import { createPostizClient } from "../../../../../packages/connectors/src/index.ts";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  decrypt,
  DomainError,
  list,
  update,
} from "../../shared.ts";
import { assignedPostizChannels } from "../postiz-assignment.ts";

/**
 * What was already posted on the assigned channels, read from Postiz so that
 * posts Orbit did not make (for example a ChatGPT job) count as well. Postiz
 * returns post text only, no media, and allows 30 public API requests per
 * hour and one request covers at most 32 days, so a sync is three requests
 * (60 days back in two windows, 14 days ahead) and runs at most hourly per
 * project. Published and queued posts are kept: a post already scheduled in
 * Postiz must not be repeated either. X itself is never read.
 */
export const CHANNEL_HISTORY_DAYS = 60;
export const CHANNEL_AHEAD_DAYS = 14;
export const CHANNEL_SYNC_INTERVAL_MS = 3_600_000;
const DAY = 86_400_000;
const MAX_TEXT = 5_000;
const EXCERPT = 500;
const PER_CHANNEL = 10;
const MAX_PER_CHANNEL = 20;
const TOOL_CHANNELS = 4;

export type ChannelPostSource = "orbit" | "external";
// Postiz states kept in the history; ERROR and DRAFT posts were never posted.
const KEPT_STATES = ["PUBLISHED", "QUEUE"];
export type ChannelPost = {
  channel: string;
  remoteId: string;
  // Publish date; the planned date while the post is still queued.
  publishedAt: string;
  state: string;
  text: string;
  source: ChannelPostSource;
  syncedAt: string;
};

type RemotePost = {
  id: string;
  state: string;
  publishDate: string;
  integration: { id: string };
  content?: string | null;
};
export type ChannelPostsClient = {
  listPosts(range: {
    startDate: string;
    endDate: string;
  }): Promise<RemotePost[]>;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Postiz keeps post text as HTML; the history stores it as plain text. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, code) => {
      const name = String(code).toLowerCase();
      if (name.startsWith("#")) {
        const point =
          name[1] === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        const valid =
          point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff);
        return valid ? String.fromCodePoint(point) : " ";
      }
      return ENTITIES[name] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

/**
 * Refreshes the channel history of one project: posts of the assigned
 * channels published within the last 60 days or queued for the next 14,
 * upserted per remote ID; a queued row Postiz no longer returns is removed.
 * A post whose remote ID belongs to an Orbit publication is `orbit`, any other
 * `external`. Skipped when the last attempt is under an hour old, unless
 * `force`; the attempt counts even when Postiz fails, so errors cannot burn
 * the hourly request budget.
 */
export async function syncChannelPosts(
  scope: Scope,
  client?: ChannelPostsClient,
  now = new Date(),
  options: { force?: boolean } = {},
): Promise<{ stored: number; skipped?: true }> {
  const claimed = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const connector = (await list(tx, scope, "connectors")).find(
        (row) =>
          data(row).provider === "postiz" &&
          ["read_verified", "write_verified"].includes(data(row).status),
      );
      if (!connector) return null;
      const channelIds = assignedPostizChannels(data(connector)).map(
        (channel: any) => channel.id as string,
      );
      if (!channelIds.length) return null;
      const marker = (await list(tx, scope, "channel_post_sync"))[0];
      const last = Date.parse(marker ? data(marker).attemptedAt : "");
      if (
        !options.force &&
        Number.isFinite(last) &&
        now.valueOf() - last < CHANNEL_SYNC_INTERVAL_MS
      )
        return null;
      const c = data(connector);
      if (!client && (!c.baseUrl || !c.encryptedCredential))
        throw new DomainError("POSTIZ_NOT_CONNECTED", 409);
      // Claim the attempt first so a slow Postiz read cannot start twice.
      const value = {
        ...(marker ? data(marker) : {}),
        attemptedAt: now.toISOString(),
        status: "running",
      };
      if (marker) await update(tx, scope, marker, value);
      else await create(tx, scope, "channel_post_sync", value);
      return {
        channelIds,
        baseUrl: c.baseUrl as string,
        encryptedCredential: c.encryptedCredential as string,
      };
    },
  );
  if (!claimed) return { stored: 0, skipped: true };
  const finish = (status: "ok" | "failed", stored: number) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const marker = (await list(tx, scope, "channel_post_sync"))[0];
      if (marker)
        await update(tx, scope, marker, {
          ...data(marker),
          status,
          storedCount: stored,
        });
    });
  const since = now.valueOf() - CHANNEL_HISTORY_DAYS * DAY;
  const until = now.valueOf() + CHANNEL_AHEAD_DAYS * DAY;
  // Each request stays within the connector's range cap (32 days).
  const windows = [
    [since, since + 30 * DAY],
    [since + 30 * DAY, now.valueOf()],
    [now.valueOf(), until],
  ] as const;
  const merged = new Map<string, RemotePost>();
  try {
    const source =
      client ??
      createPostizClient({
        baseUrl: claimed.baseUrl,
        token: decrypt(
          claimed.encryptedCredential,
          process.env.CREDENTIAL_KEY!,
        ),
      });
    for (const [from, to] of windows)
      for (const post of await source.listPosts({
        startDate: new Date(from).toISOString(),
        endDate: new Date(to).toISOString(),
      }))
        merged.set(post.id, post);
  } catch (error) {
    await finish("failed", 0);
    throw error;
  }
  const fresh = [...merged.values()].filter((post) => {
    const at = Date.parse(post.publishDate);
    return (
      KEPT_STATES.includes(post.state) &&
      claimed.channelIds.includes(post.integration.id) &&
      Number.isFinite(at) &&
      at >= since &&
      at <= until
    );
  });
  const returned = new Set(fresh.map((post) => post.id));
  const stored = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const orbitRemoteIds = new Set(
        (await list(tx, scope, "publications"))
          .map((row) => data(row).remoteId)
          .filter((remoteId) => typeof remoteId === "string"),
      );
      const existing = new Map(
        (await list(tx, scope, "channel_posts")).map((row) => [
          String(data(row).remoteId),
          row,
        ]),
      );
      for (const [remoteId, row] of existing)
        if (
          Date.parse(data(row).publishedAt) < since ||
          // A queued post that left the fetched range was deleted or failed.
          (data(row).state === "QUEUE" && !returned.has(remoteId))
        ) {
          await tx.entity.delete({ where: { id: row.id } });
          existing.delete(remoteId);
        }
      for (const post of fresh) {
        const value: ChannelPost = {
          channel: post.integration.id,
          remoteId: post.id,
          publishedAt: new Date(post.publishDate).toISOString(),
          state: post.state,
          text: htmlToText(post.content ?? ""),
          source: orbitRemoteIds.has(post.id) ? "orbit" : "external",
          syncedAt: now.toISOString(),
        };
        const row = existing.get(post.id);
        if (row) await update(tx, scope, row, value);
        else await create(tx, scope, "channel_posts", value);
      }
      return fresh.length;
    },
  );
  await finish("ok", stored);
  return { stored };
}

/** Last sync attempt of the project, for tools that show how fresh the history is. */
export async function lastChannelSync(tx: DbTx, scope: Scope) {
  const marker = (await list(tx, scope, "channel_post_sync"))[0];
  return marker ? ((data(marker).attemptedAt as string) ?? null) : null;
}

async function storedPosts(tx: DbTx, scope: Scope, sinceMs: number) {
  return (await list(tx, scope, "channel_posts"))
    .map((row) => data(row) as ChannelPost)
    .filter((post) => Date.parse(post.publishedAt) >= sinceMs);
}

/** The channel's stored posts (published or queued) within `windowDays` of a moment; used by the duplicate check. */
export async function channelPostsNear(
  tx: DbTx,
  scope: Scope,
  channel: string,
  at: number,
  windowDays: number,
) {
  return (await storedPosts(tx, scope, at - windowDays * DAY)).filter(
    (post) =>
      post.channel === channel &&
      Math.abs(Date.parse(post.publishedAt) - at) < windowDays * DAY,
  );
}

/**
 * Stored posts (published, and queued up to 14 days ahead) of the given
 * channels from the last `days` days, newest first, at most `perChannel`
 * each; for specialists whose context is embedded rather than fetched.
 */
export async function recentChannelPosts(
  tx: DbTx,
  scope: Scope,
  channels: string[],
  days: number,
  perChannel: number,
  now = Date.now(),
) {
  const byChannel = new Map<string, ChannelPost[]>(
    channels.map((channel) => [channel, []]),
  );
  for (const post of (await storedPosts(tx, scope, now - days * DAY)).sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  )) {
    const posts = byChannel.get(post.channel);
    if (posts && posts.length < perChannel) posts.push(post);
  }
  return byChannel;
}

/**
 * Posts of other origin for the copywriter, shaped like the other
 * `recentChannelPosts` entries. Orbit's own posts are left out because they
 * are already part of the content history.
 */
export async function externalChannelPosts(
  tx: DbTx,
  scope: Scope,
  channel: string,
  slot: number,
  windowDays = 7,
) {
  return (await channelPostsNear(tx, scope, channel, slot, windowDays))
    .filter((post) => post.source === "external" && post.text)
    .map((post) => ({
      at: Date.parse(post.publishedAt),
      title: "External post",
      claims: [post.text.slice(0, 280)],
    }));
}

export const channelHistoryInput = z
  .object({
    channels: z
      .array(z.string().trim().min(1).max(80))
      .max(TOOL_CHANNELS)
      .nullish(),
    perChannel: z.number().int().min(1).max(MAX_PER_CHANNEL).nullish(),
  })
  .strict();

/** Last posts per channel, newest first, with source and status: what was already posted or is queued. Reads stored rows only. */
export async function channelHistory(tx: DbTx, scope: Scope, raw: unknown) {
  const input = channelHistoryInput.parse(raw ?? {});
  const perChannel = input.perChannel ?? PER_CHANNEL;
  const byChannel = new Map<string, ChannelPost[]>();
  for (const post of (
    await storedPosts(tx, scope, Date.now() - CHANNEL_HISTORY_DAYS * DAY)
  ).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))) {
    if (input.channels && !input.channels.includes(post.channel)) continue;
    const posts = byChannel.get(post.channel) ?? [];
    if (posts.length < perChannel) posts.push(post);
    byChannel.set(post.channel, posts);
  }
  return {
    days: CHANNEL_HISTORY_DAYS,
    lastSyncAt: await lastChannelSync(tx, scope),
    channels: [...byChannel].map(([channelId, posts]) => ({
      channelId,
      posts: posts.map((post) => ({
        source: post.source,
        status: post.state === "QUEUE" ? "scheduled" : "published",
        publishedAt: post.publishedAt,
        text: post.text.slice(0, EXCERPT),
      })),
    })),
  };
}
