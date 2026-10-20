import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { marketingHistory } from "./novelty.ts";

/**
 * What the project recently drafted or published per channel, so the operator
 * can avoid repeating itself. Read-only and bounded; archived and replaced
 * drafts are left out.
 */
const PER_CHANNEL = 5;

export const contentHistoryInput = z
  .object({
    channels: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
    days: z.number().int().min(1).max(60).optional(),
  })
  .strict();

export type HistoryItem = {
  contentId: string;
  title: string;
  excerpt: string;
  status: string;
  origin: "package" | "autopilot" | "chat" | "mission" | "manual";
  createdAt: string;
  scheduledAt: string | null;
  publication: { status: string; scheduledAt: string | null } | null;
  withheld?: "evidence_or_model_use";
};

export async function recentContent(tx: DbTx, scope: Scope, raw: unknown) {
  const input = contentHistoryInput.parse(raw);
  const shared = await marketingHistory(
    tx,
    scope,
    input.channels ?? [],
    new Date(),
    input.days ?? 14,
  );
  const byChannel = new Map<string, HistoryItem[]>();
  let truncated = shared.truncated;
  for (const item of shared.items.filter((i) => i.recordKind === "content")) {
    const items = byChannel.get(item.channel) ?? [];
    if (items.length >= PER_CHANNEL) {
      truncated = true;
      continue;
    }
    items.push({
      contentId: item.id,
      ...(item.withheld ? { withheld: item.withheld } : {}),
      title: item.title,
      excerpt: item.text,
      status: item.status,
      origin: item.origin,
      createdAt: item.createdAt,
      scheduledAt: item.at === item.createdAt ? null : item.at,
      publication: item.publication,
    });
    byChannel.set(item.channel, items);
  }
  const result = {
    days: shared.days,
    since: shared.since,
    truncated,
    coverage: shared.remote,
    reservations: shared.items
      .filter((i) => i.source === "reservation")
      .map((i) => ({ channel: i.channel, topic: i.topic })),
    external: shared.items
      .filter((i) => i.recordKind === "channel_posts")
      .map((i) => ({
        channel: i.channel,
        source: i.source,
        status: i.status,
        excerpt: i.text,
        at: i.at,
      })),
    channels: [...byChannel].map(([channelId, items]) => ({
      channelId,
      items,
    })),
  };
  // Tool output stays valid JSON within the host's 12 KB response bound.
  while (Buffer.byteLength(JSON.stringify(result)) > 11500) {
    const largest = [...result.channels].sort(
      (a, b) => b.items.length - a.items.length,
    )[0];
    if (largest?.items.length) largest.items.pop();
    else if (result.external.length) result.external.pop();
    else if (result.reservations.length) result.reservations.pop();
    else break;
    result.truncated = true;
  }
  return result;
}
