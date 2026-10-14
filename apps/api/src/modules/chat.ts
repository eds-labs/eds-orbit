import { z } from "zod";
import { DbTx } from "../../../../packages/db/src/index.ts";
import { userScoped } from "../platform/tenancy/scope.ts";
import { type Scope } from "../../../../packages/schemas/src/index.ts";
import { data, create, DomainError, entity, update } from "../shared.ts";
import { enqueue } from "../platform/jobs/enqueue.ts";
import { registeredConversationSections } from "../platform/modules/contributions.ts";
import { enabledModules } from "../platform/modules/enforcement.ts";

export const sendInput = z
  .object({
    text: z.string().trim().min(1).max(4000),
    clientRequestId: z.uuid(),
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
    const messages = savedMessages.map((message) => ({
      ...message,
      cards: Array.isArray(message.cards)
        ? (message.cards as any[]).map((card) => {
            if (!card.resourceId) return card;
            const resource = cardResources.find(
              (candidate) => candidate.id === card.resourceId,
            );
            const valid =
              resource &&
              resource.version === card.version &&
              (card.kind === "source"
                ? data(resource).status === "active"
                : data(resource).usageApproved === true &&
                  data(resource).assetStatus === "approved");
            return { ...card, status: valid ? card.status : "stale" };
          })
        : [],
    }));
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
    for (const add of registeredConversationSections(
      await enabledModules(tx, scope),
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
  const input = sendInput.parse(raw);
  return chatScoped(scope, async (tx) => {
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
  });
}

/**
 * A reply that will not run because the project is paused ends visibly. Chat
 * rows are private to their sender, so this runs as the job's actor.
 */
export async function stopChatRunForPause(
  tx: DbTx,
  job: Record<string, unknown>,
) {
  await tx.$executeRaw`SELECT set_config('app.user_id',${String(job.actorId)},true)`;
  await tx.chatRun.updateMany({
    // A running reply checked the pause before its model call and finishes.
    where: { id: String(job.resourceId), status: "queued" },
    data: {
      status: "blocked",
      errorCode: "PROJECT_PAUSED",
      sequence: { increment: 1 },
    },
  });
  await tx.$executeRaw`SELECT set_config('app.user_id','',true)`;
}

export async function getRun(scope: Scope, runId: string) {
  return chatScoped(scope, async (tx) => {
    const run = await tx.chatRun.findFirst({
      where: { ...where(scope), id: runId },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    return run;
  });
}

export async function cancelRun(scope: Scope, runId: string) {
  return chatScoped(scope, async (tx) => {
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
}
