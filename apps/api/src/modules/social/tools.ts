import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { approvedOperation, readOperation } from "../../platform/tasks/operation-tools.ts";
import type { RequestedBy } from "../action-requests.ts";
import { SOCIAL_SCOPE } from "../../platform/mcp/scopes.ts";
import { DomainError } from "../../shared.ts";
import { listAccounts } from "./accounts/accounts.ts";
import { calendarItems } from "./calendar/calendar.ts";
import { SOCIAL_COMPOSE, SOCIAL_READ } from "./permissions.ts";
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
    "List the project's connected social accounts (X, Facebook Pages, Instagram, Telegram channels) with status, whether posting is verified and the longest text a post may have. Use the accountId values when drafting posts.",
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
    "The posts timed between from and to (ISO date-times, at most 31 days apart) in time order, with status, approval, accounts and a summary of their publications. Filters: account ids, platforms, statuses, origins. At most 200 posts; truncated says when there are more.",
  input: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      accountIds: z.array(z.uuid()).max(20).optional(),
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
    "Read one post: its text per account, image metadata, schedule, approval state, check results, version and the publications with their links.",
  input: z.object({ postId: z.uuid() }).strict(),
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
    "The status of up to 20 posts and of their publications (published, failed, outcome unknown …) with links. Unknown ids are listed under missing.",
  input: z.object({ postIds: z.array(z.uuid()).min(1).max(20) }).strict(),
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
    baseMedia: z.array(z.uuid()).max(10),
    variants: z
      .array(
        z
          .object({
            accountId: z.uuid(),
            text: z.string().max(25_000).optional(),
            media: z.array(z.uuid()).max(10).optional(),
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
    "Check a draft against each account's platform rules (text length, images, options, whether the account may post) without saving it or calling a platform. Same input as a draft: baseText, baseMedia (media ids), variants with accountId and optional text, media and options.",
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

const updateInput = draftInput.extend({ postId: z.uuid(), version: z.int().min(1) }).strict();
const cancelInput = z.object({ postId: z.uuid(), version: z.int().min(1) }).strict();

/** The approval's view of a draft change: the texts per account, with handles. */
const draftSummary = (change: "create" | "update") => (args: { title?: string }, context?: { variants?: unknown }) => ({
  operation: { kind: "social_draft", change, title: args.title ?? null, variants: context?.variants ?? [] },
});

export const socialDraftCreate = approvedOperation({
  ...internal,
  ...proposal,
  name: "social_draft_create",
  description:
    "Propose a new draft post: baseText and baseMedia for all accounts, per account optional text, media and options. Check it with social_validate first. The draft is only saved; publishing needs social_schedule or social_publish_now.",
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
    "Propose new content for a post you read with social_post_get, with the version you read. A change to an approved or planned post clears its approval and makes it a draft again.",
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
    "Propose to take a planned or approved post back to a draft (its approval ends). A post being sent keeps what already went out. Pass the version you read.",
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

const reads = [socialAccountsTool, socialCalendarTool, socialPostGetTool, socialPostStatusTool, socialValidateTool];
const proposals = [socialDraftCreate, socialDraftUpdate, socialCancel];

export const socialTools = [...reads, ...proposals.map((p) => p.tool)];
export const socialMcpActionTypes = Object.fromEntries(proposals.map((p) => [p.actionType, p.action]));

export const socialInstructions = [
  "Social (module social): posts go to connected accounts (X, Facebook Pages, Instagram, Telegram channels). Read accounts with social_accounts and posts with social_calendar or social_post_get before proposing; check drafts with social_validate. Every publication needs the owner's approval in Orbit; never claim a post is published unless its publication says published.",
];
