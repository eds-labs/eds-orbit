import { z } from "zod";
import { readOperation } from "../../platform/tasks/operation-tools.ts";
import { SOCIAL_SCOPE } from "../../platform/mcp/scopes.ts";
import { DomainError } from "../../shared.ts";
import { listAccounts } from "./accounts/accounts.ts";
import { calendarItems } from "./calendar/calendar.ts";
import { SOCIAL_COMPOSE, SOCIAL_READ } from "./permissions.ts";
import { draftIssues, getPost, type PostView } from "./posts/posts.ts";
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

const reads = [socialAccountsTool, socialCalendarTool, socialPostGetTool, socialPostStatusTool, socialValidateTool];

export const socialTools = [...reads];

export const socialInstructions = [
  "Social (module social): posts go to connected accounts (X, Facebook Pages, Instagram, Telegram channels). Read accounts with social_accounts and posts with social_calendar or social_post_get before proposing; check drafts with social_validate. Every publication needs the owner's approval in Orbit; never claim a post is published unless its publication says published.",
];
