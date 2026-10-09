import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import { create, data, entity, list, update } from "../../src/shared.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../../src/modules/agents/assignments.ts";
import { TELEGRAM, X, type createPackageProject } from "./package-project.ts";

export const BLOG = "blog-int";

/** 06:00 in Berlin tomorrow: the run for 10:00 and 17:00 is due (lead 360 minutes). */
export function tomorrowMorning() {
  const today = new Date();
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + 1,
      4,
    ),
  );
}

/** A model reply whose final message is `value` as JSON. */
export const message = (value: unknown) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});

/** A recorded draft from the mocked `generate`. */
export const generated = (
  body: string,
  claims: unknown[] = [{ text: "Learn more.", kind: "style" }],
) => ({
  responseId: "resp_draft",
  output: { title: "Beta post", body, claims },
  usage: {
    model: "synthetic-model",
    inputTokens: 40,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    costMicros: 5,
  },
});

export const embedded = () => ({
  vectors: [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))],
  usage: {
    model: "text-embedding-3-small",
    inputTokens: 20,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costMicros: 1,
  },
});

/**
 * Helpers for a synthetic assignment run up to its review step: a confirmed
 * assignment, a planned run whose analytics, research and strategy are
 * settled with given briefs, and the project's Telegram connection.
 */
export function assignmentRun(
  project: Awaited<ReturnType<typeof createPackageProject>>,
  morning = tomorrowMorning(),
) {
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const rows = (kind: string) =>
    run((tx) => list(tx, project.owner, kind)).then((found) =>
      found.map((row): Record<string, any> => ({
        id: row.id,
        version: row.version,
        ...data(row),
      })),
    );
  const task = async (stepKey: string) =>
    (await rows("agent_tasks")).find((t) => t.stepKey === stepKey)!;
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const makeAssignment = (changes: Record<string, unknown> = {}) => {
    const content = {
      name: "Two posts a day",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X],
      topicFrame: "Short updates about beta access for product teams",
      tone: "Calm and concrete",
      image: false,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
      ...changes,
    };
    return run((tx) =>
      create(tx, project.owner, "assignments", {
        ...content,
        status: "active",
        actionRequestId: null,
        confirmation: {
          userId: project.owner.userId,
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(content),
          imageRightsConsent: content.image === true,
        },
      }),
    );
  };
  const brief = (
    slot: { channel: string; at: string },
    changes: Record<string, unknown> = {},
  ) => ({
    channel: slot.channel,
    slotAt: slot.at,
    topic: `Beta access on ${slot.channel} at ${slot.at}`,
    angle: "Lead with what teams can do on day one.",
    factKeys: ["beta.access"],
    cta: "Join the beta.",
    imageIdea: null,
    notARepeatBecause: "Earlier posts announced the beta, this one shows use.",
    ...changes,
  });
  /** Plans the run and settles every step before the copywriters: strategy with these briefs. */
  const planWithBriefs = async (
    briefsFor: (
      slots: Array<{ channel: string; at: string }>,
    ) => Array<Record<string, unknown>>,
  ) => {
    await run((tx) => planAssignmentRuns(tx, project.owner, morning));
    const [runRow] = await rows("assignment_runs");
    const slots = runRow!.slots as Array<{ channel: string; at: string }>;
    const briefs = briefsFor(slots);
    for (const role of ["analytics", "research", "strategy"]) {
      const found = (await rows("agent_tasks")).find((t) => t.role === role);
      if (!found) continue;
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", found.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: role === "strategy" ? "done" : "failed",
          output:
            role === "strategy" ? { briefs, dropped: [], uncovered: [] } : null,
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    return { runId: runRow!.id as string, slots, briefs };
  };
  /** Binds a (synthetic) Telegram chat to the project, as the bot's `/start <code>` does. */
  const connectTelegram = (
    status = "linked",
    linkedAt: string | null = status === "linked"
      ? new Date().toISOString()
      : null,
  ) =>
    run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status,
        chatId: "synthetic-chat",
        userId: project.owner.userId,
        ...(linkedAt ? { linkedAt } : {}),
      }),
    );
  return {
    run,
    worker,
    rows,
    task,
    setPolicy,
    makeAssignment,
    brief,
    planWithBriefs,
    connectTelegram,
    TELEGRAM,
    X,
  };
}
