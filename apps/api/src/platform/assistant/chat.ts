import { z } from "zod";
import { splitNotice } from "./notices.ts";
import { afterCommit, DbTx } from "../../../../../packages/db/src/index.ts";
import { userScoped } from "../tenancy/scope.ts";
import { type Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, create, DomainError, entity, update } from "../../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { registeredConversationSections } from "../modules/contributions.ts";
import { visibleModules } from "../tenancy/module-roles.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { publishChange } from "../realtime/fanout.ts";
import { resourceCardValid, type ChatCard } from "./cards.ts";
import {
  assertPersonalTurnAllowed,
  hintsCard,
  isInternalCard,
  pageContextInput,
  projectCardsChecked,
  projectKind,
  readRunSteps,
  storedHints,
  validateHints,
  type RunStep,
} from "./personal-mode.ts";

export const sendInput = z
  .object({
    text: z.string().trim().min(1).max(4000),
    clientRequestId: z.uuid(),
    // Personal mode only (ADR 0022 §9): hints the server checks and keeps
    // only for a business project the sender may read; ignored elsewhere.
    pageContext: pageContextInput.optional(),
    focusProjectId: z.uuid().optional(),
  })
  .strict();
// The user-scoped transaction moved to the platform (WP1.1).
export const chatScoped = userScoped;

export function where(scope: Scope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    userId: scope.userId,
  };
}

export async function conversation(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.chatConversation.findFirst({
    where: { ...where(scope), id },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export async function createConversation(scope: Scope) {
  return chatScoped(scope, (tx) =>
    tx.chatConversation.create({ data: where(scope) }),
  );
}

/** Conversation IDs this user archived; archiving hides, it never deletes. */
async function archivedConversationIds(tx: DbTx, scope: Scope) {
  const rows = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "chat_archives",
      data: { path: ["userId"], equals: scope.userId },
    },
  });
  return rows
    .filter((row) => data(row).archived === true)
    .map((row) => String(data(row).conversationId));
}

export async function archiveConversation(
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { archived } = z.object({ archived: z.boolean() }).strict().parse(raw);
  return chatScoped(scope, async (tx) => {
    await conversation(tx, scope, id);
    const active = await tx.chatRun.findFirst({
      where: {
        ...where(scope),
        conversationId: id,
        status: { in: ["queued", "running"] },
      },
    });
    if (archived && active) throw new DomainError("CHAT_RUN_IN_PROGRESS", 409);
    const existing = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind: "chat_archives",
        data: { path: ["conversationId"], equals: id },
      },
    });
    const mine = existing.find((row) => data(row).userId === scope.userId);
    const state = {
      conversationId: id,
      userId: scope.userId,
      archived,
      changedAt: new Date().toISOString(),
    };
    if (mine) await update(tx, scope, mine, state);
    else if (archived) await create(tx, scope, "chat_archives", state);
    return { id, archived };
  });
}

export async function listConversations(
  scope: Scope,
  cursor?: string,
  archived = false,
) {
  return chatScoped(scope, async (tx) => {
    const hidden = await archivedConversationIds(tx, scope);
    const items = await tx.chatConversation.findMany({
      where: {
        ...where(scope),
        id: archived ? { in: hidden } : { notIn: hidden },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return {
      items: items.slice(0, 20),
      nextCursor: items.length > 20 ? (items[19]?.id ?? null) : null,
    };
  });
}

export async function getConversation(scope: Scope, id: string) {
  // Cards of other projects (personal mode) are checked afterwards, each in
  // its own project's transaction, never inside this one.
  return projectCardsChecked(scope, await conversationRead(scope, id));
}

async function conversationRead(scope: Scope, id: string) {
  return chatScoped(scope, async (tx) => {
    const row = await conversation(tx, scope, id);
    const savedMessages = await tx.chatMessage.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { sequence: "asc" },
      take: 200,
    });
    const cardIds = savedMessages.flatMap((message) =>
      Array.isArray(message.cards)
        ? (message.cards as any[])
            .map((card) => card.resourceId)
            .filter((value) => typeof value === "string")
        : [],
    );
    const cardResources = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        id: { in: cardIds },
      },
    });
    const messages = savedMessages.map((message) => {
      // A personal-mode user message's hints (internal card, WP3.4).
      const hints = message.role === "user" ? storedHints(message.cards) : null;
      return {
        ...message,
        // A notice's metadata is its first stored card (ADR 0022, T3-2).
        ...(message.role === "notice"
          ? { notice: splitNotice(message.cards).notice ?? null }
          : {}),
        ...(hints ? { pageContext: hints } : {}),
        cards: Array.isArray(message.cards)
          ? (message.role === "notice"
              ? (splitNotice(message.cards).cards as any[])
              : (message.cards as any[])
            )
              .filter((card) => !isInternalCard(card))
              .map((card) => {
                // A card of another project is checked in that project.
                if (!card.resourceId || card.projectId) return card;
                const resource = cardResources.find(
                  (candidate) => candidate.id === card.resourceId,
                );
                const valid = resourceCardValid(card, resource);
                return { ...card, status: valid ? card.status : "stale" };
              })
          : [],
      };
    });
    const runs = await tx.chatRun.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const proposals = await tx.chatProposal.findMany({
      where: { ...where(scope), conversationId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const jobs = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "jobs",
        id: {
          in: proposals.flatMap((proposal) =>
            proposal.jobId ? [proposal.jobId] : [],
          ),
        },
      },
    });
    const contents = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "content",
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const linked = proposals.map((proposal) => {
      const job = jobs.find((candidate) => candidate.id === proposal.jobId);
      const content = contents.find(
        (candidate) => data(candidate).jobId === proposal.jobId,
      );
      return {
        ...proposal,
        action: job
          ? {
              status: data(job).status,
              error: data(job).error ?? null,
              contentId: content?.id ?? null,
            }
          : null,
      };
    });
    // Module fields such as content packages and assignments (WP2.2).
    const read: Record<string, any> = {
      conversation: row,
      messages,
      runs,
      proposals: linked,
    };
    // Only enabled modules add their fields (WP2.4).
    // A module the member has no access to adds nothing either (WP4.5).
    for (const add of registeredConversationSections(
      visibleModules(scope, await enabledModules(tx, scope)),
    ))
      Object.assign(read, await add(tx, scope, id, messages));
    return read as {
      conversation: typeof row;
      messages: typeof messages;
      runs: typeof runs;
      proposals: typeof linked;
    } & Record<string, any>;
  });
}

export async function sendMessage(scope: Scope, id: string, raw: unknown) {
  const { pageContext, focusProjectId, ...input } = sendInput.parse(raw);
  // A personal space (ADR 0022): the gate, then the hints, both checked
  // before its transaction (the hints read other projects).
  const project = await projectKind(scope.projectId);
  let cards: ChatCard[] | undefined;
  if (project?.kind === "personal") {
    await assertPersonalTurnAllowed(scope, project);
    const hints = await validateHints(scope, { pageContext, focusProjectId });
    if (hints.pageContext || hints.focusProjectId) cards = [hintsCard(hints)];
  }
  return chatScoped(scope, (tx) =>
    sendMessageInTransaction(tx, scope, id, input, cards),
  );
}

/** Shared atomic enqueue for UI chat and delegated tasks. */
export async function sendMessageInTransaction(
  tx: DbTx,
  scope: Scope,
  id: string,
  input: z.infer<typeof sendInput>,
  // Internal cards stored with the user message (personal-mode hints).
  cards?: ChatCard[],
) {
  const thread = await conversation(tx, scope, id);
  const prior = await tx.chatRun.findUnique({
    where: {
      conversationId_clientRequestId: {
        conversationId: id,
        clientRequestId: input.clientRequestId,
      },
    },
  });
  if (prior)
    return { runId: prior.id, jobId: prior.jobId, status: prior.status };
  const active = await tx.chatRun.findFirst({
    where: {
      ...where(scope),
      conversationId: id,
      status: { in: ["queued", "running"] },
    },
  });
  if (active) throw new DomainError("CHAT_RUN_IN_PROGRESS", 409);
  // A paused project runs no jobs, so a reply would never come.
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
  const last = await tx.chatMessage.findFirst({
    where: { ...where(scope), conversationId: id },
    orderBy: { sequence: "desc" },
  });
  await tx.chatMessage.create({
    data: {
      ...where(scope),
      conversationId: id,
      sequence: (last?.sequence ?? 0) + 1,
      role: "user",
      text: input.text,
      ...(cards?.length ? { cards: cards as object[] } : {}),
    },
  });
  const run = await tx.chatRun.create({
    data: {
      ...where(scope),
      conversationId: id,
      clientRequestId: input.clientRequestId,
    },
  });
  const job = await enqueue(tx, scope, "chat", run.id, "chat:" + run.id);
  await tx.chatRun.update({ where: { id: run.id }, data: { jobId: job.id } });
  await tx.chatConversation.update({
    where: { id },
    data: {
      title:
        thread.title === "New conversation"
          ? input.text.slice(0, 80)
          : thread.title,
    },
  });
  return { runId: run.id, jobId: job.id, status: "queued" };
}

/**
 * A reply that will not run because the project is paused ends visibly. Chat
 * rows are private to their sender, so this runs as the job's actor.
 */
export async function stopChatRunForPause(
  tx: DbTx,
  job: Record<string, unknown>,
  scope: Scope,
) {
  const runId = String(job.resourceId);
  await tx.$executeRaw`SELECT set_config('app.user_id',${String(job.actorId)},true)`;
  const stopped = await tx.chatRun.updateMany({
    // A running reply checked the pause before its model call and finishes.
    where: { id: runId, status: "queued" },
    data: {
      status: "blocked",
      errorCode: "PROJECT_PAUSED",
      sequence: { increment: 1 },
    },
  });
  await tx.$executeRaw`SELECT set_config('app.user_id','',true)`;
  if (stopped.count) afterCommit(tx, () => runChanged(scope, runId));
}

/** A run's stream on the real-time fan-out (WP4.3 Part B). */
export const runStream = (runId: string) => `chat-run:${runId}`;
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "blocked",
  "canceled",
];

/**
 * Wakes the run's SSE subscribers. Call it after the transaction that
 * changed the run returned; `sequence` lets subscribers that already have
 * it skip the read.
 */
export function runChanged(scope: Scope, runId: string, sequence?: number) {
  void publishChange(scope.projectId, runStream(runId), sequence);
}

/** The SSE snapshot of a run: the whole state, so the latest one suffices. */
export function runSnapshot(run: {
  id: string;
  status: string;
  partialText: string | null;
  errorCode: string | null;
  sequence: number;
  /** A personal run's progress steps (WP3.4); absent in project chat. */
  steps?: RunStep[];
}) {
  return {
    id: run.id,
    status: run.status,
    partialText: run.partialText,
    errorCode: run.errorCode,
    sequence: run.sequence,
    ...(run.steps ? { steps: run.steps } : {}),
  };
}

export async function getRun(scope: Scope, runId: string) {
  return chatScoped(scope, async (tx) => {
    const run = await tx.chatRun.findFirst({
      where: { ...where(scope), id: runId },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    // Progress steps exist for personal runs only (WP3.4).
    const steps = await readRunSteps(tx, scope, runId);
    return steps ? { ...run, steps } : run;
  });
}

export async function cancelRun(scope: Scope, runId: string) {
  const run = await chatScoped(scope, async (tx) => {
    const run = await tx.chatRun.findFirst({
      where: { ...where(scope), id: runId },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    if (["succeeded", "blocked", "failed", "canceled"].includes(run.status))
      return run;
    return tx.chatRun.update({
      where: { id: run.id },
      data: { status: "canceled", sequence: { increment: 1 } },
    });
  });
  runChanged(scope, runId, run.sequence);
  return run;
}
