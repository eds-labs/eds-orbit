import { can } from "../../platform/tenancy/permissions.ts";
import { effectiveRole } from "../../platform/tenancy/module-roles.ts";
import { SUPPORT_NOTES_READ } from "./permissions.ts";
import type { ConversationSections } from "../../platform/assistant/types.ts";
import { data } from "../../shared.ts";
import { withPlaceholders } from "./ai.ts";

/** Native support artifacts created for a delegated task, visible in its normal conversation. */
export const supportConversationResults: ConversationSections = async (
  tx,
  scope,
  conversationId,
) => {
  const role = effectiveRole(scope, "support");
  if (role === "none" || !can({ role }, SUPPORT_NOTES_READ)) return {};
  const task = await tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: "orbit_tasks",
      AND: [
        { data: { path: ["conversationId"], equals: conversationId } },
        { data: { path: ["userId"], equals: scope.userId } },
      ],
    },
  });
  if (!task) return {};
  const requests = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "action_requests",
      data: { path: ["requestedBy", "taskId"], equals: task.id },
    },
    take: 50,
  });
  const ids = [
    ...new Set(
      requests
        .filter((r) => String(data(r).actionType).startsWith("support."))
        .map((r) => data(r).payload?.args?.ticketId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (!ids.length) return {};
  const messages = await tx.supportMessage.findMany({
    where: {
      projectId: scope.projectId,
      ticketId: { in: ids },
      kind: "ai_draft",
      createdAt: { gte: task.createdAt },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const drafts = [];
  for (const message of messages) {
    const ticket = await tx.supportTicket.findFirst({
      where: { id: message.ticketId, projectId: scope.projectId },
    });
    const contact = ticket
      ? await tx.supportContact.findFirst({
          where: { id: ticket.contactId, projectId: scope.projectId },
        })
      : null;
    drafts.push({
      id: message.id,
      ticketId: message.ticketId,
      status: "draft",
      body: withPlaceholders(message.bodyText, contact ?? {}).slice(0, 4000),
      sent: false,
    });
  }
  return { supportDrafts: drafts };
};
