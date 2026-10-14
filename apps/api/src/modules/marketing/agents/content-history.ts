import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, list } from "../../shared.ts";

/**
 * What the project recently drafted or published per channel, so the operator
 * can avoid repeating itself. Read-only and bounded; archived and replaced
 * drafts are left out.
 */
const PER_CHANNEL = 5;
const EXCERPT_CHARACTERS = 280;
const SCAN_LIMIT = 300;

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
};

function originOf(
  mission: Record<string, any> | undefined,
): HistoryItem["origin"] {
  if (!mission) return "manual";
  if (mission.packageId) return "package";
  if (mission.autopilot === true) return "autopilot";
  if (mission.chatProposalId) return "chat";
  return "mission";
}

export async function recentContent(tx: DbTx, scope: Scope, raw: unknown) {
  const input = contentHistoryInput.parse(raw);
  const days = input.days ?? 14;
  const since = new Date(Date.now() - days * 86400000);
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: SCAN_LIMIT,
  });
  const missions = new Map(
    (await list(tx, scope, "missions")).map((row) => [row.id, data(row)]),
  );
  const publications = new Map<string, Record<string, any>>();
  for (const row of await list(tx, scope, "publications"))
    if (!publications.has(data(row).contentId))
      publications.set(data(row).contentId, data(row));
  const byChannel = new Map<string, HistoryItem[]>();
  let truncated = rows.length === SCAN_LIMIT;
  for (const row of rows) {
    const d = data(row);
    if (d.status === "archived" || d.supersededBy) continue;
    const channel = String(d.channel ?? "");
    if (!channel) continue;
    if (input.channels && !input.channels.includes(channel)) continue;
    const items = byChannel.get(channel) ?? [];
    if (items.length >= PER_CHANNEL) {
      truncated = true;
      continue;
    }
    const publication = publications.get(row.id);
    items.push({
      contentId: row.id,
      title: String(d.title ?? ""),
      excerpt: String(d.body ?? "").slice(0, EXCERPT_CHARACTERS),
      status: String(d.status ?? ""),
      origin: originOf(missions.get(d.missionId)),
      createdAt: row.createdAt.toISOString(),
      scheduledAt: d.scheduledAt ?? null,
      publication: publication
        ? {
            status: publication.status,
            scheduledAt: publication.scheduledAt ?? null,
          }
        : null,
    });
    byChannel.set(channel, items);
  }
  return {
    days,
    since: since.toISOString(),
    truncated,
    channels: [...byChannel].map(([channelId, items]) => ({
      channelId,
      items,
    })),
  };
}
