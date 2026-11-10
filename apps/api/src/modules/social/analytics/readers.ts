import { socialFetch } from "../accounts/http.ts";
import { META_GRAPH } from "../accounts/meta.ts";
import type { SocialPlatform } from "../accounts/store.ts";

// The public figures of published posts (ADR 0020, S8), read with the
// account's own token: Facebook reactions, comments and shares
// (pages_read_engagement), Instagram likes and comments (instagram_basic;
// reach and saves would need instagram_manage_insights), X public metrics.
// Telegram's Bot API has no figures for channel posts. A read that fails is
// null for that post and never throws: the next run tries again.

export type MetricValue = { metric: string; value: number };
export type MetricReads = { values: Map<string, MetricValue[] | null>; calls: number };

const X_TWEETS = "https://api.x.com/2/tweets";
const X_BATCH = 100;
const FACEBOOK_FIELDS = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
const INSTAGRAM_FIELDS = "like_count,comments_count";
// Short: a run stops starting calls after its time budget (collect.ts).
const TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const summary = (value: unknown) => count((value as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);

async function getJson(url: string, token: string): Promise<Json | null> {
  try {
    const response = await socialFetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Json | null;
    return body && typeof body === "object" && !("error" in body) ? body : null;
  } catch {
    return null;
  }
}

/** No call starts at or after the deadline; posts not tried get no entry. */
const pastDeadline = (deadline?: number) => deadline !== undefined && Date.now() >= deadline;

async function graphReads(
  token: string,
  ids: string[],
  fields: string,
  map: (body: Json) => MetricValue[],
  deadline?: number,
): Promise<MetricReads> {
  const values = new Map<string, MetricValue[] | null>();
  let calls = 0;
  for (const id of ids) {
    if (pastDeadline(deadline)) break;
    calls++;
    const body = await getJson(`${META_GRAPH}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`, token);
    values.set(id, body ? map(body) : null);
  }
  return { values, calls };
}

async function xReads(token: string, ids: string[], deadline?: number): Promise<MetricReads> {
  const values = new Map<string, MetricValue[] | null>();
  let calls = 0;
  for (let i = 0; i < ids.length; i += X_BATCH) {
    if (pastDeadline(deadline)) break;
    const batch = ids.slice(i, i + X_BATCH);
    calls++;
    const body = await getJson(`${X_TWEETS}?ids=${batch.map(encodeURIComponent).join(",")}&tweet.fields=public_metrics`, token);
    const entries = (Array.isArray(body?.data) ? (body.data as unknown[]) : []).filter(
      (t): t is Json => typeof t === "object" && t !== null,
    );
    const found = new Map(entries.map((t) => [String(t.id), (t.public_metrics ?? {}) as Json]));
    for (const id of batch) {
      const m = found.get(id);
      values.set(
        id,
        m
          ? [
              { metric: "likes", value: count(m.like_count) },
              { metric: "reposts", value: count(m.retweet_count) },
              { metric: "replies", value: count(m.reply_count) },
              { metric: "quotes", value: count(m.quote_count) },
              { metric: "impressions", value: count(m.impression_count) },
              { metric: "bookmarks", value: count(m.bookmark_count) },
            ]
          : null,
      );
    }
  }
  return { values, calls };
}

/** The current figures of the account's posts, by their platform ids. */
export async function readMetrics(
  credentials: { platform: SocialPlatform; accessToken: string },
  externalIds: string[],
  options: { deadline?: number } = {},
): Promise<MetricReads> {
  const token = credentials.accessToken;
  const { deadline } = options;
  switch (credentials.platform) {
    case "facebook":
      return graphReads(token, externalIds, FACEBOOK_FIELDS, (b) => [
        { metric: "reactions", value: summary(b.reactions) },
        { metric: "comments", value: summary(b.comments) },
        { metric: "shares", value: count((b.shares as { count?: unknown } | undefined)?.count) },
      ], deadline);
    case "instagram":
      return graphReads(token, externalIds, INSTAGRAM_FIELDS, (b) => [
        { metric: "likes", value: count(b.like_count) },
        { metric: "comments", value: count(b.comments_count) },
      ], deadline);
    case "x":
      return xReads(token, externalIds, deadline);
    case "telegram":
      return { values: new Map(), calls: 0 };
  }
}
