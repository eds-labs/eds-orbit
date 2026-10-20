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
import {
  activationInput,
  proposeActivation,
  pausePlan,
} from "../plans/activation.ts";
function parseSpec(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError("MARKETING_PLAN_JSON_INVALID", 400);
  }
  return marketingPlanSpec.parse(parsed);
}
/** Keep model output valid within the shared 12k transport bound. The exact
 * complete mandate remains in its saved native/chat decision card. */
function planOutput(plan: Awaited<ReturnType<typeof planView>>) {
  const output = {
    ...plan,
    activationRequest: plan.activationRequest
      ? { ...plan.activationRequest, payload: undefined }
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(output)) <= 11000) return output;
  return {
    id: plan.id,
    version: plan.version,
    revision: plan.revision,
    specHash: plan.specHash,
    status: plan.status,
    strategicallyReviewed: plan.strategicallyReviewed,
    activationAvailable: plan.activationAvailable,
    blockers: plan.blockers,
    actionRequest: plan.actionRequest,
    activationRequest: output.activationRequest,
    truncated: true,
    detail:
      "Read the saved native plan and its exact decision card for the complete scope.",
  };
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
    name: "marketing_plan_activation_context",
    namespace: "marketing_plans",
    description:
      "Read the authoritative activation child contract and current plan version before proposing exact bounded activation. No provider calls or mutation.",
    parameters: z.object({ planId: z.string() }).strict(),
    risk: "R0_read",
    permission: PROJECT_READ,
    feature: "agents",
    deferLoading: true,
    async execute(context, raw) {
      const { planId } = z.object({ planId: z.uuid() }).parse(raw);
      const plan = await chatScoped(context.scope, (tx) =>
        planView(tx, context.scope, planId),
      );
      return {
        output: {
          planId: plan.id,
          version: plan.version,
          revision: plan.revision,
          status: plan.status,
          activationAvailable: plan.activationAvailable,
          activationContract: z.toJSONSchema(activationInput, { io: "input" }),
        },
        cards: [],
      };
    },
  }),
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
      return { output: planOutput(plan), cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_status",
    namespace: "marketing_plans",
    description:
      "Read a saved plan by ID with exact revision, owner strategic review and current blockers. Read current owned/independent work and exact activation requests; only owner activation can start preparation.",
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
      return { output: planOutput(plan), cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_change",
    namespace: "marketing_plans",
    description:
      "Propose a complete replacement strategy with expected Entity version. Pauses previously owned work and invalidates prior review; independent links stay unchanged. Never activates revised work.",
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
      return { output: planOutput(plan), cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_activation_propose",
    namespace: "marketing_plans",
    description:
      "Propose one exact owner activation for a strategically reviewed plan. Read status and activationContract first. childrenJson is the complete bounded child array, with full assignment contents and expected existing versions for explicit adoption. Existing assignment/mission links stay independent unless adopted. No execution before owner approval; image consent is separate.",
    parameters: z
      .object({
        planId: z.string(),
        version: z.number().int(),
        childrenJson: z.string(),
      })
      .strict(),
    risk: "P_proposal",
    permission: PROJECT_WRITE,
    feature: "agents",
    deferLoading: true,
    async execute(context, raw) {
      const args = z
        .object({
          planId: z.uuid(),
          version: z.number().int().positive(),
          childrenJson: z.string().max(40000),
        })
        .parse(raw);
      let children: unknown;
      try {
        children = JSON.parse(args.childrenJson);
      } catch {
        throw new DomainError("MARKETING_PLAN_JSON_INVALID", 400);
      }
      const plan = await chatScoped(context.scope, (tx) =>
        proposeActivation(
          tx,
          context.scope,
          args.planId,
          activationInput.parse({ version: args.version, children }),
        ),
      );
      return { output: planOutput(plan), cards: [planCard(plan)] };
    },
  }),
  defineTool({
    name: "marketing_plan_pause",
    namespace: "marketing_plans",
    description:
      "Pause an active plan and its owned assignments using expected Entity version. Cancels open local runs and withdraws unsent work; provider-owned/unknown outcomes still need reconciliation. Independent links keep running.",
    parameters: z
      .object({ planId: z.string(), version: z.number().int() })
      .strict(),
    risk: "P_proposal",
    permission: PROJECT_WRITE,
    feature: "agents",
    deferLoading: true,
    async execute(context, raw) {
      const args = z
        .object({ planId: z.uuid(), version: z.number().int().positive() })
        .parse(raw);
      const plan = await chatScoped(context.scope, (tx) =>
        pausePlan(tx, context.scope, args.planId, args.version),
      );
      return { output: planOutput(plan), cards: [planCard(plan)] };
    },
  }),
];
