import { z } from "zod";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { runStructured } from "../agents/structured-run.ts";

// The optional AI summary of a briefing (ADR 0023 item 8, plan §2.5): the
// platform run template `platform.briefing_summarizer`. Opt-in per user;
// it runs in the user's personal space, so its spend is the personal
// space's (the user's assistant cap, ADR 0022 D-09), on the paid path of
// every structured run (spend mandate, a reservation per call, settlement,
// an unclear outcome never sent again). Read-only: the model gets the
// deterministic briefing as data and no tools at all, so it cannot reach
// anything the briefing did not already show. Its own ceiling is USD 0.05.
//
// The personal space hosts no configured agents, so this is not an agent
// work order: it uses the same bounded run host the work orders use.

export const BRIEFING_SUMMARIZER = {
  key: "platform.briefing_summarizer",
  ceilingMicros: 50_000,
  limits: {
    maxModelCalls: 2,
    maxToolCalls: 4,
    maxWebSearches: 0,
    timeoutMs: 60_000,
    maxInputBytes: 24_000,
  },
} as const;

const INSTRUCTIONS =
  "Summarize the user's briefing in at most three short sentences in the requested language: what needs a decision first, then what failed, then the rest. Use only the numbers and project names in the input. Never invent items, names, numbers or advice beyond the input.";

export const summaryOutput = z.strictObject({ summary: z.string().min(1).max(600) });

/** The run's own ceiling: an estimate above the remaining share is refused before sending. */
export function ceilingCheck(spent: { micros: number }) {
  return async (_tx: unknown, _scope: unknown, estimateMicros: number) => {
    if (spent.micros + estimateMicros > BRIEFING_SUMMARIZER.ceilingMicros)
      throw new DomainError("BRIEFING_SUMMARY_CEILING", 409);
    spent.micros += estimateMicros;
  };
}

/** Runs the summary of one briefing slot; the caller keeps the deterministic briefing on failure. */
export async function summarizeBriefing(
  personal: Scope,
  input: { slot: string; locale: "en" | "de"; briefing: unknown },
) {
  const key = `briefing:${input.slot}`;
  return runStructured(personal, {
    agentName: BRIEFING_SUMMARIZER.key,
    taskClass: "chat_operator",
    kind: "chat",
    subject: { type: "platform.briefing", id: input.slot },
    instructions: INSTRUCTIONS,
    input: { language: input.locale, briefing: input.briefing },
    tools: [],
    outputSchema: summaryOutput,
    limits: BRIEFING_SUMMARIZER.limits,
    budget: {
      category: "assistant_briefing",
      runKey: key,
      callKey: key,
      check: ceilingCheck({ micros: 0 }),
    },
  });
}
