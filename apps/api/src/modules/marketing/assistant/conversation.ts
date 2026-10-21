import { planView } from "../plans/service.ts";
import { agentsEnabled } from "../agents/assignments.ts";
import type { ConversationSections } from "../../../platform/assistant/types.ts";
import { conversationPackages } from "../agents/content-packages.ts";
import { conversationAssignments } from "../agents/assignment-overview.ts";

/**
 * The conversation's content packages and assignment cards (WP2.2), moved
 * unchanged from getConversation.
 */
export const marketingConversationSections: ConversationSections = async (
  tx,
  scope,
  id,
  messages,
) => {
  const packages = await conversationPackages(tx, scope, id);
  // Assignment cards carry their content by value; the live state comes by ID (R16).
  const assignmentIds = messages.flatMap((message) =>
    message.cards
      .filter((card: any) => card.kind === "assignment")
      .map((card: any) => card.assignment?.id),
  );
  const assignments = assignmentIds.length
    ? await conversationAssignments(tx, scope, assignmentIds)
    : [];
  const planIds = [
    ...new Set(
      messages.flatMap((message) =>
        message.cards
          .filter((card: any) => card.kind === "marketing_plan")
          .map((card: any) => card.marketingPlan?.id),
      ),
    ),
  ]
    .filter(
      (id): id is string =>
        typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
    )
    .slice(0, 20);
  const plans = agentsEnabled()
    ? await Promise.all(planIds.map((planId) => planView(tx, scope, planId)))
    : [];
  return { packages, assignments, marketingPlans: plans };
};
