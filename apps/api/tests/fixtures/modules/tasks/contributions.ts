import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { ModuleContributions } from "../../../../src/platform/modules/contributions.ts";
import { defineTool } from "../../../../src/modules/agents/tools/registry.ts";
import { createActionRequest } from "../../../../src/modules/action-requests.ts";
import { scopeFor } from "../../../../src/platform/tenancy/auth.ts";
import { sharedTransaction } from "../../../../src/platform/http/actions.ts";
import { create, data, entity, list, update } from "../../../../src/shared.ts";
import { TASKS_MANAGE, TASKS_READ, tasksModule } from "./manifest.ts";

/** How often the fixture's scheduler ran, so a test can see it is skipped. */
export const sweeps = { count: 0 };

const taskPayload = z.object({ title: z.string().min(1).max(120) }).strict();

/** Proposes tasks: one ActionRequest per task, nothing happens before a decision. */
export const proposeTasks = defineTool({
  name: "propose_tasks",
  namespace: "tasks",
  description: "Propose follow-up tasks; each needs an editor's approval.",
  parameters: z.object({ titles: z.array(z.string()).min(1).max(5) }).strict(),
  risk: "P_proposal",
  permission: TASKS_MANAGE,
  deferLoading: false,
  async execute(context, args) {
    const { titles } = z
      .object({ titles: z.array(z.string().min(1).max(120)).min(1).max(5) })
      .strict()
      .parse(args);
    const requests = await scoped(
      context.scope.workspaceId,
      context.scope.projectId,
      (tx) =>
        Promise.all(
          titles.map((title) =>
            createActionRequest(tx, context.scope, {
              actionType: "tasks.create",
              payload: { title },
              requestedBy: {
                kind: "agent",
                userId: context.scope.userId,
                agentRunId: null,
              },
            }),
          ),
        ),
    );
    return {
      output: {
        requests: requests.map((row) => ({ id: row.id, status: "pending" })),
      },
      cards: [],
    };
  },
});

/** HMAC-SHA256 of the raw body with the connection's secret, hex. */
export function fixtureSignature(rawBody: string, secret: string) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export const tasksContributions: ModuleContributions = {
  tools: [proposeTasks],
  // A public API for browsers on a key's origins (WP4.2b): visitors file
  // requests and see their own.
  publicRoutes: [
    {
      method: "POST",
      path: "/requests",
      async handler({ scope, session, body }) {
        const { title } = z
          .object({ title: z.string().min(1).max(120) })
          .strict()
          .parse(body);
        const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
          create(tx, scope, "fixture_tasks", {
            title,
            source: "public",
            sessionId: session.id,
          }),
        );
        return { id: row.id, title };
      },
    },
    {
      method: "GET",
      path: "/requests",
      async handler({ scope, session }) {
        const rows = await scoped(scope.workspaceId, scope.projectId, (tx) =>
          list(tx, scope, "fixture_tasks"),
        );
        return {
          items: rows
            .filter((row) => data(row).sessionId === session.id)
            .map((row) => ({ id: row.id, title: data(row).title })),
        };
      },
    },
  ],
  // A signed provider webhook through the platform's route (WP4.2a).
  webhooks: {
    fixture: {
      connectionProvider: "fixture",
      verify({ rawBody, headers, credential }) {
        const sent = Buffer.from(headers["x-fixture-signature"] ?? "", "hex");
        const expected = Buffer.from(
          fixtureSignature(rawBody, credential),
          "hex",
        );
        return (
          sent.length === expected.length && timingSafeEqual(sent, expected)
        );
      },
      messageId: ({ headers }) => headers["x-fixture-message-id"] ?? null,
      queueClass: "fixture_webhook",
    },
  },
  jobs: [
    {
      queueClass: "fixture_webhook",
      async handler({ scope, job }) {
        await scoped(scope.workspaceId, scope.projectId, async (tx) => {
          const message = data(
            await entity(tx, scope, "inbound_webhooks", job.resourceId),
          );
          await create(tx, scope, "fixture_tasks", {
            title: String(message.body?.title ?? "Webhook task"),
            webhookId: job.resourceId,
          });
        });
      },
    },
  ],
  // POST /api/projects/:id/actions/complete-task, for editors and owners.
  actions: {
    "complete-task": sharedTransaction(async (tx, { scope, input }) => {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input);
      const row = await entity(tx, scope, "fixture_tasks", id);
      return update(tx, scope, row, { ...data(row), done: true });
    }),
  },
  actionPermissions: { "complete-task": TASKS_MANAGE },
  actionTypes: {
    "tasks.create": {
      riskClass: "W0_internal",
      approvalMode: "approval_required",
      deciderRole: "editor",
      ttlMs: 86_400_000,
      payload: taskPayload,
      costCeilingMicros: () => 0,
      async revalidate() {},
      async onApproved(tx, scope, request) {
        await create(tx, scope, "fixture_tasks", {
          title: taskPayload.parse(data(request).payload).title,
          actionRequestId: request.id,
        });
      },
    },
  },
  scheduler: {
    async sweep() {
      sweeps.count++;
      return { queued: 0 };
    },
    async nextDueAt() {
      return null;
    },
  },
  routes: ({ app, auth }) => {
    app.get("/api/projects/:projectId/fixture-tasks", async (req) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, TASKS_READ);
      return scoped(scope.workspaceId, projectId, async (tx) => ({
        items: (await list(tx, scope, "fixture_tasks")).map((row) => ({
          id: row.id,
          title: data(row).title,
        })),
      }));
    });
  },
};

/** The fixture module for registerTestModules. */
export const tasksFixture = {
  module: tasksModule,
  contributions: tasksContributions,
};
