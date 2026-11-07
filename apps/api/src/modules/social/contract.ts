import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { localOf } from "../../platform/time/zoned-time.ts";
import { audit, DomainError } from "../../shared.ts";
import type { SocialPlatform } from "./accounts/store.ts";
import { postMetrics } from "./analytics/collect.ts";
import { cancelDelivery } from "./dispatch/control.ts";
import { stopDelivery } from "./dispatch/dispatch.ts";
import { validationContext } from "./dispatch/gates.ts";
import { socialActive } from "./gate.ts";
import { uploadMedia } from "./media/library.ts";
import { approveOriginPost } from "./posts/approval.ts";
import { createPost, lockPost } from "./posts/posts.ts";
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

/** Whether a Marketing channel reference is a native `social:<accountId>` one. */
export function isSocialChannel(channel: string): boolean {
  return SOCIAL_CHANNEL.test(channel);
}

/** The handle of each of the project's connected accounts by its `social:<accountId>` reference. */
export async function socialChannelHandles(tx: DbTx, scope: Scope): Promise<Map<string, string>> {
  const rows = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, status: { not: "disabled" } },
    select: { id: true, handle: true },
  });
  return new Map(rows.map((row) => [`social:${row.id}`, row.handle]));
}

/** Whether the project can publish through Social now (switch and module). */
export function socialPublishingAvailable(tx: DbTx, scope: Scope): Promise<boolean> {
  return socialActive(tx, scope);
}

/** The project's account behind a Marketing channel reference, or null. */
export async function accountForChannel(tx: DbTx, scope: Scope, channel: string): Promise<SocialAccountRef | null> {
  const direct = SOCIAL_CHANNEL.exec(channel);
  // A disconnected account no longer stands for a channel.
  const row = await tx.socialAccount.findFirst({
    where: {
      projectId: scope.projectId,
      status: { not: "disabled" },
      ...(direct ? { id: direct[1]!.toLowerCase() } : { legacyPostizIntegrationId: channel }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  return (await uploadMedia(scope, { ...input, reuse: true })).id;
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
  /**
   * pending until Social knows the outcome; blocked while a delivery waits
   * for a person (errorCode says why); withdrawn when someone took the post
   * back to a draft in Social.
   */
  status: "pending" | "blocked" | "withdrawn" | "published" | "failed" | "outcome_unknown" | "canceled";
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
    const blocked = own.find((pub) => pub.status === "blocked");
    const status: OriginPostStatus["status"] = ["published", "partially_published"].includes(post.status)
      ? "published"
      : own.some((pub) => pub.status === "outcome_unknown")
        ? "outcome_unknown"
        : post.status === "failed"
          ? "failed"
          : post.status === "canceled"
            ? "canceled"
            : ["draft", "needs_approval", "archived"].includes(post.status)
              ? "withdrawn"
              : blocked
                ? "blocked"
                : "pending";
    return [
      {
        postId,
        status,
        permalink: published?.permalink ?? null,
        publishedAt: published?.publishedAt?.toISOString() ?? null,
        errorCode:
          status === "failed"
            ? (failed?.lastErrorCode ?? failed?.blockedCode ?? null)
            : status === "blocked"
              ? (blocked?.blockedCode ?? null)
              : null,
      },
    ];
  });
}

/**
 * The texts published on the accounts in the last `days` days (duplicate
 * checks); `excludePostIds` leaves out the origin's own handed-over posts.
 */
export async function recentPublishedTexts(
  tx: DbTx,
  scope: Scope,
  accountIds: string[],
  days: number,
  options: { excludePostIds?: string[] } = {},
): Promise<string[]> {
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
    where: {
      projectId: scope.projectId,
      id: { in: publications.map((p) => p.variantId) },
      ...(options.excludePostIds?.length ? { postId: { notIn: options.excludePostIds } } : {}),
    },
    select: { body: true },
  });
  return variants.map((v) => v.body);
}

/**
 * Takes back an origin post the origin no longer wants (a stop, a pause, a
 * calendar block, an invalidated source): `canceled` when nothing went out,
 * `sent` when a delivery already left (its result still counts).
 */
export async function cancelOriginPost(
  tx: DbTx,
  scope: Scope,
  postId: string,
  reason: string,
): Promise<"canceled" | "sent" | "not_found"> {
  const exists = await tx.socialPost.findFirst({ where: { id: postId, projectId: scope.projectId }, select: { id: true } });
  if (!exists) return "not_found";
  const post = await lockPost(tx, scope, postId);
  if (post.status === "canceled") return "canceled";
  if (["published", "partially_published", "failed"].includes(post.status)) return "sent";
  if (post.status === "publishing") {
    const { tooLate } = await cancelDelivery(tx, scope, post.id);
    const sent = await tx.socialPublication.count({
      where: {
        projectId: scope.projectId,
        variant: { postId: post.id },
        status: { in: ["published", "outcome_unknown", "processing", "accepted"] },
      },
    });
    if (tooLate || sent) return "sent";
  } else await stopDelivery(tx, scope, post.id, reason);
  await tx.socialPost.update({ where: { id: post.id }, data: { status: "canceled", version: { increment: 1 } } });
  await audit(tx, scope, "social.post.origin_canceled", post.id, { reason });
  return "canceled";
}

// ------------------------------------------------- Postiz migration (S10)

export type MappableAccount = {
  accountId: string;
  platform: SocialPlatform;
  handle: string;
  displayName: string;
  status: string;
  legacyPostizIntegrationId: string | null;
};

/** The project's accounts with the Postiz channel each one stands for. */
export async function accountsForMapping(tx: DbTx, scope: Scope): Promise<MappableAccount[]> {
  const rows = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, status: { not: "disabled" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    accountId: row.id,
    platform: row.platform as SocialPlatform,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    legacyPostizIntegrationId: row.legacyPostizIntegrationId,
  }));
}

/** Records (or clears) the Postiz channel an account stands for; no other account keeps it. */
export async function setLegacyChannel(tx: DbTx, scope: Scope, accountId: string, integrationId: string | null): Promise<void> {
  if (integrationId !== null)
    await tx.socialAccount.updateMany({
      where: { projectId: scope.projectId, legacyPostizIntegrationId: integrationId, NOT: { id: accountId } },
      data: { legacyPostizIntegrationId: null, version: { increment: 1 } },
    });
  const changed = await tx.socialAccount.updateMany({
    where: { id: accountId, projectId: scope.projectId },
    data: { legacyPostizIntegrationId: integrationId, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new DomainError("NOT_FOUND", 404);
  await audit(tx, scope, "social.account.legacy_mapped", accountId, { mapped: integrationId !== null });
}

/** One record of the origin's Postiz history, as the mirror shows it. */
export type LegacyRow = {
  kind: "publication" | "draft";
  id: string;
  channel: string;
  text: string;
  status: "published" | "failed" | "canceled" | "outcome_unknown" | "accepted" | "draft";
  at: string;
  externalPostId: string | null;
  permalink: string | null;
  publishedAt: string | null;
};

const POST_STATUS: Record<LegacyRow["status"], string> = {
  published: "published",
  failed: "failed",
  canceled: "canceled",
  outcome_unknown: "publishing",
  accepted: "publishing",
  draft: "draft",
};

/**
 * The read-only mirror of another system's history (S-D8, S10): one post
 * (origin `legacy_postiz`, read-only) per record on a mapped channel, with
 * one publication carrying the record's id as `legacyEntityId` (drafts have
 * none). A re-run updates what changed in the source; nothing is ever sent.
 */
export async function mirrorLegacyRows(tx: DbTx, scope: Scope, rows: LegacyRow[], options: { dryRun: boolean }) {
  const result = { dryRun: options.dryRun, created: 0, updated: 0, unchanged: 0, unmapped: 0, byStatus: {} as Record<string, number> };
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { timezone: true } });
  const zone = project?.timezone ?? "UTC";
  for (const row of rows) {
    const account = await accountForChannel(tx, scope, row.channel);
    if (!account) {
      result.unmapped++;
      continue;
    }
    const at = new Date(row.at);
    const existing = await tx.socialPost.findFirst({
      where: { projectId: scope.projectId, origin: "legacy_postiz", originModule: "postiz", originType: row.kind, originId: row.id },
    });
    const publication =
      existing && row.kind === "publication"
        ? await tx.socialPublication.findFirst({ where: { projectId: scope.projectId, legacyEntityId: row.id } })
        : null;
    const postFields = {
      status: POST_STATUS[row.status],
      baseText: row.text,
      scheduleMode: "at",
      scheduledAt: Number.isFinite(at.getTime()) ? at : null,
      scheduleLocal: Number.isFinite(at.getTime()) ? localOf(at, zone) : null,
    };
    // Postiz's own post id is no platform id: kept apart in the provider state.
    const publicationFields = {
      status: row.status === "draft" ? "pending" : row.status,
      externalPostId: null,
      permalink: row.permalink,
      publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
      providerState: { legacyPostiz: true, postizId: row.externalPostId },
    };
    const same =
      existing &&
      existing.status === postFields.status &&
      existing.baseText === postFields.baseText &&
      (row.kind === "draft" ||
        (publication &&
          publication.status === publicationFields.status &&
          publication.permalink === publicationFields.permalink));
    if (same) {
      result.unchanged++;
      continue;
    }
    result.byStatus[row.status] = (result.byStatus[row.status] ?? 0) + 1;
    if (existing) result.updated++;
    else result.created++;
    if (options.dryRun) continue;
    if (existing) {
      await tx.socialPost.update({ where: { id: existing.id }, data: { ...postFields, version: { increment: 1 } } });
      await tx.socialPostVariant.updateMany({ where: { projectId: scope.projectId, postId: existing.id }, data: { body: row.text } });
      if (publication)
        await tx.socialPublication.update({ where: { id: publication.id }, data: { ...publicationFields, version: { increment: 1 } } });
      continue;
    }
    const postId = randomUUID();
    const variantId = randomUUID();
    await tx.socialPost.create({
      data: {
        id: postId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...postFields,
        baseMedia: [],
        scheduleTimezone: zone,
        origin: "legacy_postiz",
        // Not "marketing": Marketing's own handoffs use that key (S9).
        originModule: "postiz",
        originType: row.kind,
        originId: row.id,
        originVersion: 1,
        readOnly: true,
        createdBy: scope.userId,
      },
    });
    await tx.socialPostVariant.create({
      data: {
        id: variantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        postId,
        accountId: account.accountId,
        body: row.text,
        contentHash: createHash("sha256").update(row.text).digest("hex"),
      },
    });
    if (row.kind === "publication")
      await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          variantId,
          accountId: account.accountId,
          idempotencyKey: `legacy:${row.id}`,
          legacyEntityId: row.id,
          ...publicationFields,
        },
      });
  }
  return result;
}
