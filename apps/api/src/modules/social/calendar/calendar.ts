import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { approvalStates, postFilters, type ApprovalState, type PostView } from "../posts/posts.ts";

// The calendar (ADR 0020 §6.2, S6): the posts timed in a range of at most
// 62 days, in time order, with what a calendar cell shows: accounts,
// approval and a summary of their publications. Unplanned drafts have no
// time and stay in Social → Posts.

export type CalendarItem = {
  id: string;
  projectId: string;
  title: string | null;
  excerpt: string;
  status: string;
  origin: string;
  readOnly: boolean;
  schedule: PostView["schedule"];
  approvalState: ApprovalState;
  version: number;
  accounts: Array<{ accountId: string; platform: SocialPlatform; handle: string }>;
  publications: { total: number; published: number; failed: number; unknown: number; test: boolean };
};

const RANGE_MS = 62 * 86_400_000;
export const CALENDAR_LIMIT = 500;
const STATUSES = ["draft", "needs_approval", "approved", "scheduled", "publishing", "published", "partially_published", "failed", "canceled", "archived"];

const query = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    statuses: z.string().max(200).optional(),
    accountIds: z.string().max(2000).optional(),
    platforms: z.string().max(200).optional(),
    origins: z.string().max(200).optional(),
  })
  .passthrough();

/** The checked range of a calendar request. */
export function calendarRange(q: { from: string; to: string }) {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to <= from) throw new DomainError("SOCIAL_RANGE_INVALID", 422);
  if (to.getTime() - from.getTime() > RANGE_MS) throw new DomainError("SOCIAL_RANGE_TOO_LARGE", 422);
  return { from, to };
}

export async function calendarItems(tx: DbTx, scope: Scope, raw: unknown, limit = CALENDAR_LIMIT): Promise<{ items: CalendarItem[]; truncated: boolean }> {
  const q = query.parse(raw);
  const { from, to } = calendarRange(q);
  const statuses = q.statuses ? q.statuses.split(",").filter((s) => STATUSES.includes(s)) : null;
  const rows = await tx.socialPost.findMany({
    where: {
      projectId: scope.projectId,
      scheduleMode: "at",
      scheduledAt: { gte: from, lt: to },
      status: statuses ? { in: statuses } : { not: "archived" },
      ...(await postFilters(tx, scope, q)),
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const posts = rows.slice(0, limit);
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, postId: { in: posts.map((p) => p.id) } },
    select: { id: true, postId: true, accountId: true },
    orderBy: { createdAt: "asc" },
  });
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: [...new Set(variants.map((v) => v.accountId))] } },
  });
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
    select: { variantId: true, status: true, providerState: true },
  });
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const postOfVariant = new Map(variants.map((v) => [v.id, v.postId]));
  const state = await approvalStates(tx, scope, posts);
  return {
    truncated: rows.length > limit,
    items: posts.map((post) => {
      const own = publications.filter((p) => postOfVariant.get(p.variantId) === post.id);
      return {
        id: post.id,
        projectId: post.projectId,
        title: post.title,
        excerpt: [...post.baseText].slice(0, 140).join(""),
        status: post.status,
        origin: post.origin,
        readOnly: post.readOnly,
        schedule: {
          mode: post.scheduleMode as PostView["schedule"]["mode"],
          at: post.scheduledAt?.toISOString() ?? null,
          local: post.scheduleLocal,
          timeZone: post.scheduleTimezone,
          fold: post.scheduleFold as PostView["schedule"]["fold"],
        },
        approvalState: state(post),
        version: post.version,
        accounts: variants
          .filter((v) => v.postId === post.id)
          .flatMap((v) => {
            const a = accountOf.get(v.accountId);
            return a ? [{ accountId: a.id, platform: a.platform as SocialPlatform, handle: a.handle }] : [];
          }),
        publications: {
          total: own.length,
          published: own.filter((p) => p.status === "published").length,
          failed: own.filter((p) => p.status === "failed").length,
          unknown: own.filter((p) => p.status === "outcome_unknown").length,
          test: own.length > 0 && own.every((p) => (p.providerState as { test?: unknown } | null)?.test === true),
        },
      };
    }),
  };
}
