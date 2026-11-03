import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { approvedOperation, readOperation } from "../../platform/tasks/operation-tools.ts";
import type { RequestedBy } from "../action-requests.ts";
import { SOCIAL_SCOPE } from "../../platform/mcp/scopes.ts";
import { data, DomainError, entity } from "../../shared.ts";
import { listAccounts } from "./accounts/accounts.ts";
import { calendarItems } from "./calendar/calendar.ts";
import { SOCIAL_COMPOSE, SOCIAL_PUBLISH, SOCIAL_READ } from "./permissions.ts";
import { applyApprovedSchedule, proposedSchedule, type ProposedSchedule, type ProposedTime } from "./posts/approval.ts";
import {
  APPROVAL_BEARING,
  cancelPost,
  createPost,
  draftIssues,
  draftPreview,
  getPost,
  requireWritable,
  updatePost,
  type PostView,
} from "./posts/posts.ts";
import { TEXT_LIMITS } from "./posts/validation.ts";

// The social module's assistant and MCP tools (ADR 0020 §6.5, S7): reads of
// accounts, the calendar and posts, and a check that saves nothing. Every
// tool needs the module enabled, the member's permission and, over MCP, the
// explicit content scope orbit:social. Outputs carry no tokens, connection
// ids or file ids.

const shared = {
  module: "social",
  feature: "social" as const,
  mcpScopes: [SOCIAL_SCOPE],
};

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
] as const;
const PLATFORMS = ["x", "facebook", "instagram", "telegram"] as const;
const ORIGINS = ["manual", "marketing", "mcp", "assistant", "legacy_postiz"] as const;
const CALENDAR_DAYS = 31;
// A UUID with a short pattern: id puts a long one into every tool
// schema the model receives (chat budget, S7).
const id = z.string().regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
const CALENDAR_ITEMS = 200;

/** The longest text a post on the account may have. */
function textLimit(platform: string, settings: { xLongPosts: boolean }) {
  if (platform === "x") return settings.xLongPosts ? TEXT_LIMITS.xLong : TEXT_LIMITS.x;
  return TEXT_LIMITS[platform as "instagram" | "facebook" | "telegram"];
}

const publicationOut = (p: PostView["publications"][number]) => ({
  accountId: p.accountId,
  platform: p.platform,
  status: p.status,
  permalink: p.permalink,
  publishedAt: p.publishedAt,
  blockedCode: p.blockedCode,
  lastErrorCode: p.lastErrorCode,
  test: p.test,
});

// ----------------------------------------------------------------- reads

export const socialAccountsTool = readOperation({
  ...shared,
  name: "social_accounts",
  description:
    "The project's social accounts (X, Facebook Pages, Instagram, Telegram channels): status, posting verified, longest text.",
  input: z.object({}).strict(),
  permission: SOCIAL_READ,
  async run(tx, scope) {
    const { items } = await listAccounts(tx, scope);
    return {
      items: items.map((a) => ({
        accountId: a.id,
        platform: a.platform,
        handle: a.handle,
        displayName: a.displayName,
        status: a.status,
        capability: a.capability,
        lastCheckCode: a.lastCheckCode,
        textLimit: textLimit(a.platform, a.settings),
      })),
    };
  },
});

export const socialCalendarTool = readOperation({
  ...shared,
  name: "social_calendar",
  description:
    "Posts timed between from and to (ISO, at most 31 days) with status, approval, accounts and publications; at most 200 (see truncated).",
  input: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      accountIds: z.array(id).max(20).optional(),
      platforms: z.array(z.enum(PLATFORMS)).max(4).optional(),
      statuses: z.array(z.enum(STATUSES)).max(10).optional(),
      origins: z.array(z.enum(ORIGINS)).max(5).optional(),
    })
    .strict(),
  permission: SOCIAL_READ,
  async run(tx, scope, args) {
    if (Date.parse(args.to) - Date.parse(args.from) > CALENDAR_DAYS * 86_400_000)
      throw new DomainError("SOCIAL_RANGE_TOO_LARGE", 422);
    const csv = (values?: readonly string[]) => (values?.length ? values.join(",") : undefined);
    const { items, truncated } = await calendarItems(
      tx,
      scope,
      {
        from: args.from,
        to: args.to,
        accountIds: csv(args.accountIds),
        platforms: csv(args.platforms),
        statuses: csv(args.statuses),
        origins: csv(args.origins),
      },
      CALENDAR_ITEMS,
    );
    return {
      items: items.map((i) => ({
        postId: i.id,
        title: i.title,
        excerpt: i.excerpt,
        status: i.status,
        origin: i.origin,
        at: i.schedule.at,
        local: i.schedule.local,
        timeZone: i.schedule.timeZone,
        approvalState: i.approvalState,
        version: i.version,
        accounts: i.accounts,
        publications: i.publications,
      })),
      truncated,
    };
  },
});

export const socialPostGetTool = readOperation({
  ...shared,
  name: "social_post_get",
  description:
    "One post: text per account, images, schedule, approval, check results, version, publications with links.",
  input: z.object({ postId: id }).strict(),
  permission: SOCIAL_READ,
  async run(tx, scope, args) {
    const post = await getPost(tx, scope, args.postId);
    return {
      postId: post.id,
      title: post.title,
      status: post.status,
      origin: post.origin,
      readOnly: post.readOnly,
      version: post.version,
      schedule: post.schedule,
      approval: { state: post.approval.state, approvedAt: post.approval.approvedAt },
      baseText: post.baseText,
      variants: post.variants.map((v) => ({
        accountId: v.accountId,
        platform: v.platform,
        handle: v.handle,
        body: v.body,
        media: v.media.map((m) => ({ mediaId: m.mediaId, width: m.width, height: m.height, altText: m.altText })),
        options: v.options,
        issues: v.issues,
      })),
      publications: post.publications.map(publicationOut),
    };
  },
});

export const socialPostStatusTool = readOperation({
  ...shared,
  name: "social_post_status",
  description:
    "Status of up to 20 posts and their publications, with links; unknown ids under missing.",
  input: z.object({ postIds: z.array(id).min(1).max(20) }).strict(),
  permission: SOCIAL_READ,
  async run(tx, scope, args) {
    const items = [];
    const missing: string[] = [];
    for (const postId of new Set(args.postIds as string[])) {
      const found = await tx.socialPost.findFirst({ where: { id: postId, projectId: scope.projectId }, select: { id: true } });
      if (!found) {
        missing.push(postId);
        continue;
      }
      const post = await getPost(tx, scope, postId);
      items.push({ postId, status: post.status, publications: post.publications.map(publicationOut) });
    }
    return { items, missing };
  },
});

const optionsInput = z
  .object({
    replySettings: z.enum(["everyone", "following", "mentionedUsers"]).optional(),
    disableLinkPreview: z.boolean().optional(),
    silent: z.boolean().optional(),
  })
  .strict();
/** A draft as the tools take it: one text and images for all accounts, overrides per account. */
export const draftInput = z
  .object({
    title: z.string().trim().max(200).optional(),
    baseText: z.string().max(25_000),
    baseMedia: z.array(id).max(10),
    variants: z
      .array(
        z
          .object({
            accountId: id,
            text: z.string().max(25_000).optional(),
            media: z.array(id).max(10).optional(),
            options: optionsInput.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const socialValidateTool = readOperation({
  ...shared,
  name: "social_validate",
  description:
    "Check a draft (same input as social_draft_create) against each account's platform rules without saving it.",
  input: draftInput,
  permission: SOCIAL_COMPOSE,
  async run(tx, scope, args) {
    return { variants: await draftIssues(tx, scope, args) };
  },
});

// ------------------------------------------------------------ proposals

const proposal = {
  ...shared,
  // S-D9: the owner decides every MCP write; nothing happens before.
  deciderRole: "owner" as const,
  mcpProjectRequired: true,
  // Nothing spends money or needs a marketing publishing policy.
  policyRequired: false,
  requires: [] as const,
};
/** Internal changes only (ADR 0019): an owner may let agents do them without asking. */
const internal = { riskClass: "W0" as const, mandate: { maxCostMicrosPerAction: 0 } };

const originOf = (requester?: RequestedBy) => (requester?.kind === "mcp" ? "mcp" : "assistant");

async function postFor(tx: DbTx, scope: Scope, postId: string) {
  const post = await tx.socialPost.findFirst({ where: { id: postId, projectId: scope.projectId } });
  if (!post) throw new DomainError("NOT_FOUND", 404);
  return post;
}

const updateInput = draftInput.extend({ postId: id, version: z.int().min(1) }).strict();
const cancelInput = z.object({ postId: id, version: z.int().min(1) }).strict();

/** The approval's view of a draft change: the texts per account, with handles. */
const draftSummary = (change: "create" | "update") => (args: { title?: string }, context?: { variants?: unknown }) => ({
  operation: { kind: "social_draft", change, title: args.title ?? null, variants: context?.variants ?? [] },
});

export const socialDraftCreate = approvedOperation({
  ...internal,
  ...proposal,
  name: "social_draft_create",
  description:
    "Propose a draft post: baseText and baseMedia (media ids) for all accounts, per account optional text, media, options. Saved only; publishing is social_schedule.",
  input: draftInput,
  permission: SOCIAL_COMPOSE,
  summary: draftSummary("create"),
  // The accounts and images as the service would take them, before asking.
  async validate(tx, scope, args) {
    await draftIssues(tx, scope, args);
  },
  approvalContext: async (tx, scope, args) => ({ variants: await draftPreview(tx, scope, args) }),
  async run(tx, scope, args, requester) {
    const post = await createPost(tx, scope, args, { origin: originOf(requester) });
    return { postId: post.id, version: post.version };
  },
});

export const socialDraftUpdate = approvedOperation({
  ...internal,
  ...proposal,
  name: "social_draft_update",
  description:
    "Propose new content for a post (with the version read); an approved or planned post becomes a draft again.",
  input: updateInput,
  permission: SOCIAL_COMPOSE,
  summary: draftSummary("update"),
  async validate(tx, scope, args) {
    requireWritable(await postFor(tx, scope, args.postId), args.version);
    await draftIssues(tx, scope, { title: args.title, baseText: args.baseText, baseMedia: args.baseMedia, variants: args.variants });
  },
  approvalContext: async (tx, scope, args) => ({
    variants: await draftPreview(tx, scope, { title: args.title, baseText: args.baseText, baseMedia: args.baseMedia, variants: args.variants }),
  }),
  async run(tx, scope, args) {
    const { postId, ...content } = args as z.infer<typeof updateInput>;
    const post = await updatePost(tx, scope, postId, content);
    return { postId: post.id, version: post.version };
  },
});

export const socialCancel = approvedOperation({
  ...internal,
  ...proposal,
  name: "social_cancel",
  description:
    "Propose to take a planned or approved post back to a draft (with the version read).",
  input: cancelInput,
  permission: SOCIAL_COMPOSE,
  summary: (args, context?: Record<string, unknown>) => ({ operation: { kind: "social_cancel", postId: args.postId, ...context } }),
  async validate(tx, scope, args) {
    const post = await postFor(tx, scope, args.postId);
    requireWritable(post, args.version, post.status === "publishing" ? ["publishing"] : APPROVAL_BEARING);
  },
  approvalContext: async (tx, scope, args) => {
    const post = await getPost(tx, scope, args.postId);
    return { title: post.title, status: post.status, at: post.schedule.at, local: post.schedule.local, timeZone: post.schedule.timeZone };
  },
  async run(tx, scope, args) {
    const post = await cancelPost(tx, scope, args.postId, args.version);
    return { postId: post.id, version: post.version, status: post.status };
  },
});

const scheduleInput = z
  .object({
    postId: id,
    version: z.int().min(1),
    at: z.iso.datetime({ offset: true }).optional(),
    local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
    timeZone: z.string().max(64).optional(),
    fold: z.enum(["earlier", "later"]).optional(),
  })
  .strict();
const publishInput = z.object({ postId: id, version: z.int().min(1) }).strict();

const whenOf = (args: { at?: string; local?: string; timeZone?: string; fold?: "earlier" | "later" } | null): ProposedTime =>
  args ? { mode: "at", at: args.at, local: args.local, timeZone: args.timeZone, fold: args.fold } : { mode: "now" };

/** The approval shows the exact package, like a native social post request (S4 renderer). */
const postSummary = (_args: unknown, context?: ProposedSchedule) => ({
  operation: context
    ? { kind: "social_post", mode: context.mode, at: context.at, local: context.local, timeZone: context.timeZone, variants: context.variants }
    : { kind: "social_post_unreadable" },
});

/**
 * Scheduling or publishing at once (W2, public): the owner decides the MCP
 * request, which is the post's approval; the run applies exactly the stored
 * package (a changed post makes it stale) and never asks a second time.
 */
function publishing(name: "social_schedule" | "social_publish_now", timed: boolean) {
  const input = timed ? scheduleInput : publishInput;
  type Args = z.infer<typeof scheduleInput>;
  const when = (args: Args) => whenOf(timed ? args : null);
  return approvedOperation({
    ...proposal,
    riskClass: "W2",
    name,
    description: timed
      ? "Propose to publish a post (with the version read) at `at` (ISO) or `local` (YYYY-MM-DDTHH:MM, optional IANA timeZone)."
      : "Propose to publish a post (with the version read) right after approval.",
    input,
    permission: SOCIAL_PUBLISH,
    summary: postSummary,
    async validate(tx, scope, args) {
      await proposedSchedule(tx, scope, args.postId, args.version, when(args));
    },
    approvalContext: (tx, scope, args) => proposedSchedule(tx, scope, args.postId, args.version, when(args)),
    async revalidateContext(tx, scope, args, saved) {
      const now = await proposedSchedule(tx, scope, args.postId, args.version, when(args));
      if (now.packageHash !== (saved as ProposedSchedule | undefined)?.packageHash)
        throw new DomainError("SOCIAL_APPROVAL_STALE", 409);
    },
    async run(tx, scope, args, _requester, request) {
      const row = await entity(tx, scope, "action_requests", request!.actionRequestId);
      const stored = data(row);
      const post = await applyApprovedSchedule(tx, scope, args.postId, args.version, when(args), {
        packageHash: (stored.payload.approvalContext as ProposedSchedule).packageHash,
        requestId: row.id,
        deciderId: String(stored.decision?.userId),
      });
      return { postId: post.id, version: post.version, status: post.status };
    },
  });
}

export const socialSchedule = publishing("social_schedule", true);
export const socialPublishNow = publishing("social_publish_now", false);

const reads = [socialAccountsTool, socialCalendarTool, socialPostGetTool, socialPostStatusTool, socialValidateTool];
const proposals = [socialDraftCreate, socialDraftUpdate, socialCancel, socialSchedule, socialPublishNow];

export const socialTools = [...reads, ...proposals.map((p) => p.tool)];
export const socialMcpActionTypes = Object.fromEntries(proposals.map((p) => [p.actionType, p.action]));

export const socialInstructions = [
  "Social (module social): posts go to connected accounts (X, Facebook Pages, Instagram, Telegram channels). Read accounts with social_accounts and posts with social_calendar or social_post_get before proposing; check drafts with social_validate. Every publication needs the owner's approval in Orbit; never claim a post is published unless its publication says published.",
];
