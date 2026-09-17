import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import {
  authDb,
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, data, list, update } from "../shared.ts";
import { retrieve, setFact } from "../../../../packages/knowledge/src/index.ts";
import {
  configureSlack,
  queueSlackDigest,
  dispatchSlackDigest,
  handleSlackInteraction,
  markSlackOutcomeUnknown,
} from "./slack.ts";
// This suite verifies Slack transport and exact approval binding. Semantic live-RAG
// quality is deliberately simulated here and tested by the separate index/provider suite.
vi.mock(
  "../../../../packages/knowledge/src/index.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../packages/knowledge/src/index.ts")
      >();
    return {
      ...actual,
      validateActiveIndexEvaluation: vi.fn(async () => ({
        valid: true,
        reasons: [],
        indexId: "simulated-quality-gate-for-slack-only",
      })),
    };
  },
);
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Slack durable flow with real database, isolated transport and simulated quality gate",
  () => {
    let workspaceId: string, userId: string, scope: Scope;
    const signingSecret = "a".repeat(32),
      botToken = "xoxb-synthetic-no-live-token";
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, fn);
    beforeAll(async () => {
      userId = randomUUID();
      await authDb.user.create({
        data: {
          id: userId,
          email: userId + "@example.invalid",
          name: "Synthetic Slack owner",
        },
      });
      workspaceId = (
        await authDb.workspace.create({
          data: {
            name: "Synthetic Slack isolated suite",
            members: { create: { userId, role: "owner" } },
          },
        })
      ).id;
    });
    beforeEach(async () => {
      const p = await authDb.project.create({
        data: { workspaceId, name: "Synthetic Slack project" },
      });
      scope = { workspaceId, projectId: p.id, userId, role: "owner" };
      await run((tx) =>
        configureSlack(tx, scope, {
          botToken,
          signingSecret,
          teamId: "T1234",
          channelId: "C1234",
          confirmChannelMandate: true,
          allowApprovals: false,
          validUntil: new Date(Date.now() + 86400000).toISOString(),
          actors: [{ slackUserId: "U1234", orbitUserId: userId }],
        }),
      );
      await run((tx) =>
        create(tx, scope, "exceptions", {
          status: "open",
          code: "BUDGET_EXCEEDED",
          resourceIds: ["synthetic-resource"],
        }),
      );
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      if (workspaceId)
        await authDb.workspace.delete({ where: { id: workspaceId } });
      if (userId) await authDb.user.delete({ where: { id: userId } });
      await closeDatabase();
    });
    async function queued() {
      const result = await run((tx) => queueSlackDigest(tx, scope));
      if (!("message" in result) || !result.message)
        throw new Error("Fixture digest missing");
      return result.message;
    }
    function signed(
      actionId: string,
      channel = "C1234",
      actor = "U1234",
      actionName = "orbit_pause",
    ) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T1234" },
          channel: { id: channel },
          user: { id: actor },
          actions: [{ action_id: actionName, value: actionId }],
        }),
      }).toString();
      return {
        workspaceId,
        projectId: scope.projectId,
        rawBody,
        timestamp,
        signature:
          "v0=" +
          createHmac("sha256", signingSecret)
            .update(`v0:${timestamp}:${rawBody}`)
            .digest("hex"),
      };
    }
    it("deduplicates durable digests and refuses the default external gate without transport", async () => {
      vi.stubEnv("EXECUTION_MODE", "test");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "false");
      const a = await queued(),
        b = await queued();
      expect(a.id).toBe(b.id);
      const fetch = vi.fn();
      await expect(dispatchSlackDigest(scope, a.id, { fetch })).rejects.toThrow(
        "SLACK_EXTERNAL_WRITES_DISABLED",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(data(a))).not.toContain(botToken);
    });
    it("sends once using mocked HTTPS then accepts one signed mapped-owner pause", async () => {
      vi.stubEnv("EXECUTION_MODE", "live");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
      const message = await queued();
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${botToken}`,
        );
        const payload = JSON.parse(String(init?.body));
        expect(payload.channel).toBe("C1234");
        expect(payload.unfurl_links).toBe(false);
        return new Response(
          JSON.stringify({
            ok: true,
            channel: "C1234",
            ts: "1789640000.000001",
          }),
        );
      });
      expect(
        data(
          (await dispatchSlackDigest(scope, message.id, { fetch })) as {
            data: unknown;
          },
        ).status,
      ).toBe("sent");
      await dispatchSlackDigest(scope, message.id, { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      const action = (await run((tx) => list(tx, scope, "slack_actions"))).find(
        (x) => data(x).type === "pause",
      )!;
      await expect(
        handleSlackInteraction(signed(action.id, "COTHER")),
      ).rejects.toThrow("SLACK_PAYLOAD_INVALID");
      await expect(
        handleSlackInteraction(signed(action.id, "C1234", "UOTHER")),
      ).rejects.toThrow("SLACK_ACTOR_UNAUTHORIZED");
      const input = signed(action.id);
      expect(await handleSlackInteraction(input)).toMatchObject({
        accepted: true,
        action: "pause",
      });
      await expect(handleSlackInteraction(input)).rejects.toThrow(
        "SLACK_REPLAY",
      );
      expect(
        (
          await authDb.project.findUniqueOrThrow({
            where: { id: scope.projectId },
          })
        ).paused,
      ).toBe(true);
    });
    it("keeps network ambiguity and recovered interrupted sends unknown without retry", async () => {
      vi.stubEnv("EXECUTION_MODE", "live");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
      const message = await queued(),
        fetch = vi.fn(async () => {
          throw new Error("synthetic network timeout");
        });
      const result = await dispatchSlackDigest(scope, message.id, { fetch });
      expect(data(result as { data: unknown }).status).toBe("outcome_unknown");
      await dispatchSlackDigest(scope, message.id, { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      const interrupted = await run((tx) =>
        create(tx, scope, "slack_messages", {
          status: "sending",
          fence: "synthetic",
        }),
      );
      expect(
        data(
          await run((tx) => markSlackOutcomeUnknown(tx, scope, interrupted.id)),
        ).status,
      ).toBe("outcome_unknown");
    });
    it("rejects a consumed or expired resource reference even with a fresh valid signature", async () => {
      vi.stubEnv("EXECUTION_MODE", "live");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
      const message = await queued();
      await dispatchSlackDigest(scope, message.id, {
        fetch: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              channel: "C1234",
              ts: "1789640000.000002",
            }),
          ),
      });
      const action = (await run((tx) => list(tx, scope, "slack_actions")))[0]!;
      await run((tx) =>
        update(tx, scope, action, {
          ...data(action),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await expect(handleSlackInteraction(signed(action.id))).rejects.toThrow(
        "SLACK_ACTION_STALE",
      );
      expect(
        (
          await authDb.project.findUniqueOrThrow({
            where: { id: scope.projectId },
          })
        ).paused,
      ).toBe(false);
    });
    async function approvalFixture() {
      vi.stubEnv("EXECUTION_MODE", "live");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
      return run(async (tx) => {
        const connector = (await list(tx, scope, "connectors"))[0]!;
        await update(tx, scope, connector, {
          ...data(connector),
          allowApprovals: true,
        });
        await create(tx, scope, "connectors", {
          provider: "postiz",
          status: "write_verified",
          writeVerifiedIntegrationIds: ["synthetic-social"],
          writeVerifiedInstanceId: process.env.PUBLISHER_INSTANCE_ID,
          baseUrl: "https://synthetic.example/public/v1",
        });
        const past = new Date(Date.now() - 86400000).toISOString(),
          future = new Date(Date.now() + 86400000).toISOString();
        const source = await create(tx, scope, "sources", {
          status: "active",
          generation: 1,
          authority: "official",
          publicUse: true,
          modelUse: false,
          maxAgeHours: 168,
          allowedOrigins: [],
          allowedPaths: ["/"],
        });
        const fact = await setFact(tx, scope, {
          key: "price",
          value: "19",
          valueType: "decimal",
          currency: "EUR",
          language: "en",
          sourceId: source.id,
          validFrom: past,
          validUntil: future,
          status: "verified",
          publicUse: true,
          modelUse: false,
        });
        const evidence = await retrieve(tx, scope, {
          query: "price",
          purpose: "public",
          language: "en",
        });
        await create(tx, scope, "policies", {
          active: true,
          mode: "assisted",
          channels: ["synthetic-social"],
          contentTypes: ["social"],
          allowedOrigins: [],
          startAt: past,
          endAt: future,
          maxPerDay: 3,
          minIntervalMinutes: 1,
          dailyBudgetMicros: 0,
          monthlyBudgetMicros: 0,
          perRunBudgetMicros: 0,
          approvedPaidTests: false,
        });
        return create(tx, scope, "content", {
          title: "Synthetic price",
          body: "price: 19",
          type: "social",
          language: "en",
          channel: "synthetic-social",
          evidenceId: evidence.id,
          claims: [{ kind: "fact", text: "price: 19", factId: fact.id }],
          status: "reviewed",
          risk: "routine",
          synthetic: false,
        });
      });
    }
    it("binds a signed approval to the displayed exact package without publishing", async () => {
      const content = await approvalFixture(),
        message = await queued();
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              channel: "C1234",
              ts: "1789640000.000003",
            }),
          ),
      );
      await dispatchSlackDigest(scope, message.id, { fetch });
      const action = (await run((tx) => list(tx, scope, "slack_actions"))).find(
        (x) => data(x).type === "approve",
      )!;
      expect(action).toBeDefined();
      const input = signed(action.id, "C1234", "U1234", "orbit_approve");
      expect(await handleSlackInteraction(input)).toMatchObject({
        accepted: true,
        action: "approve",
      });
      expect(
        (await run((tx) => list(tx, scope, "approvals"))).some(
          (x) => data(x).contentId === content.id,
        ),
      ).toBe(true);
      expect(await run((tx) => list(tx, scope, "publications"))).toHaveLength(
        0,
      );
      await expect(handleSlackInteraction(input)).rejects.toThrow(
        "SLACK_REPLAY",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("blocks a stale content snapshot before any Slack data egress", async () => {
      const content = await approvalFixture(),
        message = await queued();
      await run((tx) =>
        update(tx, scope, content, {
          ...data(content),
          body: "Changed after digest creation",
        }),
      );
      const fetch = vi.fn();
      await expect(
        dispatchSlackDigest(scope, message.id, { fetch }),
      ).rejects.toThrow("SLACK_APPROVAL_STALE");
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);
