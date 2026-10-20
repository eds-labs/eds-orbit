import { DomainError } from "../../../shared.ts";
import { z } from "zod";
import { marketingPlanSpec } from "../../../../../../packages/schemas/src/index.ts";
import { defineTool, type OrbitTool } from "../../agents/tools/registry.ts";
import {
  PROJECT_READ,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { chatScoped } from "../../chat.ts";
import { planContext, planView, proposePlan } from "../plans/service.ts";
import type { ChatCard } from "../../../platform/assistant/cards.ts";
function parseSpec(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError("MARKETING_PLAN_JSON_INVALID", 400);
  }
  return marketingPlanSpec.parse(parsed);
}
export const planCard = (
  plan: Awaited<ReturnType<typeof planView>>,
): ChatCard => ({
  kind: "marketing_plan",
  label: plan.spec.title,
  status: plan.status,
  marketingPlan: plan,
});
// No defaults/refinements in model-facing strict shapes. The shared spec is
// authoritative; the tool carries one JSON object as text to keep its bounded
// multi-level contract out of every tool-search response.
export const planTools: readonly OrbitTool[] = [
  defineTool({
    name: "marketing_plan_context",
    namespace: "marketing_plans",
    description:
      "Read bounded current marketing facts/profile versions, policy/channel intersection, measured/no-data baselines, budget capacity and existing work before proposing a durable strategy. No provider calls or execution.",
    parameters: z.object({}).strict(),
    risk: "R0_read",
    permission: PROJECT_READ,
    feature: "agents",
    deferLoading: true,
    async execute(context) {
      return {
        output: await chatScoped(context.scope, (tx) =>
          planContext(tx, context.scope),
        ),
        cards: [],
      };
    },
  }),
  defineTool({
    name: "marketing_plan_propose",
    namespace: "marketing_plans",
    description:
      "Save a durable strategic proposal for exact owner review, never activation. specJson must match the contract returned by marketing_plan_context: finite <=90 day horizon, actual IDs/versions, profile language, explicit budget and human_each by default. No assignments/jobs/spend/publication start.",
    parameters: z.object({ specJson: z.string() }).strict(),
    risk: "P_proposal",
    permission: PROJECT_WRITE,
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { specJson } = z
        .object({ specJson: z.string().max(40000) })
        .parse(args);
      const plan = await chatScoped(context.scope, (tx) =>
        proposePlan(
          tx,
          context.scope,
          parseSpec(specJson),
          context.conversationId,
        ),
      );
      return { output: plan, cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_status",
    namespace: "marketing_plans",
    description:
      "Read a saved plan by ID with exact revision, owner strategic review and current blockers. Activation is unavailable in MA-03; existing linked work remains independent.",
    parameters: z.object({ planId: z.string() }).strict(),
    risk: "R0_read",
    permission: PROJECT_READ,
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { planId } = z.object({ planId: z.uuid() }).parse(args);
      const plan = await chatScoped(context.scope, (tx) =>
        planView(tx, context.scope, planId),
      );
      return { output: plan, cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_change",
    namespace: "marketing_plans",
    description:
      "Propose a complete replacement strategy with expected Entity version from marketing_plan_status. Invalidates prior review, preserves version history, never edits linked assignments or activates work.",
    parameters: z
      .object({
        planId: z.string(),
        version: z.number().int(),
        specJson: z.string(),
      })
      .strict(),
    risk: "P_proposal",
    permission: PROJECT_WRITE,
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { planId, version, specJson } = z
        .object({
          planId: z.uuid(),
          version: z.number().int().positive(),
          specJson: z.string().max(40000),
        })
        .parse(args);
      const plan = await chatScoped(context.scope, (tx) =>
        proposePlan(
          tx,
          context.scope,
          parseSpec(specJson),
          context.conversationId,
          { id: planId, version },
        ),
      );
      return { output: plan, cards: [planCard(plan)] };
    },
  }),
];
