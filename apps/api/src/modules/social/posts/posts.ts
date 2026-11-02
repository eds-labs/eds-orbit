import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { cancelActionRequest } from "../../../platform/governance/action-requests.ts";
import { audit, data, DomainError, hash } from "../../../shared.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { computePackage, type SocialPackage } from "./package-hash.ts";
import { cancelDelivery } from "../dispatch/control.ts";
import { stopDelivery } from "../dispatch/dispatch.ts";
import { publicationView, type PublicationView } from "../dispatch/publication-view.ts";
import { validationContext } from "../dispatch/gates.ts";
import { validateVariant, type ValidationIssue } from "./validation.ts";

// Social posts (ADR 0020, S4): a base text and image set, and one variant
// per account that inherits or overrides them. Every change needs the
// current version; a change of what an approval binds (package-hash.ts)
// clears the approval and withdraws a pending request (S-D6). Nothing here
// sends anything.

export type MediaRef = { mediaId: string; width: number; height: number; altText: string | null };
export type ApprovalState = "none" | "pending" | "approved" | "rejected" | "expired" | "canceled";
export type PostView = {
  id: string;
  status: string;
  title: string | null;
  baseText: string;
  baseMedia: MediaRef[];
  schedule: {
    mode: "none" | "at" | "now";
    at: string | null;
    local: string | null;
    timeZone: string;
    fold: "earlier" | "later" | null;
  };
  approval: { state: ApprovalState; requestId: string | null; approvedAt: string | null; approvedBy: string | null };
  packageHash: string | null;
  origin: string;
  readOnly: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  variants: Array<{
    id: string;
    accountId: string;
    platform: SocialPlatform;
    handle: string;
    body: string;
    inheritsText: boolean;
    inheritsMedia: boolean;
    media: MediaRef[];
    options: Record<string, unknown>;
    issues: ValidationIssue[];
    version: number;
  }>;
  /** The deliveries of an approved post (S5), one per account. */
  publications: PublicationView[];
};
export type PostListItem = {
  id: string;
  status: string;
  title: string | null;
  excerpt: string;
  schedule: PostView["schedule"];
  approvalState: ApprovalState;
  accounts: Array<{ accountId: string; platform: SocialPlatform; handle: string }>;
  version: number;
  updatedAt: string;
};
export type SocialPostRow = Awaited<ReturnType<DbTx["socialPost"]["findFirstOrThrow"]>>;

/** Statuses in which a post may still change (no publication exists). */
export const EDITABLE = ["draft", "needs_approval", "approved", "scheduled"];
/** Statuses that carry an approval or a request for one. */
export const APPROVAL_BEARING = ["needs_approval", "approved", "scheduled"];
const ARCHIVABLE = ["draft", "canceled", "failed", "published", "partially_published"];
const STATUSES = [
  "draft",
  "needs_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
  "canceled",
  "archived",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGE_MS = 62 * 86_400_000;

const notFound = () => new DomainError("NOT_FOUND", 404);
const unique = (values: string[]) => new Set(values).size === values.length;
const mediaIds = z.array(z.uuid()).max(10).refine(unique, "duplicate media");
const variantInput = z
  .object({
    accountId: z.uuid(),
    text: z.string().max(25_000).nullable().optional(),
    media: mediaIds.nullable().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const postInput = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    baseText: z.string().max(25_000),
    baseMedia: mediaIds,
    variants: z
      .array(variantInput)
      .min(1)
      .max(10)
      .refine((v) => unique(v.map((x) => x.accountId)), "duplicate account"),
  })
  .strict();
const updateInput = postInput.extend({ version: z.int().min(1) }).strict();
const listQuery = z
  .object({
    status: z.string().max(200).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .passthrough();

/** The post, locked for this transaction, or 404. */
export async function lockPost(tx: DbTx, scope: Scope, id: string): Promise<SocialPostRow> {
  if (!UUID.test(id)) throw notFound();
  await tx.$queryRaw`SELECT id FROM "SocialPost" WHERE id = ${id}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  const row = await tx.socialPost.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row) throw notFound();
  return row;
}

async function rowsOf(tx: DbTx, scope: Scope, post: SocialPostRow) {
  const variants = await tx.socialPostVariant.findMany({ where: { postId: post.id, projectId: scope.projectId } });
  const media = await tx.socialPostMedia.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
  });
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: variants.map((v) => v.accountId) } },
  });
  return { variants, media, accounts };
}

/** What an approval of the post would bind now, and its hash. */
export async function packageOf(tx: DbTx, scope: Scope, id: string): Promise<{ hash: string; package: SocialPackage }> {
  const post = await tx.socialPost.findFirst({ where: { id, projectId: scope.projectId } });
  if (!post) throw notFound();
  const { variants, media, accounts } = await rowsOf(tx, scope, post);
  return computePackage(post, variants, media, accounts);
}

function requestState(row: { data: unknown } | null): ApprovalState {
  if (!row) return "none";
  const d = data(row);
  if (d.status === "pending") return Date.parse(d.expiresAt) <= Date.now() ? "expired" : "pending";
  if (d.status === "approved" || d.status === "consumed") return "approved";
  if (d.status === "rejected" || d.status === "canceled") return d.status;
  return "none";
}

async function approvalStates(tx: DbTx, scope: Scope, posts: SocialPostRow[]) {
  const ids = posts.map((p) => p.approvalRequestId).filter((id): id is string => Boolean(id));
  const rows = ids.length
    ? await tx.entity.findMany({ where: { projectId: scope.projectId, kind: "action_requests", id: { in: ids } } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (post: SocialPostRow): ApprovalState => {
    if (post.approvalRequestId) return requestState(byId.get(post.approvalRequestId) ?? null);
    return post.approvedAt ? "approved" : "none";
  };
}

const scheduleView = (post: SocialPostRow): PostView["schedule"] => ({
  mode: post.scheduleMode as PostView["schedule"]["mode"],
  at: post.scheduledAt?.toISOString() ?? null,
  local: post.scheduleLocal,
  timeZone: post.scheduleTimezone,
  fold: post.scheduleFold as PostView["schedule"]["fold"],
});

/** One post with its variants, images, schedule and approval. */
export async function getPost(tx: DbTx, scope: Scope, id: string): Promise<PostView> {
  if (!UUID.test(id)) throw notFound();
  const post = await tx.socialPost.findFirst({ where: { id, projectId: scope.projectId } });
  if (!post) throw notFound();
  const { variants, media, accounts } = await rowsOf(tx, scope, post);
  const baseIds = post.baseMedia as string[];
  const assets = await tx.socialMediaAsset.findMany({
    where: { projectId: scope.projectId, OR: [{ id: { in: baseIds } }, { fileId: { in: media.map((m) => m.fileId) } }] },
  });
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const assetByFile = new Map(assets.map((a) => [a.fileId, a]));
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const publications = await tx.socialPublication.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const state = (await approvalStates(tx, scope, [post]))(post);
  return {
    id: post.id,
    status: post.status,
    title: post.title,
    baseText: post.baseText,
    baseMedia: baseIds.flatMap((mediaId) => {
      const a = assetById.get(mediaId);
      return a ? [{ mediaId, width: a.width, height: a.height, altText: a.altText }] : [];
    }),
    schedule: scheduleView(post),
    approval: {
      state,
      requestId: post.approvalRequestId,
      approvedAt: post.approvedAt?.toISOString() ?? null,
      approvedBy: post.approvedBy,
    },
    packageHash: post.packageHash,
    origin: post.origin,
    readOnly: post.readOnly,
    version: post.version,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    publications: publications.map((row) =>
      publicationView(row, (accountOf.get(row.accountId)?.platform ?? "telegram") as SocialPlatform),
    ),
    variants: [...variants]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((v) => {
        const account = accountOf.get(v.accountId)!;
        return {
          id: v.id,
          accountId: v.accountId,
          platform: account.platform as SocialPlatform,
          handle: account.handle,
          body: v.body,
          inheritsText: v.inheritsText,
          inheritsMedia: v.inheritsMedia,
          media: media
            .filter((m) => m.variantId === v.id)
            .sort((a, b) => a.position - b.position)
            .flatMap((m) => {
              const a = assetByFile.get(m.fileId);
              return a ? [{ mediaId: a.id, width: m.width ?? a.width, height: m.height ?? a.height, altText: m.altText }] : [];
            }),
          options: (v.platformOptions ?? {}) as Record<string, unknown>,
          issues: ((v.validation as { issues?: ValidationIssue[] })?.issues ?? []) as ValidationIssue[],
          version: v.version,
        };
      }),
  };
}

/** Posts of the project, newest change first; archived ones only on request. */
export async function listPosts(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
): Promise<{ items: PostListItem[]; nextCursor: string | null }> {
  const q = listQuery.parse(raw);
  const statuses = q.status ? q.status.split(",").filter((s) => STATUSES.includes(s)) : null;
  if ((q.from === undefined) !== (q.to === undefined)) throw new DomainError("SOCIAL_RANGE_INVALID", 422);
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if (from && to && (to <= from || to.getTime() - from.getTime() > RANGE_MS))
    throw new DomainError("SOCIAL_RANGE_TOO_LARGE", 422);
  let after: { at: Date; id: string } | null = null;
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) throw new DomainError("SOCIAL_CURSOR_INVALID", 422);
    after = { at: new Date(at), id };
  }
  const rows = await tx.socialPost.findMany({
    where: {
      projectId: scope.projectId,
      status: statuses ? { in: statuses } : { not: "archived" },
      ...(from && to ? { scheduledAt: { gte: from, lt: to } } : {}),
      ...(after
        ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const variants = await tx.socialPostVariant.findMany({
    where: { projectId: scope.projectId, postId: { in: page.map((p) => p.id) } },
    select: { postId: true, accountId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: [...new Set(variants.map((v) => v.accountId))] } },
  });
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const state = await approvalStates(tx, scope, page);
  const last = page[page.length - 1];
  return {
    items: page.map((post) => ({
      id: post.id,
      status: post.status,
      title: post.title,
      excerpt: [...post.baseText].slice(0, 140).join(""),
      schedule: scheduleView(post),
      approvalState: state(post),
      accounts: variants
        .filter((v) => v.postId === post.id)
        .map((v) => {
          const a = accountOf.get(v.accountId)!;
          return { accountId: a.id, platform: a.platform as SocialPlatform, handle: a.handle };
        }),
      version: post.version,
      updatedAt: post.updatedAt.toISOString(),
    })),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(`${last.updatedAt.toISOString()}|${last.id}`).toString("base64url")
        : null,
  };
}

/** The issues of every variant as they are now (accounts and images re-read). */
export async function currentIssues(tx: DbTx, scope: Scope, post: { id: string }) {
  const variants = await tx.socialPostVariant.findMany({ where: { postId: post.id, projectId: scope.projectId } });
  const media = await tx.socialPostMedia.findMany({
    where: { projectId: scope.projectId, variantId: { in: variants.map((v) => v.id) } },
  });
  const accounts = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId, id: { in: variants.map((v) => v.accountId) } },
  });
  const assets = await tx.socialMediaAsset.findMany({
    where: { projectId: scope.projectId, fileId: { in: media.map((m) => m.fileId) } },
  });
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const assetOf = new Map(assets.map((a) => [a.fileId, a]));
  const result: Array<{ accountId: string; issues: ValidationIssue[] }> = [];
  for (const v of variants) {
    const account = accountOf.get(v.accountId)!;
    const issues = validateVariant({
      account: {
        id: account.id,
        platform: account.platform as SocialPlatform,
        externalId: account.externalId,
        status: account.status,
        capability: account.capability,
        settings: account.settings as { xLongPosts?: boolean },
      },
      body: v.body,
      media: media
        .filter((m) => m.variantId === v.id)
        .sort((a, b) => a.position - b.position)
        .flatMap((m) => (assetOf.has(m.fileId) ? [assetOf.get(m.fileId)!] : [])),
      options: (v.platformOptions ?? {}) as Record<string, unknown>,
    }, validationContext(account.platform as SocialPlatform));
    result.push({ accountId: v.accountId, issues });
  }
  return result;
}

/** Re-checks every variant now and stores the result (the editor's "Check"). */
export async function refreshIssues(tx: DbTx, scope: Scope, postId: string) {
  const result = await currentIssues(tx, scope, { id: postId });
  for (const v of result)
    await tx.socialPostVariant.updateMany({
      where: { projectId: scope.projectId, postId, accountId: v.accountId },
      data: { validation: { issues: v.issues } as Prisma.InputJsonValue },
    });
  return result;
}

/** Stores base and variants of `input`; validation is recorded, never blocking. */
async function writeContent(tx: DbTx, scope: Scope, post: SocialPostRow, input: z.infer<typeof postInput>) {
  const accountIds = input.variants.map((v) => v.accountId);
  const accounts = await tx.socialAccount.findMany({ where: { projectId: scope.projectId, id: { in: accountIds } } });
  if (accounts.length !== accountIds.length) throw notFound();
  if (accounts.some((a) => a.status === "disabled")) throw new DomainError("SOCIAL_ACCOUNT_NOT_ACTIVE", 409);
  const wanted = [...new Set([...input.baseMedia, ...input.variants.flatMap((v) => v.media ?? [])])];
  const assets = await tx.socialMediaAsset.findMany({ where: { projectId: scope.projectId, id: { in: wanted } } });
  if (assets.length !== wanted.length) throw notFound();
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const existing = await tx.socialPostVariant.findMany({ where: { postId: post.id, projectId: scope.projectId } });
  const existingOf = new Map(existing.map((v) => [v.accountId, v]));
  for (const v of input.variants) {
    const account = accountOf.get(v.accountId)!;
    const body = v.text ?? input.baseText;
    const images = (v.media ?? input.baseMedia).map((id) => assetOf.get(id)!);
    const options = v.options ?? {};
    const issues = validateVariant({
      account: {
        id: account.id,
        platform: account.platform as SocialPlatform,
        externalId: account.externalId,
        status: account.status,
        capability: account.capability,
        settings: account.settings as { xLongPosts?: boolean },
      },
      body,
      media: images,
      options,
    }, validationContext(account.platform as SocialPlatform));
    const fields = {
      body,
      inheritsText: v.text === null || v.text === undefined,
      inheritsMedia: v.media === null || v.media === undefined,
      platformOptions: options as Prisma.InputJsonValue,
      contentHash: hash({ body, options, media: images.map((a) => a.sha256) }),
      validation: { issues } as Prisma.InputJsonValue,
    };
    const before = existingOf.get(v.accountId);
    const variantId = before?.id ?? randomUUID();
    if (before)
      await tx.socialPostVariant.update({ where: { id: before.id }, data: { ...fields, version: { increment: 1 } } });
    else
      await tx.socialPostVariant.create({
        data: {
          id: variantId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          postId: post.id,
          accountId: v.accountId,
          ...fields,
        },
      });
    await tx.socialPostMedia.deleteMany({ where: { projectId: scope.projectId, variantId } });
    if (images.length)
      await tx.socialPostMedia.createMany({
        data: images.map((a, position) => ({
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          variantId,
          fileId: a.fileId,
          position,
          kind: "image",
          altText: a.altText,
          width: a.width,
          height: a.height,
          sha256: a.sha256,
        })),
      });
  }
  const removed = existing.filter((v) => !accountIds.includes(v.accountId)).map((v) => v.id);
  if (removed.length) await tx.socialPostVariant.deleteMany({ where: { projectId: scope.projectId, id: { in: removed } } });
}

/**
 * The fields that clear a post's approval; a pending request for it is
 * withdrawn with `reason`. Callers set `status` themselves.
 */
export async function resetApproval(tx: DbTx, scope: Scope, post: SocialPostRow, reason: string) {
  if (post.approvalRequestId)
    await cancelActionRequest(tx, scope, post.approvalRequestId, reason, { pendingOnly: true });
  if (post.approvalRequestId || post.approvedAt)
    await audit(tx, scope, "social.post.approval_reset", post.id, { reason });
  // An approved post waits for its dispatch job; that approval just ended.
  await stopDelivery(tx, scope, post.id, reason);
  return { approvalRequestId: null, approvedAt: null, approvedBy: null, packageHash: null };
}

function requireWritable(post: SocialPostRow, version: number, statuses = EDITABLE) {
  if (post.readOnly) throw new DomainError("SOCIAL_POST_READ_ONLY", 409);
  if (post.version !== version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  if (!statuses.includes(post.status)) throw new DomainError("SOCIAL_POST_NOT_EDITABLE", 409);
}

export async function createPost(tx: DbTx, scope: Scope, raw: unknown): Promise<PostView> {
  const input = postInput.parse(raw);
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { timezone: true } });
  const post = await tx.socialPost.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      title: input.title || null,
      baseText: input.baseText,
      baseMedia: input.baseMedia,
      scheduleTimezone: project?.timezone ?? "UTC",
      createdBy: scope.userId,
    },
  });
  await writeContent(tx, scope, post, input);
  await audit(tx, scope, "social.post.created", post.id, { variants: input.variants.length });
  return getPost(tx, scope, post.id);
}

export async function updatePost(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView> {
  const { version, ...input } = updateInput.parse(raw);
  const post = await lockPost(tx, scope, id);
  requireWritable(post, version);
  await writeContent(tx, scope, post, input);
  await tx.socialPost.update({
    where: { id: post.id },
    data: { title: input.title || null, baseText: input.baseText, baseMedia: input.baseMedia },
  });
  // An approval binds the package; any other change of it clears it.
  let reset = {};
  if (APPROVAL_BEARING.includes(post.status) && (await packageOf(tx, scope, post.id)).hash !== post.packageHash)
    reset = { ...(await resetApproval(tx, scope, post, "post_changed")), status: "draft" };
  await tx.socialPost.update({ where: { id: post.id }, data: { ...reset, version: { increment: 1 } } });
  await audit(tx, scope, "social.post.updated", post.id, {
    variants: input.variants.length,
    approvalReset: "status" in reset,
  });
  return getPost(tx, scope, post.id);
}

/** Back to a draft: the schedule's approval and any pending request end. */
export async function cancelPost(tx: DbTx, scope: Scope, id: string, version: number): Promise<PostView> {
  const post = await lockPost(tx, scope, id);
  if (post.status === "publishing") {
    // Stops what was not sent; a send in flight keeps its result (S5).
    requireWritable(post, version, ["publishing"]);
    await cancelDelivery(tx, scope, post.id);
    return getPost(tx, scope, post.id);
  }
  requireWritable(post, version, APPROVAL_BEARING);
  await tx.socialPost.update({
    where: { id: post.id },
    data: { ...(await resetApproval(tx, scope, post, "post_canceled")), status: "draft", version: { increment: 1 } },
  });
  await audit(tx, scope, "social.post.canceled", post.id, {});
  return getPost(tx, scope, post.id);
}

export async function archivePost(tx: DbTx, scope: Scope, id: string, version: number): Promise<PostView> {
  const post = await lockPost(tx, scope, id);
  requireWritable(post, version, ARCHIVABLE);
  await tx.socialPost.update({ where: { id: post.id }, data: { status: "archived", version: { increment: 1 } } });
  await audit(tx, scope, "social.post.archived", post.id, {});
  return getPost(tx, scope, post.id);
}
