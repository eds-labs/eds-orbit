/**
 * Delegation from the personal Orbit Assistant (ADR 0022 item 7, plan
 * agent-platform-phase-3 §2.5, WP3.6; ADR 0021 D-05 to D-07).
 *
 * `agent_delegate(projectId, agentId, goal, subjects?)` prepares one batch
 * of work orders for a configured agent in a business project and returns
 * one confirmation card. Nothing runs before the requesting user confirms
 * it: the batch is one ActionRequest of type `platform.agent.delegate`,
 * hash-bound to the agent's activated version and configuration, the goal,
 * the exact subject ids, the per-work-order ceiling and the batch id. Only
 * the requester may decide it (D-06; `mayDecide`), on the unchanged decide
 * route. It is deliberately not mandatable: a mandate cannot be limited to
 * one agent (D-06's optional per-agent start mandate needs a mandate schema
 * change and stays a follow-up), so every batch waits for its requester.
 *
 * The principal is the Phase 1 one: requester ∩ sponsor ∩ allowlist. The
 * requester must hold editor rights in every module of the agent, the
 * sponsor must still be an owner there, and every tool call of the work
 * orders is authorized again for both (authorizeAgentTool). The delegation
 * core bounds the batch: at most ten work orders, depth 0 (roots; an agent
 * never reaches this tool, so its children can be at most two levels
 * below), each with the agent's run ceiling, all together within the
 * agent's remaining month budget.
 *
 * Approval creates the work orders with `origin: "assistant"` and the
 * `assistantRequester` record notices.ts reads: when the whole batch is
 * terminal, one notice goes into the originating personal conversation.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { readVisibleAgent } from "../agents/definitions/service.ts";
import { agentMonthSpend } from "../agents/work-orders/execute.ts";
import { planChildWorkOrders, MAX_DELEGATION_FANOUT } from "../agents/work-orders/delegation.ts";
import {
  agentPlatformEnabled,
  insertWorkOrder,
  allowSnapshot,
} from "../agents/work-orders/service.ts";
import {
  inProjectCall,
  isProjectRefusal,
  ProjectCallRefused,
  projectMemberScope,
} from "../agents/project-calls.ts";
import { defineTool, dropNullFields } from "../agents/tools/registry.ts";
import { requireEntitlement } from "../entitlements/entitlements.ts";
import {
  createActionRequest,
  type ActionDefinition,
} from "../governance/action-requests.ts";
import { data, DomainError, hash } from "../shared.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { effectiveRole, moduleScope } from "../tenancy/module-roles.ts";
import {
  AGENTS_RUN,
  can,
  PROJECT_OWN,
  PROJECT_READ,
  PROJECT_WRITE,
} from "../tenancy/permissions.ts";
import type { ChatCard } from "./cards.ts";
import type { AssistantRequester } from "./notices.ts";
import { actionRequestCard } from "./personal-mode.ts";

export const DELEGATE_ACTION = "platform.agent.delegate";

const subject = z
  .object({ type: z.string().min(1).max(80), id: z.string().min(1).max(200) })
  .strict();

const delegatePayload = z
  .object({
    /** Identifies the same delegation asked for twice (dedupe). */
    requestKey: z.string().regex(/^[a-f0-9]{64}$/),
    batchId: z.uuid(),
    agentId: z.uuid(),
    agentName: z.string().max(200),
    agentVersion: z.number().int().positive(),
    configHash: z.string().min(1).max(200),
    requesterUserId: z.string().min(1),
    sponsorUserId: z.string().min(1),
    goal: z.string().max(2000),
    subjects: z.array(subject).max(MAX_DELEGATION_FANOUT),
    ceilingMicros: z.number().int().positive(),
    personalSpaceId: z.uuid(),
    conversationId: z.uuid(),
  })
  .strict();
export type DelegatePayload = z.infer<typeof delegatePayload>;

const batchSize = (p: Pick<DelegatePayload, "subjects">) => Math.max(1, p.subjects.length);

/**
 * The checks of one delegation in its project, for the requester's current
 * scope there: the agent platform on, agent run rights, the agent active and
 * visible, editor rights in every module of the agent (D-06), the sponsor
 * still an owner there, the manual-start entitlement, and the delegation
 * core's limits (fan-out, depth, the remaining month budget). Throws before
 * anything is stored.
 */
async function planDelegation(
  tx: DbTx,
  requester: Scope,
  input: { agentId: string; subjects: readonly z.infer<typeof subject>[] },
  now = new Date(),
) {
  if (!agentPlatformEnabled()) throw new DomainError("AGENT_PLATFORM_DISABLED", 404);
  if (!can(requester, AGENTS_RUN)) throw new ProjectCallRefused("PERMISSION_DENIED");
  const stored = await readVisibleAgent(tx, requester, input.agentId);
  const { definition } = stored;
  const config = definition.active;
  if (definition.status !== "active" || !config || !definition.activation)
    throw new DomainError("AGENT_NOT_ACTIVE", 409);
  for (const module of config.modules)
    if (
      effectiveRole(requester, module) === "none" ||
      !can(moduleScope(requester, module), PROJECT_WRITE)
    )
      throw new DomainError("AGENT_PRINCIPAL_FORBIDDEN", 403);
  const sponsorUserId = definition.activation.sponsorUserId;
  const sponsor = await actorScope(requester.workspaceId, requester.projectId, sponsorUserId);
  if (
    !sponsor ||
    config.modules.some(
      (module) =>
        effectiveRole(sponsor, module) === "none" ||
        !can(moduleScope(sponsor, module), PROJECT_OWN),
    )
  )
    throw new DomainError("AGENT_PRINCIPAL_FORBIDDEN", 403);
  await requireEntitlement(requester.workspaceId, { triggerKind: "manual" });
  const spent = await agentMonthSpend(tx, requester, input.agentId, now);
  const ceilingMicros = config.budget.runCeilingMicros;
  // The assistant is the virtual parent: its children are roots (depth 0),
  // within the agent's remaining month budget together.
  planChildWorkOrders(
    {
      workOrderId: "",
      rootWorkOrderId: "",
      depth: -1,
      chain: [],
      delegateTo: null,
      allow: null,
      remainingCeilingMicros: Math.max(0, config.budget.monthlyCeilingMicros - spent),
      sponsorUserId: null,
    },
    Array.from({ length: Math.max(1, input.subjects.length) }, () => ({
      agentId: input.agentId,
      sponsorUserId,
      allow: {
        tools: new Set(config.tools),
        modules: new Set(config.modules),
        mode: config.mode,
        knowledge: config.knowledge,
      },
      ceilingMicros,
    })),
  );
  return {
    agentId: input.agentId,
    agentName: config.name,
    agentVersion: definition.activation.version,
    configHash: definition.activation.configHash,
    sponsorUserId,
    ceilingMicros,
    allow: allowSnapshot(config),
  };
}

/**
 * `platform.agent.delegate`: the requester's confirmation of one batch.
 * C1 (paid internal work), never covered by a mandate.
 */
export const agentDelegateAction: ActionDefinition<DelegatePayload> = {
  riskClass: "C1",
  approvalMode: "approval_required",
  deciderRole: "editor",
  // In the requester's own approvals list; only they may decide it.
  inbox: "editors",
  mayDecide: (member, p) => member.userId === p.requesterUserId,
  ttlMs: 24 * 3_600_000,
  payload: delegatePayload,
  costCeilingMicros: (p) => p.ceilingMicros * batchSize(p),
  summary: (p) => ({
    agent: { id: p.agentId, name: p.agentName, version: p.agentVersion },
    goal: p.goal,
    subjects: p.subjects,
    workOrders: batchSize(p),
    ceilingMicrosPerWorkOrder: p.ceilingMicros,
    onBehalfOf: { requesterUserId: p.requesterUserId, sponsorUserId: p.sponsorUserId },
  }),
  async revalidate(tx, scope, p) {
    if (scope.userId !== p.requesterUserId) throw new DomainError("DECIDER_NOT_ALLOWED", 403);
    const requester = await actorScope(scope.workspaceId, scope.projectId, p.requesterUserId);
    if (!requester) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    const plan = await planDelegation(tx, requester, p);
    if (plan.agentVersion !== p.agentVersion || plan.configHash !== p.configHash)
      throw new DomainError("AGENT_VERSION_CHANGED", 409);
    if (plan.ceilingMicros !== p.ceilingMicros || plan.sponsorUserId !== p.sponsorUserId)
      throw new DomainError("COST_CEILING_CHANGED", 409);
  },
  async onApproved(tx, scope, request) {
    const p = delegatePayload.parse(data(request).payload);
    const requester = await actorScope(scope.workspaceId, scope.projectId, p.requesterUserId);
    if (!requester) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    const by: AssistantRequester = {
      kind: "user",
      userId: p.requesterUserId,
      via: "assistant",
      personalSpaceId: p.personalSpaceId,
      conversationId: p.conversationId,
      batchId: p.batchId,
      batchSize: batchSize(p),
    };
    const subjects = p.subjects.length ? p.subjects : [null];
    for (const [index, item] of subjects.entries())
      await insertWorkOrder(tx, requester, {
        agentId: p.agentId,
        origin: "assistant",
        originRef: request.id,
        idempotencyKey: `assistant:${p.batchId}:${index}`,
        requestedBy: by,
        requesterUserId: p.requesterUserId,
        goal: p.goal,
        subject: item,
      });
  },
};

const parameters = z
  .object({
    projectId: z.string().describe("The agent's project, from projects_list"),
    agentId: z.string().describe("An agent id from agents_list"),
    goal: z.string().describe("What the agent should do, at most 2000 characters"),
    subjects: z
      .array(z.object({ type: z.string(), id: z.string() }).strict())
      .max(MAX_DELEGATION_FANOUT)
      .nullable()
      .describe("Up to ten records (type and id), one work order each; null for one work order"),
  })
  .strict();

const input = z
  .object({
    projectId: z.uuid(),
    agentId: z.uuid(),
    goal: z.string().trim().min(1).max(2000),
    // Checked by the delegation core (AGENT_DELEGATION_FANOUT) below.
    subjects: z.array(subject).max(50).nullish(),
  })
  .strict();

/**
 * `agent_delegate`: the personal assistant's eighth user tool (ADR 0022).
 * Returns one confirmation card; the work orders start only after the
 * requester confirms it in the agent's project.
 */
export const agentDelegate = defineTool({
  name: "agent_delegate",
  namespace: "agents",
  description:
    "Ask a configured agent of one project to do work: one work order per subject (at most ten), or one without subjects. Returns a confirmation card the user confirms; nothing runs before. Results come back as a notice in this conversation.",
  parameters,
  risk: "P_proposal",
  permission: PROJECT_READ,
  deferLoading: false,
  scopeShape: "user",
  exposure: { assistant: false, personal: true },
  async execute(context, args) {
    const parsed = input.parse(dropNullFields(args ?? {}));
    const subjects = parsed.subjects ?? [];
    if (subjects.length > MAX_DELEGATION_FANOUT)
      return { output: { error: "AGENT_DELEGATION_FANOUT" }, cards: [] };
    const personal = context.scope;
    const conversationId = z.uuid().safeParse(context.conversationId);
    if (!context.personal || !conversationId.success)
      throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
    try {
      return await inProjectCall(parsed.projectId, async () => {
        const member = await projectMemberScope({
          workspaceId: personal.workspaceId,
          userId: personal.userId,
          projectId: parsed.projectId,
          businessOnly: true,
        });
        const result = await scoped(member.workspaceId, member.projectId, async (tx) => {
          const plan = await planDelegation(tx, member, { agentId: parsed.agentId, subjects });
          const project = await tx.project.findUniqueOrThrow({
            where: { id: member.projectId },
            select: { name: true },
          });
          const requestKey = hash({
            agentId: plan.agentId,
            agentVersion: plan.agentVersion,
            goal: parsed.goal,
            subjects,
            conversationId: conversationId.data,
          });
          const old = await tx.entity.findFirst({
            where: {
              workspaceId: member.workspaceId,
              projectId: member.projectId,
              kind: "action_requests",
              AND: [
                { data: { path: ["actionType"], equals: DELEGATE_ACTION } },
                { data: { path: ["status"], equals: "pending" } },
                { data: { path: ["payload", "requestKey"], equals: requestKey } },
                { data: { path: ["payload", "requesterUserId"], equals: member.userId } },
              ],
            },
          });
          const row =
            old ??
            (await createActionRequest(tx, member, {
              actionType: DELEGATE_ACTION,
              payload: {
                requestKey,
                batchId: randomUUID(),
                agentId: plan.agentId,
                agentName: plan.agentName.slice(0, 200),
                agentVersion: plan.agentVersion,
                configHash: plan.configHash,
                requesterUserId: member.userId,
                sponsorUserId: plan.sponsorUserId,
                goal: parsed.goal,
                subjects,
                ceilingMicros: plan.ceilingMicros,
                personalSpaceId: personal.projectId,
                conversationId: conversationId.data,
              } satisfies DelegatePayload,
              // The member's own assistant (a mandate's assistant channel).
              requestedBy: { kind: "agent", userId: member.userId, agentRunId: context.runId },
            }));
          return { row, plan, projectName: project.name, deduplicated: Boolean(old) };
        });
        context.personal?.noteProjects([member.projectId]);
        const d = data(result.row);
        const status = String(d.status);
        const card: ChatCard = {
          kind: "status",
          label: `Delegate to ${result.plan.agentName}: ${batchSize(d.payload)} work order${batchSize(d.payload) === 1 ? "" : "s"}`.slice(0, 160),
          status: status === "pending" ? "confirmation_required" : status,
          href: `/p/${member.projectId}/decisions`,
          projectId: member.projectId,
          projectName: result.projectName,
          actionRequest: actionRequestCard(member, result.row),
        };
        return {
          output: {
            actionRequestId: result.row.id,
            deduplicated: result.deduplicated,
            status,
            requiresApproval: status === "pending",
            batchId: d.payload.batchId,
            projectId: member.projectId,
            projectName: result.projectName,
            agent: { id: result.plan.agentId, name: result.plan.agentName },
            subjects,
            workOrders: batchSize(d.payload),
            ceilingMicrosPerWorkOrder: result.plan.ceilingMicros,
            onBehalfOf: {
              requesterUserId: member.userId,
              sponsorUserId: result.plan.sponsorUserId,
            },
          },
          cards: [card],
        };
      });
    } catch (error) {
      if (isProjectRefusal(error))
        return { output: { projectId: parsed.projectId, error: error.refusal }, cards: [] };
      throw error;
    }
  },
});
