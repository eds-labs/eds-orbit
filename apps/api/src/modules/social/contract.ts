import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { localOf } from "../../platform/time/zoned-time.ts";
import { DomainError } from "../../shared.ts";
import type { SocialPlatform } from "./accounts/store.ts";
import { postMetrics } from "./analytics/collect.ts";
import { validationContext } from "./dispatch/gates.ts";
import { socialActive } from "./gate.ts";
import { uploadMedia } from "./media/library.ts";
import { approveOriginPost } from "./posts/approval.ts";
import { createPost } from "./posts/posts.ts";
import { validateVariant } from "./posts/validation.ts";

// What other modules may use of Social (ADR 0020 §6.4, S9). This file is
// the only one Marketing may import from the social module (boundary zone
// module:social-contract). Marketing keeps its channels (Postiz
// integration ids, mapped to accounts by `legacyPostizIntegrationId`, or
// `social:<accountId>`), its approvals and its veto window; at the slot it
// hands a post over as an origin-authorized post that Social sends at once,
// or it leaves a timed draft for a human.

export { postMetrics };

export type OriginRef = { module: "marketing"; type: string; id: string; version: number };
export type SocialAccountRef = {
  accountId: string;
  platform: SocialPlatform;
  handle: string;
  version: number;
  capability: string;
  status: string;
};

const SOCIAL_CHANNEL = /^social:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Whether the project can publish through Social now (switch and module). */
export function socialPublishingAvailable(tx: DbTx, scope: Scope): Promise<boolean> {
  return socialActive(tx, scope);
}

/** The project's account behind a Marketing channel reference, or null. */
export async function accountForChannel(tx: DbTx, scope: Scope, channel: string): Promise<SocialAccountRef | null> {
  const direct = SOCIAL_CHANNEL.exec(channel);
  const row = await tx.socialAccount.findFirst({
    where: { projectId: scope.projectId, ...(direct ? { id: direct[1]!.toLowerCase() } : { legacyPostizIntegrationId: channel }) },
  });
  return row
    ? {
        accountId: row.id,
        platform: row.platform as SocialPlatform,
        handle: row.handle,
        version: row.version,
        capability: row.capability,
        status: row.status,
      }
    : null;
}

/**
 * What would keep a post with this text from going out on the channel now:
 * the module, the mapping, the account and Social's rules (text, live
 * gates). Images are checked when the post is created.
 */
export async function publishingBlockers(tx: DbTx, scope: Scope, channel: string, input: { text: string }): Promise<string[]> {
  if (!(await socialActive(tx, scope))) return ["SOCIAL_DISABLED"];
  const account = await accountForChannel(tx, scope, channel);
  if (!account) return ["SOCIAL_CHANNEL_NOT_MAPPED"];
  const row = await tx.socialAccount.findFirstOrThrow({ where: { id: account.accountId, projectId: scope.projectId } });
  const issues = validateVariant(
    {
      account: {
        id: row.id,
        platform: account.platform,
        externalId: row.externalId,
        status: row.status,
        capability: row.capability,
        settings: row.settings as { xLongPosts?: boolean },
      },
      body: input.text,
      media: [],
      options: {},
    },
    validationContext(account.platform),
  );
  // An image is checked with the post; without it Instagram always asks for one.
  return [...new Set(issues.filter((i) => i.severity === "error" && i.code !== "SOCIAL_MEDIA_REQUIRED").map((i) => i.code))];
}

/** Puts an approved image of the origin into Social's library; outside a transaction. */
export async function importOriginMedia(scope: Scope, input: { bytes: Uint8Array; mime: string }): Promise<string> {
  return (await uploadMedia(scope, input)).id;
}

const originInput = z
  .object({
    origin: z.object({ module: z.literal("marketing"), type: z.string().min(1).max(40), id: z.uuid(), version: z.int().min(1) }).strict(),
    accountId: z.uuid(),
    text: z.string().max(25_000),
    mediaIds: z.array(z.uuid()).max(10),
    mode: z.enum(["now", "draft"]),
    at: z.date().optional(),
    packageHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type OriginPostInput = z.input<typeof originInput>;

/**
 * A post for one account from another module's record. `now`: the origin
 * approved exactly this content (its package hash is recorded), Social
 * sends it right away. `draft`: a draft for a human, timed at `at`. The
 * same origin record and version gives the same post.
 */
export async function submitOriginPost(tx: DbTx, scope: Scope, raw: OriginPostInput): Promise<{ postId: string; deduplicated: boolean }> {
  const input = originInput.parse(raw);
  if (!(await socialActive(tx, scope))) throw new DomainError("SOCIAL_DISABLED", 404);
  const existing = await tx.socialPost.findFirst({
    where: {
      projectId: scope.projectId,
      originModule: input.origin.module,
      originType: input.origin.type,
      originId: input.origin.id,
      originVersion: input.origin.version,
    },
    select: { id: true },
  });
  if (existing) return { postId: existing.id, deduplicated: true };
  if (input.mode === "now" && !input.packageHash) throw new DomainError("SOCIAL_ORIGIN_APPROVAL_REQUIRED", 409);
  const post = await createPost(
    tx,
    scope,
    { baseText: input.text, baseMedia: input.mediaIds, variants: [{ accountId: input.accountId }] },
    { origin: "marketing", originRef: input.origin },
  );
  if (input.mode === "now") {
    await approveOriginPost(tx, scope, post.id, { ...input.origin, packageHash: input.packageHash! });
  } else if (input.at) {
    await tx.socialPost.update({
      where: { id: post.id },
      data: {
        scheduleMode: "at",
        scheduledAt: input.at,
        scheduleLocal: localOf(input.at, post.schedule.timeZone),
        version: { increment: 1 },
      },
    });
  }
  return { postId: post.id, deduplicated: false };
}

export type OriginPostStatus = {
  postId: string;
  /** pending until Social knows the outcome. */
  status: "pending" | "published" | "failed" | "outcome_unknown" | "canceled";
  permalink: string | null;
  publishedAt: string | null;
  errorCode: string | null;
};

/** The state of origin posts as the origin needs it (unknown ids are left out). */
export async function originPostStatus(tx: DbTx, scope: Scope, postIds: string[]): Promise<OriginPostStatus[]> {
  const posts = await tx.socialPost.findMany({ where: { projectId: scope.projectId, id: { in: postIds } } });
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, postId: { in: posts.map((p) => p.id) } },
    select: { id: true, postId: true },
  });
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const postOf = new Map(variants.map((v) => [v.id, v.postId]));
  return postIds.flatMap((postId) => {
    const post = posts.find((p) => p.id === postId);
    if (!post) return [];
    const own = publications.filter((pub) => postOf.get(pub.variantId) === postId);
    const published = own.find((pub) => pub.status === "published");
    const failed = own.find((pub) => pub.status === "failed");
    const status: OriginPostStatus["status"] = ["published", "partially_published"].includes(post.status)
      ? "published"
      : own.some((pub) => pub.status === "outcome_unknown")
        ? "outcome_unknown"
        : post.status === "failed"
          ? "failed"
          : post.status === "canceled"
            ? "canceled"
            : "pending";
    return [
      {
        postId,
        status,
        permalink: published?.permalink ?? null,
        publishedAt: published?.publishedAt?.toISOString() ?? null,
        errorCode: status === "failed" ? (failed?.lastErrorCode ?? failed?.blockedCode ?? null) : null,
      },
    ];
  });
}

/** The texts published on the accounts in the last `days` days (duplicate checks). */
export async function recentPublishedTexts(tx: DbTx, scope: Scope, accountIds: string[], days: number): Promise<string[]> {
  if (!accountIds.length) return [];
  const publications = await tx.socialPublication.findMany({
    where: {
      projectId: scope.projectId,
      accountId: { in: accountIds },
      status: "published",
      publishedAt: { gte: new Date(Date.now() - days * 86_400_000) },
    },
    select: { variantId: true },
    take: 500,
  });
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, id: { in: publications.map((p) => p.variantId) } },
    select: { body: true },
  });
  return variants.map((v) => v.body);
}
