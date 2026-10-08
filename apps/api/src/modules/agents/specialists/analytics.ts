import { z } from "zod";
import { channelTools } from "../tools/channel-tools.ts";
import {
  agentMetricsSummary,
  agentPostizAnalytics,
} from "../tools/agent-tools.ts";
import { DEFAULT_SPECIALIST_LIMITS, type Specialist } from "./types.ts";

const finding = z
  .object({
    statement: z
      .string()
      .refine((text) => text.length > 0 && text.length <= 400),
    metric: z.string().refine((text) => text.length > 0 && text.length <= 120),
    // A number a tool returned, or null when the statement is not a number.
    value: z.number().nullable(),
    // When the underlying data was fetched or its latest day, as a tool reported it.
    freshness: z
      .string()
      .refine((text) => text.length > 0 && text.length <= 80),
  })
  .strict();

/**
 * Analytics output (JC19): with no measurement at all the answer is `noData`
 * with no findings, never an invented number; findings and `noData` exclude
 * each other.
 */
export const analyticsOutput = z
  .object({
    period: z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
    findings: z.array(finding).max(10),
    noData: z.boolean(),
  })
  .strict()
  .refine((value) => value.noData === (value.findings.length === 0));

export const analyticsSpecialist: Specialist = {
  role: "analytics",
  taskClass: "agent_analytics",
  instructions: [
    "You are the analytics specialist. Report what has been measured about this assignment's channels, and nothing else.",
    "Period: the 30 days before run.date (to = the day before run.date) unless the input names another. Call metrics_summary once with that period, postiz_analytics once with the assignment's channels (at most three, postsPerChannel 3), and channel_history when you need to know which posts exist.",
    "Every finding quotes a number or a state a tool returned: statement (one factual sentence), metric (the label the tool used), value (the number, null if the finding is not a number) and freshness (the fetch time or latest day the tool reported). Compare channels or periods only with numbers from the same report; never add up different reports.",
    "Never estimate, extrapolate or assume a cause. If every tool returned no measurement (noData, measured false, errors), answer with noData true and an empty findings array. If at least one measurement exists, noData is false and findings are not empty.",
  ].join(" "),
  tools: [agentMetricsSummary, agentPostizAnalytics, ...channelTools],
  hostedTools: [],
  outputSchema: analyticsOutput,
  limits: { ...DEFAULT_SPECIALIST_LIMITS, maxWebSearches: 0 },
};
