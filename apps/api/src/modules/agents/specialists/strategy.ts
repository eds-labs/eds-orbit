import { z } from "zod";
import { agentKnowledgeSearch } from "../tools/agent-tools.ts";
import { channelTools } from "../tools/channel-tools.ts";
import { recentChannelPosts, syncChannelPosts } from "../channel-posts.ts";
import { listUsableFacts } from "../content-packages.ts";
import { sharedBriefSlots } from "../shared-posts.ts";
import { data } from "../../../shared.ts";
import { errorCode } from "../../telemetry.ts";
import {
  publishedArticlesForRun,
  type PublishedArticle,
} from "../../blog-target.ts";
import {
  ProfileError,
  slugify,
} from "../../../../../../packages/connectors/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DEFAULT_SPECIALIST_LIMITS, type Specialist } from "./types.ts";

// The history and fact base are embedded in the task input; the runner fails a call whose context is larger than its limit.
export const STRATEGY_HISTORY_DAYS = 14;
const HISTORY_PER_CHANNEL = 10;
const HISTORY_TEXT = 240;
// Offered fact text (keys and values) stops growing once it reaches this size.
const FACT_BUDGET = 6000;
const FACT_VALUE = 200;
const MAX_FACT_KEYS = 8;

export const AGENT_UNKNOWN_FACT = "AGENT_UNKNOWN_FACT";
export const AGENT_FACTS_REQUIRED = "AGENT_FACTS_REQUIRED";
export const AGENT_UNKNOWN_SLOT = "AGENT_UNKNOWN_SLOT";
export const AGENT_DUPLICATE_SLOT = "AGENT_DUPLICATE_SLOT";
export const BLOG_SLUG_EXISTS = "BLOG_SLUG_EXISTS";

const text = (max: number) =>
  z.string().refine((value) => value.length > 0 && value.length <= max);

const brief = z
  .object({
    channel: text(80),
    // The ISO time of one slot of the run, as given in the input.
    slotAt: text(40).refine((value) => Number.isFinite(Date.parse(value))),
    topic: text(200),
    angle: text(500),
    // Keys of the usable Verified Facts the post may state; checked after the answer.
    factKeys: z.array(text(160)).refine((keys) => keys.length <= MAX_FACT_KEYS),
    cta: text(200),
    imageIdea: text(400).nullable(),
    notARepeatBecause: text(400),
  })
  .strict();

export const strategyOutput = z
  .object({ briefs: z.array(brief).max(16) })
  .strict();

type Brief = z.infer<typeof brief>;
type Slot = { channel: string; at: string };

const terms = (value: string) =>
  new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * Usable facts ordered by relevance to the assignment (distinct terms of the
 * fact key and value that also occur in its name or topic frame; ties by
 * key), taken in that order until their text reaches the budget.
 */
function offeredFacts(
  rows: Awaited<ReturnType<typeof listUsableFacts>>,
  assignment: { name?: unknown; topicFrame?: unknown } | undefined,
) {
  const wanted = terms(
    `${assignment?.name ?? ""} ${assignment?.topicFrame ?? ""}`,
  );
  const ranked = rows
    .map((row) => {
      const key = String(data(row).key);
      const value = String(data(row).value ?? "").slice(0, FACT_VALUE);
      const score = [...terms(`${key} ${value}`)].filter((term) =>
        wanted.has(term),
      ).length;
      return { key, value, score };
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const offered: Array<{ key: string; value: string }> = [];
  let size = 0;
  for (const { key, value } of ranked) {
    if (size >= FACT_BUDGET) break;
    offered.push({ key, value });
    size += key.length + value.length;
  }
  return offered;
}

/**
 * Refreshes the channel history from Postiz before the strategy reads it
 * (spec D10, §7; R29). The sync throttles itself to once an hour per
 * project; a failure leaves the stored history and is logged by code only.
 */
async function syncHistory(scope: Parameters<typeof syncChannelPosts>[0]) {
  try {
    await syncChannelPosts(scope);
  } catch (error) {
    console.error("Orbit channel history sync failed", errorCode(error));
  }
}

/** A run whose article goes to the website as a pull request (R82); its one channel is the blog target. */
const githubBlog = (input: any) =>
  input?.assignment?.delivery === "github_pr" &&
  typeof input.assignment.channels?.[0] === "string";

/**
 * The published articles of a GitHub blog run (R82), read outside any
 * transaction. An unreachable GitHub fails the task: a brief written without
 * them could repeat a published slug or topic.
 */
async function loadPublished(scope: Scope, input: any) {
  if (!githubBlog(input)) return null;
  return publishedArticlesForRun(scope, input.assignment.channels[0]);
}

/** The task input plus the channel history of the last 14 days (Orbit and external posts, published and queued) and the usable Verified Facts. */
async function withContext(
  ...[tx, scope, input, loaded]: Parameters<
    NonNullable<Specialist["prepareInput"]>
  >
) {
  const now = new Date();
  // A GitHub blog run (R82) reads the published articles instead of the channel history.
  const published = githubBlog(input)
    ? ((loaded ?? []) as PublishedArticle[])
    : null;
  // A shared run (R76) gets one brief per slot group, on its strictest channel.
  const shared = input.run?.sharedAcrossChannels === true;
  const briefSlots = shared
    ? await sharedBriefSlots(tx, scope, input.run?.slots ?? [], {
        contentType: input.assignment?.contentType,
        image: input.assignment?.image,
      })
    : null;
  const slots = (briefSlots ?? ((input.run?.slots ?? []) as Slot[])) as Slot[];
  const channels = [
    ...new Set([
      ...((input.assignment?.channels ?? []) as string[]),
      ...slots.map((slot) => slot.channel),
    ]),
  ];
  const history = published
    ? null
    : await recentChannelPosts(
        tx,
        scope,
        channels,
        STRATEGY_HISTORY_DAYS,
        HISTORY_PER_CHANNEL,
        now.valueOf(),
      );
  const usable = await listUsableFacts(tx, scope, now);
  const prepared = {
    ...input,
    ...(briefSlots
      ? {
          run: {
            ...input.run,
            slots: briefSlots.map(({ channel, at, sharedChannels }) => ({
              channel,
              at,
              sharedChannels,
            })),
          },
        }
      : {}),
    ...(published || !history
      ? { publishedArticles: published }
      : {
          channelHistory: {
            days: STRATEGY_HISTORY_DAYS,
            channels: [...history]
              .filter(([, posts]) => posts.length)
              .map(([channelId, posts]) => ({
                channelId,
                posts: posts.map((post) => ({
                  source: post.source,
                  status: post.state === "QUEUE" ? "scheduled" : "published",
                  publishedAt: post.publishedAt,
                  text: post.text.slice(0, HISTORY_TEXT),
                })),
              })),
          },
        }),
    facts: offeredFacts(usable, input.assignment),
  };
  // The answer is checked against every usable key, not only the offered ones.
  return {
    input: prepared,
    context: {
      slots: slots.map(({ channel, at }) => ({ channel, at })),
      // A shared slot that stays uncovered drops every channel of its group (R76).
      members: briefSlots?.map((slot) => slot.members) ?? null,
      usableKeys: usable.map((row) => String(data(row).key)),
      ...(published
        ? { publishedSlugs: published.map((article) => article.slug) }
        : {}),
    },
  };
}

/**
 * Why a blog brief's slug cannot be used (R82), or null. Advisory: the slug
 * comes from the topic, the article's title may still differ; release and
 * delivery check the slug again.
 */
function blogSlugProblem(topic: string, publishedSlugs: string[]) {
  try {
    return publishedSlugs.includes(slugify(topic)) ? BLOG_SLUG_EXISTS : null;
  } catch (error) {
    if (error instanceof ProfileError) return error.code;
    throw error;
  }
}

/**
 * Keeps one brief per slot of the run. A brief is dropped, with its code
 * recorded, when its slot is not one of the run's, when the slot already has
 * a brief, when it names no fact or a key that is not a usable Verified Fact
 * (`AGENT_UNKNOWN_FACT`), or, for a GitHub blog run (R82), when the slug of
 * its topic is already published (`BLOG_SLUG_EXISTS`). Slots left without a
 * brief are listed as uncovered; a shared slot (R76) with every channel of
 * its group.
 */
function checkBriefs(
  output: z.infer<typeof strategyOutput>,
  _sources: ReadonlySet<string>,
  context: {
    slots: Slot[];
    usableKeys: string[];
    members?: Array<Slot[]> | null;
    publishedSlugs?: string[];
  },
) {
  const slots = context.slots;
  const usable = new Set(context.usableKeys);
  const kept = new Map<Slot, Brief>();
  const dropped: Array<{ channel: string; slotAt: string; code: string }> = [];
  for (const candidate of output.briefs) {
    const slot = slots.find(
      (s) =>
        s.channel === candidate.channel &&
        Date.parse(s.at) === Date.parse(candidate.slotAt),
    );
    const code = !slot
      ? AGENT_UNKNOWN_SLOT
      : kept.has(slot)
        ? AGENT_DUPLICATE_SLOT
        : !candidate.factKeys.length
          ? AGENT_FACTS_REQUIRED
          : candidate.factKeys.some((key) => !usable.has(key))
            ? AGENT_UNKNOWN_FACT
            : context.publishedSlugs
              ? blogSlugProblem(candidate.topic, context.publishedSlugs)
              : null;
    if (code)
      dropped.push({
        channel: candidate.channel,
        slotAt: candidate.slotAt,
        code,
      });
    else kept.set(slot!, { ...candidate, slotAt: slot!.at });
  }
  return {
    briefs: slots.flatMap((slot) => kept.get(slot) ?? []),
    dropped,
    uncovered: slots.flatMap((slot, index) =>
      kept.has(slot)
        ? []
        : (context.members?.[index] ?? [slot]).map((member) => ({
            channel: member.channel,
            slotAt: member.at,
          })),
    ),
  };
}

export const strategySpecialist: Specialist = {
  role: "strategy",
  taskClass: "agent_strategy",
  instructions: [
    "You are the strategy specialist. Write one brief for each slot in run.slots (channel and slotAt exactly as given) and none for any other time or channel.",
    "Inputs: the assignment (topicFrame, tone, channels), inputs.analytics (measured numbers, may be null), inputs.research (findings, may be null), channelHistory (posts of the last 14 days from Orbit and from other tools, published and scheduled) and facts (the usable Verified Facts most relevant to the assignment, key and value; other usable facts exist and knowledge_search can show them).",
    "A brief has: topic (what the post is about), angle (how to approach it for this channel and tone), factKeys (one to eight keys from facts that carry every concrete statement of the post; copy them exactly), cta (a call to action), imageIdea (a short picture idea if the assignment has an image, else null) and notARepeatBecause (one sentence naming how it differs from the posts in channelHistory, including scheduled ones and posts from other tools).",
    "Research findings are unverified leads: they may inspire topic and angle but never become claims. Only the facts named in factKeys may be stated as fact; use no figure, name, date or URL that is not in a fact you have seen. Analytics numbers may justify what to emphasize, never an invented claim. If a slot has no suitable fact, leave the slot out.",
    "Do not repeat a topic or angle of channelHistory on the same channel. Use channel_history for older posts and knowledge_search only to understand a fact, never to add new claims.",
    "If a slot lists sharedChannels, its one post goes out unchanged on every one of those channels: write one brief for it that suits all of them and avoids every one of their recent posts.",
    "If assignment.format is set, plan each post for it: format.minChars to format.maxChars characters, format.hashtags.min to format.hashtags.max hashtags, short paragraphs when format.paragraphs is true, leading to format.cta as its link when set.",
    "If assignment.delivery is github_pr, the run writes one website article: write exactly one brief for its one slot. There is no channelHistory; publishedArticles lists the articles already on the website (slug, title, category, keywords, publishedAt). The topic is the article's working title in English; its slug (the topic in lowercase words joined by hyphens) must not be the slug of a published article, and the article must not cover a published article's topic again. The angle states the search intent, the target keywords and an outline of 5 to 8 sections. notARepeatBecause names how it differs from publishedArticles.",
  ].join(" "),
  tools: [agentKnowledgeSearch, ...channelTools],
  hostedTools: [],
  outputSchema: strategyOutput,
  limits: { ...DEFAULT_SPECIALIST_LIMITS, maxWebSearches: 0 },
  refresh: syncHistory,
  load: loadPublished,
  prepareInput: withContext,
  finalize: checkBriefs,
};
