import { z } from "zod";
import { agentKnowledgeSearch } from "../tools/agent-tools.ts";
import { channelTools } from "../tools/channel-tools.ts";
import { recentChannelPosts, syncChannelPosts } from "../channel-posts.ts";
import { listUsableFacts } from "../content-packages.ts";
import { data } from "../../../shared.ts";
import { errorCode } from "../../telemetry.ts";
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

/** The task input plus the channel history of the last 14 days (Orbit and external posts, published and queued) and the usable Verified Facts. */
async function withContext(
  ...[tx, scope, input]: Parameters<NonNullable<Specialist["prepareInput"]>>
) {
  const now = new Date();
  const slots = (input.run?.slots ?? []) as Slot[];
  const channels = [
    ...new Set([
      ...((input.assignment?.channels ?? []) as string[]),
      ...slots.map((slot) => slot.channel),
    ]),
  ];
  const history = await recentChannelPosts(
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
    facts: offeredFacts(usable, input.assignment),
  };
  // The answer is checked against every usable key, not only the offered ones.
  return {
    input: prepared,
    context: {
      slots,
      usableKeys: usable.map((row) => String(data(row).key)),
    },
  };
}

/**
 * Keeps one brief per slot of the run. A brief is dropped, with its code
 * recorded, when its slot is not one of the run's, when the slot already has
 * a brief, when it names no fact or a key that is not a usable Verified Fact
 * (`AGENT_UNKNOWN_FACT`). Slots left without a brief are listed as uncovered.
 */
function checkBriefs(
  output: z.infer<typeof strategyOutput>,
  _sources: ReadonlySet<string>,
  context: { slots: Slot[]; usableKeys: string[] },
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
    uncovered: slots
      .filter((slot) => !kept.has(slot))
      .map((slot) => ({ channel: slot.channel, slotAt: slot.at })),
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
  ].join(" "),
  tools: [agentKnowledgeSearch, ...channelTools],
  hostedTools: [],
  outputSchema: strategyOutput,
  limits: { ...DEFAULT_SPECIALIST_LIMITS, maxWebSearches: 0 },
  refresh: syncHistory,
  prepareInput: withContext,
  finalize: checkBriefs,
};
