import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import { userScoped } from "../tenancy/scope.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { EventSubscription } from "../events/types.ts";
import type { ChatCard } from "./cards.ts";

// Notices in a personal conversation (ADR 0022, T3-2): messages with role
// `notice` that the platform writes without a model call, for example
// when work orders the assistant delegated have finished. The notice's own
// metadata travels as the first card (`kind: "notice"`), so the stored
// shape of ChatMessage stays as it is; the conversation view lifts it out.

export type NoticeKind =
  | "work_order_finished"
  | "work_order_failed"
  | "context_saved"
  // Briefings (ADR 0023 item 8): deterministic, and the opt-in AI summary.
  | "briefing"
  | "briefing_summary";
export type NoticeMeta = {
  kind: NoticeKind;
  /** Deduplicates the notice within its conversation. */
  key: string;
  entryId?: string;
  text?: string;
};

const TERMINAL = new Set(["succeeded", "failed", "blocked", "canceled", "outcome_unknown"]);

/**
 * Who asked the assistant to delegate, stored in `requestedBy` of every work
 * order `agent_delegate` creates: the conversation the result goes back to,
 * and the batch it belongs to (one notice for all of them).
 */
export const assistantRequester = z.object({
  kind: z.literal("user"),
  userId: z.string().min(1),
  via: z.literal("assistant"),
  personalSpaceId: z.uuid(),
  conversationId: z.uuid(),
  batchId: z.uuid(),
  batchSize: z.number().int().min(1).max(10),
});
export type AssistantRequester = z.infer<typeof assistantRequester>;

/**
 * Appends a notice to a conversation of the personal space in `scope`
 * (inside a user-scoped transaction), once per key; nothing when the conversation was deleted. Serialized per
 * key, so two finishing jobs cannot both write it.
 */
export async function appendNotice(
  tx: DbTx,
  scope: Scope,
  conversationId: string,
  notice: NoticeMeta,
  text: string,
  cards: ChatCard[] = [],
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"orbit:notice:" + notice.key}, 0))`;
  const conversation = await tx.chatConversation.findFirst({
    where: {
      id: conversationId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      userId: scope.userId,
    },
    select: { id: true },
  });
  if (!conversation) return null;
  const existing = await tx.chatMessage.findFirst({
    where: {
      conversationId,
      role: "notice",
      cards: { array_contains: [{ kind: "notice", notice: { key: notice.key } }] },
    },
    select: { id: true },
  });
  if (existing) return existing.id;
  const last = await tx.chatMessage.findFirst({
    where: { conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const row = await tx.chatMessage.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      userId: scope.userId,
      conversationId,
      sequence: (last?.sequence ?? 0) + 1,
      role: "notice",
      text: text.slice(0, 2000),
      cards: [{ kind: "notice", label: "notice", notice }, ...cards.slice(0, 20)] as object[],
    },
    select: { id: true },
  });
  return row.id;
}

/** The notice metadata of a stored message's cards, and the other cards. */
export function splitNotice(cards: unknown): { notice?: NoticeMeta; cards: ChatCard[] } {
  const list = Array.isArray(cards) ? (cards as Array<Record<string, unknown>>) : [];
  const first = list[0];
  if (first?.kind === "notice" && first.notice && typeof first.notice === "object")
    return { notice: first.notice as NoticeMeta, cards: list.slice(1) as ChatCard[] };
  return { cards: list as ChatCard[] };
}

/**
 * When the last work order of an assistant delegation batch has finished,
 * one notice with a result card per work order goes into the originating
 * personal conversation (plan §2.5 step 4). No model call is made; the
 * assistant summarizes on the user's next message. The personal space is
 * written in its own transaction after the work order's project was read:
 * the order is always business project, then personal space, never back.
 */
export const delegationNoticeSubscriber: EventSubscription = {
  name: "platform.assistant_delegation_notices",
  types: ["platform.agent.work_order.finished", "platform.agent.work_order.failed"],
  async handler(tx, scope, event) {
    const row = await tx.agentWorkOrder.findFirst({
      where: { id: event.subject.id, projectId: scope.projectId, workspaceId: scope.workspaceId },
      select: { requestedBy: true, origin: true },
    });
    if (!row || row.origin !== "assistant") return;
    const requester = assistantRequester.safeParse(row.requestedBy);
    if (!requester.success) return;
    const batch = await tx.agentWorkOrder.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        origin: "assistant",
        requestedBy: { path: ["batchId"], equals: requester.data.batchId },
      },
      select: {
        id: true,
        agentId: true,
        status: true,
        errorCode: true,
        subjectType: true,
        subjectId: true,
        result: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    if (!batch.length || batch.some((w) => !TERMINAL.has(w.status))) return;
    const project = await tx.project.findFirst({
      where: { id: scope.projectId },
      select: { name: true },
    });
    const projectName = project?.name ?? "";
    const agentIds = [...new Set(batch.map((w) => w.agentId).filter((id): id is string => Boolean(id)))];
    const agents = agentIds.length
      ? await tx.entity.findMany({
          where: { id: { in: agentIds }, projectId: scope.projectId, kind: "agent_definitions" },
          select: { id: true, data: true },
        })
      : [];
    const agentName = (id: string | null) => {
      const found = agents.find((a) => a.id === id);
      const value = found?.data as { active?: { name?: string }; draft?: { name?: string } } | undefined;
      return value?.active?.name ?? value?.draft?.name ?? "Agent";
    };
    const failed = batch.filter((w) => w.status !== "succeeded");
    const cards: ChatCard[] = batch.map((w) => ({
      kind: "status",
      label: `${agentName(w.agentId)}${w.subjectId ? ` · ${w.subjectType ?? "item"}` : ""}`.slice(0, 160),
      status: w.errorCode ? `${w.status}:${w.errorCode}`.slice(0, 80) : w.status,
      // No resourceId: it would be checked against the personal space.
      projectId: scope.projectId,
      projectName,
      ...(w.agentId
        ? { href: `/p/${scope.projectId}/agents/${w.agentId}/executions/${w.id}` }
        : {}),
    }));
    const text = failed.length
      ? `${batch.length - failed.length} of ${batch.length} delegated work orders in ${projectName} finished; ${failed.length} did not.`
      : `${batch.length} delegated work order${batch.length === 1 ? "" : "s"} in ${projectName} finished.`;
    const personal: Scope = {
      workspaceId: scope.workspaceId,
      projectId: requester.data.personalSpaceId,
      userId: requester.data.userId,
      role: "owner",
    };
    // The personal space must still be this user's in this organization.
    const space = await authDb.project.findFirst({
      where: {
        id: personal.projectId,
        workspaceId: personal.workspaceId,
        kind: "personal",
        personalUserId: personal.userId,
      },
      select: { id: true },
    });
    if (!space) return;
    // Chat rows are private to their user (chat_owner_scope): a user-scoped
    // transaction in the personal space.
    await userScoped(personal, (ptx) =>
      appendNotice(
        ptx,
        personal,
        requester.data.conversationId,
        {
          kind: failed.length ? "work_order_failed" : "work_order_finished",
          key: `delegation:${requester.data.batchId}`,
        },
        text,
        cards,
      ),
    );
  },
};
