import { z } from "zod";
import { createPostizClient } from "../../../../../../packages/connectors/src/index.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { runReadTool, validateReadToolResult } from "../../chat-tools.ts";
import { data, decrypt, DomainError, list } from "../../../shared.ts";
import { assignedPostizChannels } from "../../postiz-assignment.ts";
import { runBudgetKey } from "../specialists/runner.ts";
import { readTools } from "./read-tools.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

/**
 * Tools only the Analytics and Research specialists receive (spec §5). They
 * are read-only, offered to no chat run and absent from `chatTools`; the role
 * definitions list them directly.
 */
const DAY = 86_400_000;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 120;
const METRIC_GROUPS = 20;
const everyone = ["viewer", "editor", "owner"] as const;
const dateText = z.iso.date();
// Counters a metric can carry; sums are formed only within one report (same denominator).
const COUNTERS = [
  "sessions",
  "pageviews",
  "clicks",
  "impressions",
  "conversions",
] as const;

const metricsInput = z
  .object({
    from: dateText.nullish(),
    to: dateText.nullish(),
  })
  .strict();

/** The period of a request: `to` inclusive, last 30 days by default, at most 120 days. */
function period(raw: z.infer<typeof metricsInput>, now: Date) {
  const to = raw.to
    ? Date.parse(`${raw.to}T00:00:00.000Z`)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = raw.from
    ? Date.parse(`${raw.from}T00:00:00.000Z`)
    : to - (DEFAULT_PERIOD_DAYS - 1) * DAY;
  if (from > to || (to - from) / DAY >= MAX_PERIOD_DAYS)
    throw new DomainError("ANALYTICS_PERIOD_INVALID", 400);
  return { from, to, toExclusive: to + DAY };
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Metrics the project stores (Matomo imports and other sources) in a period,
 * summed per report: different reports have different denominators and are
 * never added together. Reads stored rows only; freshness is the time the
 * provider data was fetched.
 */
export async function metricsSummary(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  const window = period(metricsInput.parse(raw ?? {}), now);
  const rows = (await list(tx, scope, "metrics")).filter((row) => {
    const start = Date.parse(data(row).periodStart);
    const end = Date.parse(data(row).periodEnd);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= window.from &&
      end <= window.toExclusive
    );
  });
  type Group = {
    source: string;
    report: string;
    label: string | null;
    days: Set<string>;
    totals: Record<(typeof COUNTERS)[number], number | null>;
    fetchedAt: string;
    complete: boolean;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const m = data(row);
    const key = String(m.accountId ?? `${m.source}:${m.reportFamily ?? ""}`);
    const group: Group = groups.get(key) ?? {
      source: String(m.source ?? "unknown"),
      report: String(m.reportFamily ?? m.reportMethod ?? ""),
      label: typeof m.campaign === "string" ? m.campaign.slice(0, 200) : null,
      days: new Set<string>(),
      totals: Object.fromEntries(
        COUNTERS.map((name) => [name, null]),
      ) as Group["totals"],
      fetchedAt: "",
      complete: true,
    };
    group.days.add(String(m.periodStart).slice(0, 10));
    for (const name of COUNTERS)
      if (typeof m[name] === "number")
        group.totals[name] = (group.totals[name] ?? 0) + m[name];
    const fetchedAt = String(
      m.providerFetchedAt ?? row.updatedAt.toISOString(),
    );
    if (fetchedAt > group.fetchedAt) group.fetchedAt = fetchedAt;
    if (m.complete === false) group.complete = false;
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort(
    (a, b) =>
      (b.totals.sessions ?? b.totals.clicks ?? 0) -
      (a.totals.sessions ?? a.totals.clicks ?? 0),
  );
  return {
    period: { from: day(window.from), to: day(window.to) },
    measured: rows.length,
    // Honest empty answer: nothing was measured in the period.
    noData: rows.length === 0,
    truncated: ranked.length > METRIC_GROUPS,
    reports: ranked.slice(0, METRIC_GROUPS).map((group) => ({
      source: group.source,
      report: group.report,
      label: group.label,
      days: group.days.size,
      ...group.totals,
      freshness: group.fetchedAt,
      complete: group.complete,
    })),
  };
}

const metricsSummaryTool = defineTool({
  name: "metrics_summary",
  namespace: "analytics",
  description:
    "Stored website and campaign measurements (for example Matomo) of this project for a period, summed per report with the time the data was fetched; noData is true when nothing was measured. Dates are YYYY-MM-DD, the last 30 days when null.",
  parameters: z
    .object({
      from: z.string().nullable().describe("First day, YYYY-MM-DD"),
      to: z.string().nullable().describe("Last day, YYYY-MM-DD"),
    })
    .strict(),
  risk: "R0_read",
  roles: everyone,
  feature: "agents",
  deferLoading: false,
  async execute(context, args) {
    const output = await scoped(
      context.scope.workspaceId,
      context.scope.projectId,
      (tx) => metricsSummary(tx, context.scope, dropNullFields(args)),
    );
    return { output, cards: [] };
  },
});

// Postiz allows 30 public API requests per hour for the whole project.
const MAX_CHANNELS = 3;
const MAX_POSTS_PER_CHANNEL = 3;
const MAX_REQUESTS_PER_TASK = 10;
const POST_WINDOW_DAYS = 30;
const SERIES_POINTS = 7;

type PostizAnalyticsClient = {
  getIntegrationAnalytics(id: string): Promise<AnalyticsSeries>;
  getPostAnalytics(id: string): Promise<AnalyticsSeries>;
};
type AnalyticsSeries = Array<{
  label: string;
  data: Array<{ total: string | number; date: string }>;
  percentageChange?: number | null;
}>;
// What one task already asked Postiz: a repeated question is answered from here, never asked again.
type TaskAnalytics = { requests: number; answers: Map<string, unknown> };
const TASK_CACHE_SIZE = 100;
const taskAnalytics = new Map<string, TaskAnalytics>();

function taskCache(taskId: string) {
  let cache = taskAnalytics.get(taskId);
  if (!cache) {
    cache = { requests: 0, answers: new Map() };
    taskAnalytics.set(taskId, cache);
    if (taskAnalytics.size > TASK_CACHE_SIZE)
      taskAnalytics.delete(taskAnalytics.keys().next().value!);
  }
  return cache;
}

/** Per label: the newest points, their sum and the latest value, as numbers the specialist can quote. */
function summarize(series: AnalyticsSeries) {
  return series.slice(0, 12).map((entry) => {
    const points = entry.data
      .map((point) => ({ date: point.date, total: Number(point.total) }))
      .filter((point) => Number.isFinite(point.total))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      label: entry.label.slice(0, 100),
      sum: points.reduce((sum, point) => sum + point.total, 0),
      latest: points.at(-1) ?? null,
      recent: points.slice(-SERIES_POINTS),
      percentageChange: entry.percentageChange ?? null,
    };
  });
}

const postizInput = z
  .object({
    channels: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(MAX_CHANNELS),
    postsPerChannel: z
      .number()
      .int()
      .min(0)
      .max(MAX_POSTS_PER_CHANNEL)
      .nullish(),
  })
  .strict();

async function postizClient(scope: Scope) {
  const connector = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = (await list(tx, scope, "connectors")).find(
        (candidate) =>
          data(candidate).provider === "postiz" &&
          ["read_verified", "write_verified"].includes(data(candidate).status),
      );
      if (!row) return null;
      const posts = (await list(tx, scope, "channel_posts")).map((post) =>
        data(post),
      );
      return { value: data(row), posts };
    },
  );
  if (
    !connector ||
    !connector.value.baseUrl ||
    !connector.value.encryptedCredential
  )
    throw new DomainError("POSTIZ_NOT_CONNECTED", 409);
  return {
    channelIds: assignedPostizChannels(connector.value).map((channel: any) =>
      String(channel.id),
    ),
    posts: connector.posts,
    client: createPostizClient({
      baseUrl: connector.value.baseUrl as string,
      token: decrypt(
        connector.value.encryptedCredential as string,
        process.env.CREDENTIAL_KEY!,
      ),
    }) as PostizAnalyticsClient,
  };
}

/**
 * Postiz analytics of assigned channels and of their newest published posts
 * (from the stored channel history). One request per channel and per post at
 * most once per task, ten requests per task: Postiz allows 30 requests per
 * hour for the whole project and the history sync uses some of them.
 */
export async function postizAnalytics(
  scope: Scope,
  taskId: string,
  raw: unknown,
  now = new Date(),
) {
  const input = postizInput.parse(raw);
  const { channelIds, posts, client } = await postizClient(scope);
  const cache = taskCache(taskId);
  async function once(key: string, request: () => Promise<AnalyticsSeries>) {
    if (cache.answers.has(key)) return cache.answers.get(key);
    if (cache.requests >= MAX_REQUESTS_PER_TASK)
      return { error: "POSTIZ_ANALYTICS_LIMIT" };
    cache.requests++;
    let answer: unknown;
    try {
      const series = summarize(await request());
      answer = series.length
        ? { measured: true, metrics: series }
        : { measured: false, metrics: [] };
    } catch {
      answer = { error: "POSTIZ_ANALYTICS_UNAVAILABLE" };
    }
    cache.answers.set(key, answer);
    return answer;
  }
  const since = now.valueOf() - POST_WINDOW_DAYS * DAY;
  const channels = [];
  for (const channelId of [...new Set(input.channels)]) {
    if (!channelIds.includes(channelId)) {
      channels.push({ channelId, error: "CHANNEL_NOT_ASSIGNED" });
      continue;
    }
    const channel = await once(`channel:${channelId}`, () =>
      client.getIntegrationAnalytics(channelId),
    );
    const newest = posts
      .filter(
        (post) =>
          post.channel === channelId &&
          post.state === "PUBLISHED" &&
          Date.parse(post.publishedAt) >= since,
      )
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, input.postsPerChannel ?? 0);
    const postAnswers = [];
    for (const post of newest)
      postAnswers.push({
        postId: String(post.remoteId),
        publishedAt: post.publishedAt,
        ...((await once(`post:${post.remoteId}`, () =>
          client.getPostAnalytics(String(post.remoteId)),
        )) as object),
      });
    channels.push({ channelId, channel, posts: postAnswers });
  }
  return { fetchedAt: now.toISOString(), channels };
}

const postizAnalyticsTool = defineTool({
  name: "postiz_analytics",
  namespace: "analytics",
  description:
    "Postiz analytics of up to three assigned channels, optionally with the newest published posts of each (up to three), as numbers per label with the latest value and recent days; read-only, one request per channel and post per task.",
  parameters: z
    .object({
      channels: z
        .array(z.string())
        .describe("Assigned channel IDs, one to three"),
      postsPerChannel: z
        .number()
        .int()
        .nullable()
        .describe(
          "Newest published posts per channel to include, 0 to 3; 0 when null",
        ),
    })
    .strict(),
  risk: "R0_read",
  roles: everyone,
  feature: "agents",
  deferLoading: false,
  async execute(context, args) {
    if (!context.agentTask)
      throw new DomainError("AGENT_TOOL_NOT_ALLOWED", 403);
    return {
      output: await postizAnalytics(
        context.scope,
        context.agentTask.taskId,
        dropNullFields(args),
      ),
      cards: [],
    };
  },
});

const chatKnowledgeSearch = readTools.find(
  (tool) => tool.name === "knowledge_search",
)!;

/**
 * `knowledge_search` for a specialist: the chat tool reserves its query
 * embedding under `chat:<runId>`; here the retrieval reserves under the task
 * (`query:agent:<taskId>:...`, counted in the task's cost) and the run's
 * budget key, so the run and assignment ceilings see it.
 */
const knowledgeSearchTool: OrbitTool = defineTool({
  ...chatKnowledgeSearch,
  feature: "agents",
  deferLoading: false,
  async execute(context, args) {
    if (!context.agentTask)
      throw new DomainError("AGENT_TOOL_NOT_ALLOWED", 403);
    const { taskId, runId } = context.agentTask;
    const read = await runReadTool(
      context.scope,
      "knowledge_search",
      dropNullFields(args),
      {
        retrievalJobKey: `agent:${taskId}:knowledge:${context.callIndex}`,
        budgetRunKey: runBudgetKey(runId),
      },
    );
    const checked = validateReadToolResult(
      "knowledge_search",
      read.result,
      read.cards,
    );
    return { output: checked.result, cards: checked.cards };
  },
});

export const agentMetricsSummary = metricsSummaryTool;
export const agentPostizAnalytics = postizAnalyticsTool;
export const agentKnowledgeSearch = knowledgeSearchTool;
