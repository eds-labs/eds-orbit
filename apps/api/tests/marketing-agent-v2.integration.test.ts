import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

// The real chat runner, specialist runner, scheduler, DB and publication services
// run here. All model/image/connector transports are synthetic and fail closed.
import { planSpec } from "./support/marketing-plan.ts";
import {
  proposePlan,
  planView,
} from "../src/modules/marketing/plans/service.ts";
import { proposeActivation } from "../src/modules/marketing/plans/activation.ts";
const fake = vi.hoisted(() => ({
  chat: [] as unknown[][],
  chatInputs: [] as any[],
  generate: vi.fn(),
  embed: vi.fn(),
  image: vi.fn(),
  respond: vi.fn(),
  posts: vi.fn(),
  upload: vi.fn(),
  listPosts: vi.fn(),
  drive: vi.fn(),
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  generate: fake.generate,
  embed: fake.embed,
  generateImage: fake.image,
  generateImageWithReferences: fake.image,
  respond: fake.respond,
  streamChat: vi.fn(async (request: any) => {
    fake.chatInputs.push(structuredClone(request.input));
    const output = fake.chat.shift();
    if (!output) throw new Error("UNRECORDED_CHAT_CALL");
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.completed",
          response: {
            id: "synthetic-chat",
            usage: { input_tokens: 100, output_tokens: 20 },
            output,
          },
        };
      },
    };
  }),
}));
vi.mock("../../../packages/connectors/src/index.ts", async (original) => ({
  ...(await original<
    typeof import("../../../packages/connectors/src/index.ts")
  >()),
  createPostizClient: () => ({
    listPosts: fake.listPosts,
    createPost: fake.posts,
    uploadMedia: fake.upload,
  }),
}));
vi.mock("../src/modules/marketing/brand/drive-assets.ts", async (original) => ({
  ...(await original<
    typeof import("../src/modules/marketing/brand/drive-assets.ts")
  >()),
  saveDraftDocument: fake.drive,
}));
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import { data, entity, create, list, update, encrypt } from "../src/shared.ts";
import {
  createConversation,
  getConversation,
  sendMessage,
  getRun,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { registerAgentSpecialists } from "../src/modules/marketing/agents/specialists/index.ts";
import { runAgentTask } from "../src/modules/marketing/agents/specialists/runner.ts";
import {
  assignmentHash,
  proposeAssignment,
  updateAssignment,
} from "../src/modules/marketing/agents/assignments.ts";
import { releaseAssignmentDraft } from "../src/modules/marketing/agents/owner-release.ts";
import { scheduleApproved } from "../src/modules/marketing/agents/veto.ts";
import { deliverPostizDraft } from "../src/modules/marketing/agents/draft-delivery.ts";
import { draftTarget } from "../src/modules/marketing/publishing/postiz-draft.ts";
import { dispatchPublication } from "../src/modules/marketing/publishing/publisher.ts";
import {
  assignmentHumanApprovalBlocker,
  preflight,
} from "../src/modules/marketing/policy/policy.ts";
import { saveDraftToDrive } from "../src/modules/marketing/agents/specialists/copywriter.ts";
import { claimPublication } from "../src/modules/marketing/pipeline/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import {
  createPackageProject,
  X,
  TELEGRAM,
  IMAGE_MODEL,
  IMAGE_MAX,
} from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
  tomorrowMorning,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const call = (name: string, args: unknown) => ({
  type: "function_call",
  id: "fc",
  call_id: "c",
  name,
  arguments: JSON.stringify(args),
});
const usage = {
  model: "gpt-5.6-terra",
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicros: 7,
};

describe.skipIf(!enabled)(
  "Marketing Agent v2: approval-first recurring workflow (MA-00/01)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let h: ReturnType<typeof assignmentRun>;
    let morning: Date;
    let png: Buffer;
    beforeAll(async () => {
      const rendered = await renderRasterTemplate({
        format: "square",
        logoApproved: true,
        title: "Synthetic fixture",
      });
      if (rendered.status !== "rendered")
        throw new Error("FIXTURE_RENDER_FAILED");
      png = Buffer.from(rendered.bytes);
    });
    beforeEach(async () => {
      vi.stubEnv("ORBIT_AGENTS", "true");
      vi.stubEnv("ORBIT_AGENT_REVIEW_AUTHORITY", "true");
      vi.stubEnv("ORBIT_TOOL_SEARCH", "true");
      vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
      vi.stubEnv("EXECUTION_MODE", "test");
      fake.drive
        .mockReset()
        .mockRejectedValue(new Error("UNAPPROVED_DRIVE_WRITE"));
      fake.chat = [];
      fake.chatInputs = [];
      fake.posts.mockReset().mockResolvedValue({
        remotePosts: [{ postId: "synthetic-remote", integration: X }],
        state: "accepted",
        requestedType: "draft",
      });
      fake.upload
        .mockReset()
        .mockResolvedValue({ id: "synthetic-media", path: "/synthetic.png" });
      fake.listPosts.mockReset().mockResolvedValue([]);
      fake.embed.mockReset().mockResolvedValue(embedded());
      fake.generate.mockReset().mockImplementation(async ({ goal }: any) => {
        const c = JSON.parse(goal);
        return generated(
          `Beta access is open for product teams. Learn more. (${c.brief?.topic ?? c.channel})`,
        );
      });
      fake.image.mockReset().mockResolvedValue({
        bytes: png,
        model: IMAGE_MODEL,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        usage: null,
      });
      fake.respond.mockReset().mockImplementation(async (request: any) => {
        const input = JSON.parse(request.input[0].content);
        let output: unknown;
        if (request.instructions.includes("analytics specialist"))
          output = {
            period: { from: "2026-10-01", to: "2026-10-19" },
            noData: true,
            findings: [],
          };
        else if (request.instructions.includes("research specialist"))
          output = { findings: [] };
        else if (request.instructions.includes("strategy specialist"))
          output = {
            briefs: input.run.slots.map((slot: any) =>
              h.brief(slot, {
                imageIdea: "A calm open door in soft blue light",
              }),
            ),
          };
        else if (input.drafts)
          output = {
            decisions: input.drafts.map((d: any) => ({
              contentId: d.contentId,
              verdict: "approve",
              reasons: [],
              revisionInstructions: null,
            })),
          };
        else throw new Error("UNRECORDED_SPECIALIST_CALL");
        return {
          output: [message(output)],
          usage,
          responseId: "synthetic-specialist",
        };
      });
      project = await createPackageProject();
      morning = tomorrowMorning();
      h = assignmentRun(project, morning);
      const rate = {
        inputMicrosPerMillion: 1000,
        outputMicrosPerMillion: 1000,
        verifiedAt: new Date().toISOString(),
      };
      await h.run((tx) =>
        saveOpenAiConfiguration(tx, project.owner, {
          apiKey: "synthetic-offline-key",
          verifiedModels: [
            "gpt-5.6-terra",
            "text-embedding-3-small",
            IMAGE_MODEL,
          ],
          rateCard: { "gpt-5.6-terra": rate, "text-embedding-3-small": rate },
          modelRoutes: {
            fast: "gpt-5.6-terra",
            standard: "gpt-5.6-terra",
            quality: "gpt-5.6-terra",
            escalation: "gpt-5.6-terra",
          },
          imageGeneration: {
            model: IMAGE_MODEL,
            maxCostMicrosPerImage: IMAGE_MAX,
            pricingVerifiedAt: new Date().toISOString(),
          },
        }),
      );
      await h.setPolicy({ maxPerDay: 2, minIntervalMinutes: 60 });
      await h.connectTelegram();
      await h.run(async (tx) => {
        const connector = (await list(tx, project.owner, "connectors")).find(
          (row) => data(row).provider === "postiz",
        )!;
        await update(tx, project.owner, connector, {
          ...data(connector),
          baseUrl: "https://postiz.example.invalid",
          encryptedCredential: encrypt(
            "synthetic-token",
            process.env.CREDENTIAL_KEY!,
          ),
        });
      });
      registerAgentSpecialists();
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await project.cleanup();
    });
    afterAll(() => closeDatabase());

    async function start(delivery = "publish", image = true, fromPlan = false) {
      const conversation = await createConversation(project.owner);
      fake.chat = [
        [
          {
            type: "tool_search_call",
            id: "ts",
            call_id: "s",
            execution: "client",
            status: "completed",
            arguments: { goal: "propose recurring assignment" },
          },
        ],
        [
          call("assignment_intake", {
            requestedLanguage: "en",
            monthlyBudgetMicros: 30_000_000,
          }),
        ],
        [
          call("assignment_propose", {
            requestedLanguage: "en",
            name: "Weekly organic product marketing",
            kind: "standing",
            schedule: {
              rhythm: "weekly",
              weekdays: [morning.getUTCDay()],
              times: ["10:00"],
              leadMinutes: 360,
              date: null,
            },
            contentType: "social",
            channels: [X, TELEGRAM],
            topicFrame: "English beta access updates for product teams",
            tone: null,
            image,
            styleAssetIds: [],
            vetoMinutes: 180,
            monthlyBudgetMicros: 30_000_000,
            delivery,
            approvalMode: null,
            sharedAcrossChannels: null,
            format: null,
            banner: null,
          }),
        ],
        [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Confirm preparation; every post still needs your approval.",
              },
            ],
          },
        ],
      ];
      const sent = await sendMessage(project.owner, conversation.id, {
        text: "Take over our weekly organic marketing in English. Prepare posts and images for my approval, with a monthly AI budget of USD 30.",
        clientRequestId: randomUUID(),
      });
      await runChat(project.owner, sent.runId);
      expect((await getRun(project.owner, sent.runId)).status).toBe(
        "succeeded",
      );
      const [assignment] = await h.rows("assignments");
      expect(assignment).toMatchObject({
        status: "draft",
        approvalMode: "human_each",
      });
      expect(await h.rows("assignment_runs")).toEqual([]);
      if (fromPlan)
        await h.run(async (tx) => {
          const spec = await planSpec(tx, project.owner);
          spec.channels = [X, TELEGRAM];
          spec.monthlyBudgetMicros = 30_000_000;
          spec.horizon.startAt = new Date(Date.now() - 1000).toISOString();
          // Cover the second actual weekly slot independently of today and DST.
          spec.horizon.endAt = new Date(
            morning.valueOf() + 8 * 86400000,
          ).toISOString();
          spec.cadence = {
            rhythm: "weekly",
            weekdays: assignment!.schedule.weekdays,
            times: assignment!.schedule.times,
          };
          const beta = await entity(
            tx,
            project.owner,
            "facts",
            project.betaFactId,
          );
          if (!spec.facts.some((f) => f.id === beta.id))
            spec.facts.push({ id: beta.id, version: beta.version });
          spec.existingWork = [
            {
              kind: "assignments",
              id: assignment!.id,
              version: assignment!.version,
              proposedChange: "Adopt this exact recurring assignment",
            },
          ];
          let plan = await proposePlan(tx, project.owner, spec);
          await decideActionRequest(tx, project.owner, plan.actionRequest!.id, {
            version: plan.actionRequest!.version,
            packageHash: plan.actionRequest!.packageHash,
            decision: "approve",
          });
          plan = await planView(tx, project.owner, plan.id);
          const original = data(
            await entity(tx, project.owner, "assignments", assignment!.id),
          );
          const contents = Object.fromEntries(
            [
              "name",
              "kind",
              "schedule",
              "contentType",
              "channels",
              "topicFrame",
              "tone",
              "image",
              "styleAssetIds",
              "vetoMinutes",
              "monthlyBudgetMicros",
              "approvalMode",
              "delivery",
              "sharedAcrossChannels",
              "format",
              "banner",
            ]
              .filter((key) => original[key] !== undefined)
              .map((key) => [key, original[key]]),
          );
          plan = await proposeActivation(tx, project.owner, plan.id, {
            version: plan.version,
            children: [
              {
                key: "weekly",
                existing: { id: assignment!.id, version: assignment!.version },
                assignment: contents,
              },
            ],
          });
          await decideActionRequest(
            tx,
            project.owner,
            plan.activationRequest!.id,
            {
              version: plan.activationRequest!.version,
              packageHash: plan.activationRequest!.packageHash,
              decision: "approve",
              imageRightsConsent: image,
            },
          );
          expect((await planView(tx, project.owner, plan.id)).status).toBe(
            "active",
          );
          expect((await list(tx, project.owner, "assignments")).length).toBe(1);
        });
      else
        await h.run(async (tx) => {
          const request = await entity(
            tx,
            project.owner,
            "action_requests",
            assignment!.actionRequestId,
          );
          await decideActionRequest(tx, project.owner, request.id, {
            version: request.version,
            packageHash: data(request).packageHash,
            decision: "approve",
            ...(image ? { imageRightsConsent: true } : {}),
          });
        });
      // The weekly planner prepares a day ahead. Clock stays within the fixture's fact validity.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(
        new Date(
          Math.max(Date.now(), morning.valueOf() - 86400000 + 8 * 3600000),
        ),
      );
      await h.run((tx) => sweepProject(tx, project.owner, new Date()));
      await h.run((tx) => sweepProject(tx, project.owner, new Date()));
      expect(await h.rows("assignment_runs")).toHaveLength(1);
      for (let pass = 0; pass < 8; pass++) {
        const queued = (await h.rows("agent_tasks")).filter(
          (t) => t.status === "queued",
        );
        if (!queued.length) break;
        for (const task of queued) await runAgentTask(h.worker(), task.id);
      }
      const tasks = await h.rows("agent_tasks");
      expect(
        tasks.map((t) => [t.role, t.status]),
        JSON.stringify(
          tasks.map((t) => ({
            role: t.role,
            error: t.error,
            errorCode: t.errorCode,
          })),
        ),
      ).toEqual(
        expect.arrayContaining([
          ["analytics", "done"],
          ["research", "done"],
          ["strategy", "done"],
          ["copywriter", "done"],
          ["review", "done"],
        ]),
      );
      if (image)
        expect(tasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "visual", status: "done" }),
          ]),
        );
      const drafts = await h.rows("content");
      if (fromPlan) {
        expect(drafts.every((d) => d.marketingPlan?.revision === 1)).toBe(true);
        expect(
          (await h.rows("missions")).every(
            (m) => m.marketingPlan?.revision === 1,
          ),
        ).toBe(true);
      }
      expect(drafts).toHaveLength(2);
      expect(drafts.every((d) => d.language === "en")).toBe(true);
      expect(
        drafts.every(
          (d) => d.status === "needs_review" && d.approvalMode === "human_each",
        ),
      ).toBe(true);
      if (image)
        expect(drafts.every((d) => typeof d.assetId === "string")).toBe(true);
      const [run] = await h.rows("assignment_runs");
      await h.run((tx) => scheduleApproved(tx, project.owner, run!.id));
      expect(await h.rows("publications")).toEqual([]);
      expect(await h.rows("postiz_drafts")).toEqual([]);
      expect(fake.posts).not.toHaveBeenCalled();
      expect(fake.upload).not.toHaveBeenCalled();
      const reloaded = await getConversation(project.owner, conversation.id);
      const live = (reloaded.assignments as any[]).find(
        (item) => item.id === assignment!.id,
      );
      expect(live.latestRun).toMatchObject({
        id: run!.id,
        status: run!.status,
        costMicros: run!.costMicros,
        deliverables: expect.arrayContaining([
          expect.objectContaining({
            contentId: drafts[0].id,
            outcome: "awaiting_owner",
          }),
        ]),
      });
      return { assignment: assignment!, drafts, run: run! };
    }
    const release = (draft: any, actor = project.owner) =>
      h.run((tx) => releaseAssignmentDraft(tx, actor, draft.id, draft.version));

    it("runs chat → plan activation with existing work → scheduler → all specialists → human release → one publication; remains recurring", async () => {
      const { drafts, run } = await start("publish", true, true);
      await expect(release(drafts[0], project.editor)).rejects.toThrow(
        "OWNER_REQUIRED",
      );
      const [a, b] = await Promise.all([
        release(drafts[0]),
        release(drafts[0]),
      ]);
      expect(a.publicationId).toBe(b.publicationId);
      expect(await h.rows("publications")).toHaveLength(1);
      vi.setSystemTime(new Date(a.scheduledAt));
      await Promise.all([
        dispatchPublication(h.worker(), a.publicationId!),
        dispatchPublication(h.worker(), a.publicationId!),
      ]);
      expect(await h.rows("publications")).toEqual([
        expect.objectContaining({ status: "published_test" }),
      ]);
      expect(fake.posts).not.toHaveBeenCalled();
      const spend = await h.run((tx) =>
        tx.budgetReservation.findMany({
          where: { projectId: project.owner.projectId },
        }),
      );
      expect(spend.length).toBeGreaterThan(6);
      expect(spend.every((r) => r.state === "settled")).toBe(true);
      vi.setSystemTime(
        new Date(morning.valueOf() + 6 * 86400000 + 8 * 3600000),
      );
      await h.run((tx) => sweepProject(tx, project.owner, new Date()));
      expect(await h.rows("assignment_runs")).toHaveLength(2);
      expect(
        (await h.rows("assignment_runs")).filter((r) => r.id === run.id),
      ).toHaveLength(1);
    });

    it("creates exactly one mock Postiz draft only after exact human approval", async () => {
      const { drafts } = await start("postiz_draft");
      await expect(
        h.run((tx) =>
          draftTarget(tx, project.owner, drafts[0]!.id, drafts[0]!.version),
        ),
      ).rejects.toThrow("ASSIGNMENT_HUMAN_APPROVAL_REQUIRED");
      const [a, b] = await Promise.all([
        release(drafts[0]),
        release(drafts[0]),
      ]);
      expect(a.postizDraftId).toBe(b.postizDraftId);
      await deliverPostizDraft(h.worker(), a.postizDraftId!);
      await deliverPostizDraft(h.worker(), a.postizDraftId!);
      expect(fake.posts).toHaveBeenCalledTimes(1);
      expect(fake.posts.mock.calls[0]![0].type).toBe("draft");
      expect(await h.rows("publications")).toEqual([]);
      expect(await h.rows("postiz_drafts")).toEqual([
        expect.objectContaining({ status: "accepted" }),
      ]);
    });

    it.each([
      "body",
      "image",
      "policy",
      "assignment",
      "owner",
      "module",
      "asset_version",
      "schedule",
    ])(
      "invalidates an exact release when %s changes before the external handoff",
      async (change) => {
        const { drafts, assignment } = await start(
          "postiz_draft",
          change === "asset_version",
        );
        const released = await release(drafts[0]);
        if (change === "module") {
          vi.stubEnv("ORBIT_MODULES", "true");
          await h.run((tx) =>
            tx.projectModule.upsert({
              where: {
                workspaceId_projectId_moduleId: {
                  workspaceId: project.owner.workspaceId,
                  projectId: project.owner.projectId,
                  moduleId: "marketing",
                },
              },
              create: {
                workspaceId: project.owner.workspaceId,
                projectId: project.owner.projectId,
                moduleId: "marketing",
                moduleVersion: "1.0.0",
                enabled: false,
              },
              update: { enabled: false },
            }),
          );
        } else if (change === "owner") {
          await authDb.workspaceMember.updateMany({
            where: {
              workspaceId: project.owner.workspaceId,
              userId: project.owner.userId,
            },
            data: { role: "editor" },
          });
          await authDb.projectMember.updateMany({
            where: {
              projectId: project.owner.projectId,
              userId: project.owner.userId,
            },
            data: { role: "editor" },
          });
        } else
          await h.run(async (tx) => {
            const content = await entity(
              tx,
              project.owner,
              "content",
              drafts[0]!.id,
            );
            if (change === "body")
              await update(tx, project.owner, content, {
                ...data(content),
                body: data(content).body + " Changed.",
              });
            if (change === "image") {
              const asset = await create(tx, project.owner, "assets", {
                name: "New unreviewed image",
                status: "approved",
                mime: "image/png",
              });
              await update(tx, project.owner, content, {
                ...data(content),
                assetId: asset.id,
              });
            }
            if (change === "schedule")
              await update(tx, project.owner, content, {
                ...data(content),
                scheduledAt: new Date(
                  Date.parse(data(content).scheduledAt) + 60000,
                ).toISOString(),
              });
            if (change === "asset_version") {
              const asset = await entity(
                tx,
                project.owner,
                "assets",
                data(content).assetId,
              );
              await update(tx, project.owner, asset, {
                ...data(asset),
                name: "Changed image metadata/version",
              });
            }
            if (change === "policy") {
              const [policy] = await list(tx, project.owner, "policies");
              await update(tx, project.owner, policy!, {
                ...data(policy!),
                maxPerDay: 1,
              });
            }
            if (change === "assignment") {
              const row = await entity(
                tx,
                project.owner,
                "assignments",
                assignment.id,
              );
              await update(tx, project.owner, row, {
                ...data(row),
                approvalMode: "delegated_review",
              });
            }
          });
        await deliverPostizDraft(h.worker(), released.postizDraftId!);
        expect(fake.posts).not.toHaveBeenCalled();
        expect(fake.upload).not.toHaveBeenCalled();
      },
    );

    it("never duplicates an external handoff when workers race; ambiguous in-flight work is reconciled instead", async () => {
      const { drafts } = await start("postiz_draft", false);
      const released = await release(drafts[0]);
      await Promise.all([
        deliverPostizDraft(h.worker(), released.postizDraftId!),
        deliverPostizDraft(h.worker(), released.postizDraftId!),
      ]);
      expect(fake.posts.mock.calls.length).toBeLessThanOrEqual(1);
      const [handoff] = await h.rows("postiz_drafts");
      expect(["accepted", "outcome_unknown"]).toContain(handoff!.status);
      await deliverPostizDraft(h.worker(), released.postizDraftId!);
      expect(fake.posts.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it("rechecks exact consumed approval only for the same claimed publication", async () => {
      const { drafts } = await start("publish", false);
      const released = await release(drafts[0]);
      vi.setSystemTime(new Date(released.scheduledAt));
      const claimed = await h.run((tx) =>
        claimPublication(tx, project.owner, released.publicationId!),
      );
      expect(claimed.send).toBe(true);
      expect(
        await h.run((tx) =>
          assignmentHumanApprovalBlocker(tx, project.owner, drafts[0]!.id),
        ),
      ).toBe("ASSIGNMENT_HUMAN_APPROVAL_REQUIRED");
      expect(
        await h.run((tx) =>
          assignmentHumanApprovalBlocker(
            tx,
            project.owner,
            drafts[0]!.id,
            new Date(),
            released.publicationId!,
          ),
        ),
      ).toBeNull();
      await h.run(async (tx) => {
        const c = await entity(tx, project.owner, "content", drafts[0]!.id);
        await update(tx, project.owner, c, {
          ...data(c),
          body: data(c).body + " Changed after claim.",
        });
      });
      const final = await h.run((tx) =>
        preflight(tx, project.owner, drafts[0]!.id, {
          test: true,
          ignoreApproval: true,
          approvalPublicationId: released.publicationId!,
        }),
      );
      expect(final.blockers).toContain("ASSIGNMENT_HUMAN_APPROVAL_REQUIRED");
      expect(fake.posts).not.toHaveBeenCalled();
    });

    it("rejects stale release versions, out-of-project content and over-budget proposals", async () => {
      const { drafts } = await start("publish", false);
      await expect(
        h.run((tx) =>
          releaseAssignmentDraft(
            tx,
            project.owner,
            drafts[0]!.id,
            drafts[0]!.version - 1,
          ),
        ),
      ).rejects.toThrow("VERSION_CONFLICT");
      const other = await createPackageProject();
      try {
        const foreign = assignmentRun(other);
        await expect(
          foreign.run((tx) =>
            releaseAssignmentDraft(
              tx,
              other.owner,
              drafts[0]!.id,
              drafts[0]!.version,
            ),
          ),
        ).rejects.toThrow("NOT_FOUND");
      } finally {
        await other.cleanup();
      }
      const conversation = await createConversation(project.owner);
      const [assignment] = await h.rows("assignments");
      const {
        name,
        kind,
        schedule,
        contentType,
        channels,
        topicFrame,
        image,
        styleAssetIds,
        vetoMinutes,
      } = assignment!;
      await expect(
        proposeAssignment(project.owner, conversation.id, {
          name,
          kind,
          schedule,
          contentType,
          channels,
          topicFrame,
          image,
          styleAssetIds,
          vetoMinutes,
          monthlyBudgetMicros: 10_000_000_000,
        }),
      ).rejects.toThrow("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT");
      expect(await h.rows("publications")).toEqual([]);
    });

    it("keeps quality-approved style-only copy in human review", async () => {
      fake.generate.mockImplementation(async () => generated("Learn more."));
      const { drafts } = await start("publish", false);
      expect(drafts.every((d) => d.status === "needs_review")).toBe(true);
    });

    it("does not silently remove an approved image on a Postiz upload failure", async () => {
      const { drafts } = await start("postiz_draft", true);
      const released = await release(drafts[0]);
      fake.upload.mockRejectedValue(new Error("SYNTHETIC_MEDIA_FAILURE"));
      await deliverPostizDraft(h.worker(), released.postizDraftId!);
      expect(fake.posts).not.toHaveBeenCalled();
      expect((await h.rows("postiz_drafts"))[0]!.status).toBe("failed");
    });

    it("revalidates human approval after media upload before creating the Postiz post", async () => {
      const { drafts } = await start("postiz_draft", true);
      const released = await release(drafts[0]);
      fake.upload.mockImplementation(async () => {
        await h.run(async (tx) => {
          const asset = await entity(
            tx,
            project.owner,
            "assets",
            drafts[0]!.assetId,
          );
          await update(tx, project.owner, asset, {
            ...data(asset),
            usageApproved: false,
          });
        });
        return { id: "synthetic-media", path: "/synthetic.png" };
      });
      await deliverPostizDraft(h.worker(), released.postizDraftId!);
      expect(fake.upload).toHaveBeenCalledTimes(1);
      expect(fake.posts).not.toHaveBeenCalled();
    });

    it("does not export human-gated article content to Drive on agent review alone", async () => {
      const { drafts } = await start("publish", false);
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", drafts[0]!.id);
        await update(tx, project.owner, row, { ...data(row), type: "blog" });
      });
      await expect(saveDraftToDrive(h.worker(), drafts[0]!.id)).rejects.toThrow(
        "ASSIGNMENT_HUMAN_APPROVAL_REQUIRED",
      );
      expect(fake.drive).not.toHaveBeenCalled();
    });

    it.each([undefined, "delegated_review"])(
      "preserves legacy/delegated confirmation and automatic scheduling (%s)",
      async (approvalMode) => {
        const legacy = { name: "legacy", channels: [X], delivery: "publish" };
        expect(assignmentHash(legacy)).toBe(
          assignmentHash({ ...legacy, approvalMode: "delegated_review" }),
        );
        // Existing fixture deliberately has no approvalMode: actual old records retain their authority.
        const assignment = await h.makeAssignment(
          approvalMode ? { approvalMode } : {},
        );
        expect(data(assignment).approvalMode).toBe(approvalMode);
        await h.planWithBriefs((slots) => slots.map((slot) => h.brief(slot)));
        for (const copy of (await h.rows("agent_tasks")).filter(
          (t) => t.role === "copywriter",
        ))
          await runAgentTask(h.worker(), copy.id);
        await runAgentTask(h.worker(), (await h.task("review")).id);
        expect(await h.rows("publications")).toHaveLength(2);
        expect(await h.rows("approvals")).toEqual([]);
      },
    );
  },
);
