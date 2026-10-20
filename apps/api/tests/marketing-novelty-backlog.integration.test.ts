import { preflight } from "../src/modules/marketing/policy/policy.ts";
import { retrieve } from "../src/platform/knowledge/services.ts";
import { retrieveHybrid } from "../src/platform/knowledge/services.ts";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
const paid = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  respond: vi.fn(),
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  ...paid,
}));
import {
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import {
  createPackageProject,
  X,
  TELEGRAM,
} from "./support/package-project.ts";
import { assignmentRun, tomorrowMorning } from "./support/assignment-review.ts";
import {
  reserveTopic,
  topicKey,
  marketingHistory,
  assertDistinctDraft,
  prepareContentNovelty,
  commitTopic,
} from "../src/modules/marketing/agents/novelty.ts";
import { reserveStrategyBriefs } from "../src/modules/marketing/agents/topic-briefs.ts";
import {
  reviewBacklog,
  assertReviewCapacity,
  REVIEW_BACKLOG_FULL,
} from "../src/modules/marketing/agents/review-backlog.ts";
import {
  planAssignmentRuns,
  resumeReviewBacklog,
} from "../src/modules/marketing/agents/assignment-runs.ts";
import { runAgentTask } from "../src/modules/marketing/agents/specialists/runner.ts";
import { generateMissionLive } from "../src/modules/marketing/pipeline/generation.ts";
import {
  assignmentHash,
  updateAssignment,
} from "../src/modules/marketing/agents/assignments.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const identity = {
  topic: "Beta access",
  angle: "First-day checklist",
  pillar: "Education",
};
describe.skipIf(!enabled)(
  "MA-05 shared novelty and bounded review admission",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, fn);
    const hold = (ownerKey: string, angle = identity.angle) =>
      run((tx) =>
        reserveTopic(tx, project.owner, {
          channel: X,
          identity: { ...identity, angle },
          ownerKey,
        }),
      );
    beforeEach(async () => {
      vi.stubEnv("ORBIT_AGENTS", "true");
      project = await createPackageProject();
      for (const fn of Object.values(paid))
        fn.mockReset().mockRejectedValue(new Error("UNRECORDED_PAID_CALL"));
    });
    afterEach(async () => {
      await project.cleanup();
      vi.unstubAllEnvs();
    });
    afterAll(closeDatabase);
    it("serializes competing identities and retries, while allowing another angle and channel", async () => {
      const result = await Promise.allSettled([
        hold("assignment:a"),
        hold("assignment:b"),
      ]);
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(result.filter((r) => r.status === "rejected")[0]).toMatchObject({
        reason: { code: "TOPIC_ANGLE_RESERVED" },
      });
      const winner = (
        result.find(
          (r) => r.status === "fulfilled",
        ) as PromiseFulfilledResult<any>
      ).value;
      expect((await hold(data(winner).ownerKey)).id).toBe(winner.id);
      await expect(
        hold("other-angle", "Troubleshooting first-day access"),
      ).resolves.toBeTruthy();
      await expect(
        run((tx) =>
          reserveTopic(tx, project.owner, {
            channel: TELEGRAM,
            identity,
            ownerKey: "other-channel",
          }),
        ),
      ).resolves.toBeTruthy();
      expect(topicKey(X, identity)).toBe(
        topicKey(X, {
          ...identity,
          topic: " BETA-access! ",
          pillar: "Relabeled",
        }),
      );
    });
    it("does not leak reservations to another project", async () => {
      await hold("first");
      const other = await createPackageProject();
      try {
        await expect(
          scoped(other.owner.workspaceId, other.owner.projectId, (tx) =>
            reserveTopic(tx, other.owner, {
              channel: X,
              identity,
              ownerKey: "other",
            }),
          ),
        ).resolves.toBeTruthy();
      } finally {
        await other.cleanup();
      }
    });
    it("rolls back all channels of a shared brief when one channel is occupied", async () => {
      const helpers = assignmentRun(project);
      const a = await helpers.makeAssignment();
      const slot = new Date().toISOString();
      const r = await run((tx) =>
        create(tx, project.owner, "assignment_runs", {
          assignmentId: a.id,
          sharedAcrossChannels: true,
          slots: [
            { channel: X, at: slot, groupAt: slot },
            { channel: TELEGRAM, at: slot, groupAt: slot },
          ],
        }),
      );
      await run((tx) =>
        reserveTopic(tx, project.owner, {
          channel: TELEGRAM,
          identity,
          ownerKey: "competitor",
        }),
      );
      const output = await run((tx) =>
        reserveStrategyBriefs(
          tx,
          project.owner,
          { id: randomUUID(), runId: r.id, assignmentId: a.id },
          { briefs: [{ channel: X, slotAt: slot, ...identity }] },
        ),
      );
      expect(output.briefs).toEqual([]);
      expect(output.dropped).toHaveLength(2);
      expect(
        await run((tx) =>
          list(tx, project.owner, "marketing_topic_reservations"),
        ),
      ).toHaveLength(1);
    });
    it("shares manual, package and assignment drafts plus held and external history, with honest coverage", async () => {
      await run(async (tx) => {
        for (const origin of ["package", "assignment", "manual"]) {
          const mission =
            origin === "manual"
              ? null
              : await create(
                  tx,
                  project.owner,
                  "missions",
                  origin === "package"
                    ? { packageId: randomUUID() }
                    : { assignmentId: randomUUID() },
                );
          await create(tx, project.owner, "content", {
            channel: X,
            title: origin,
            body: `Current ${origin} draft`,
            status: "needs_review",
            missionId: mission?.id,
          });
        }
        await create(tx, project.owner, "channel_posts", {
          channel: X,
          source: "external",
          state: "PUBLISHED",
          text: "External history",
          publishedAt: new Date().toISOString(),
        });
      });
      await hold("held");
      const read = () => run((tx) => marketingHistory(tx, project.owner, [X]));
      let h = await read();
      expect(h.items.map((i) => i.source)).toEqual([
        "orbit",
        "orbit",
        "orbit",
        "reservation",
        "external",
      ]);
      expect(h.remote).toMatchObject({
        coverage: "unavailable",
        complete: false,
      });
      const marker = await run((tx) =>
        create(tx, project.owner, "channel_post_sync", {
          status: "failed",
          attemptedAt: new Date().toISOString(),
        }),
      );
      expect((await read()).remote.coverage).toBe("failed");
      await run((tx) =>
        update(tx, project.owner, marker, {
          ...data(marker),
          status: "ok",
          succeededAt: new Date(Date.now() - 3 * 3600000).toISOString(),
        }),
      );
      expect((await read()).remote.coverage).toBe("stale");
      h = await read();
      expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThan(12000);
    });
    it("checks native content against the same identity without rejecting shared facts in a distinct angle", async () => {
      const first = await run(async (tx) => {
        const d: any = {
          channel: X,
          body: "Beta access is invite only. A practical checklist for the first day.",
          novelty: identity,
          status: "draft",
        };
        const h = await prepareContentNovelty(tx, project.owner, d);
        const c = await create(tx, project.owner, "content", d);
        await commitTopic(tx, project.owner, h!, c.id);
        return c;
      });
      await expect(
        run((tx) =>
          assertDistinctDraft(tx, project.owner, X, data(first).body),
        ),
      ).rejects.toThrow("DUPLICATE_CONTENT");
      await expect(
        run((tx) =>
          prepareContentNovelty(tx, project.owner, {
            channel: X,
            body: "Beta access is invite only. Troubleshoot an invitation with these steps.",
            novelty: { ...identity, angle: "Troubleshooting" },
          }),
        ),
      ).resolves.toBeTruthy();
      await expect(hold("assignment-later")).rejects.toThrow(
        "TOPIC_ANGLE_RESERVED",
      );
      await expect(
        run((tx) =>
          prepareContentNovelty(
            tx,
            project.owner,
            { ...data(first), body: "A revised first-day checklist." },
            first.id,
          ),
        ),
      ).resolves.toBeTruthy();
    });
    it("refuses a duplicate mission intent before retrieval/model reservations", async () => {
      await hold("existing");
      const mission = await run((tx) =>
        create(tx, project.owner, "missions", {
          title: identity.topic,
          goal: identity.angle,
          novelty: identity,
          channels: [X],
          contentType: "social",
          maxContents: 1,
          status: "ready",
          startAt: new Date(Date.now() - 60000).toISOString(),
          endAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      );
      await expect(
        generateMissionLive(project.owner, mission.id, randomUUID()),
      ).rejects.toThrow("TOPIC_ANGLE_RESERVED");
      for (const fn of Object.values(paid)) expect(fn).not.toHaveBeenCalled();
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { projectId: project.owner.projectId },
          }),
        ),
      ).toBe(0);
    });
    it("stops full queues without tasks/spend, deduplicates blockers and resumes after review capacity is freed", async () => {
      const helpers = assignmentRun(project);
      const a = await helpers.makeAssignment({
        pendingReviewLimit: 2,
        approvalMode: "human_each",
      });
      const contents = await run(async (tx) =>
        Promise.all(
          [1, 2].map((n) =>
            create(tx, project.owner, "content", {
              assignmentId: a.id,
              channel: X,
              body: `Waiting ${n}`,
              status: "needs_review",
            }),
          ),
        ),
      );
      await helpers.connectTelegram();
      await helpers.setPolicy({
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2027-12-31T00:00:00.000Z",
        maxPerDay: 4,
      });
      const morning = tomorrowMorning();
      for (let i = 0; i < 2; i++)
        expect(
          await run((tx) => planAssignmentRuns(tx, project.owner, morning)),
        ).toMatchObject({ created: 0 });
      expect(
        await run((tx) => list(tx, project.owner, "exceptions")),
      ).toHaveLength(1);
      expect(await helpers.rows("agent_tasks")).toHaveLength(0);
      expect(
        await run((tx) => reviewBacklog(tx, project.owner, a.id)),
      ).toMatchObject({ pending: 2, held: 0, blocked: true });
      await run(async (tx) => {
        for (const c of contents)
          await update(tx, project.owner, c, {
            ...data(c),
            status: "rejected",
          });
      });
      const admissions = await Promise.all([
        run((tx) => planAssignmentRuns(tx, project.owner, morning)),
        run((tx) => planAssignmentRuns(tx, project.owner, morning)),
      ]);
      expect(admissions.reduce((sum, r) => sum + r.created, 0)).toBe(1);
      const [r] = await helpers.rows("assignment_runs");
      expect(
        await run((tx) => reviewBacklog(tx, project.owner, a.id)),
      ).toMatchObject({ pending: 0, held: 2, blocked: true });
      await expect(
        run((tx) => assertReviewCapacity(tx, project.owner, a.id, r.id)),
      ).resolves.toBeUndefined();
      for (const fn of Object.values(paid)) expect(fn).not.toHaveBeenCalled();
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { projectId: project.owner.projectId },
          }),
        ),
      ).toBe(0);
    });
    it("holds already queued workers at zero cost and requeues unsent work exactly once after capacity returns", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment({ pendingReviewLimit: 2 });
      await h.setPolicy({ maxPerDay: 4 });
      await run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
      const task = (await h.rows("agent_tasks"))[0];
      const c = await run((tx) =>
        create(tx, project.owner, "content", {
          assignmentId: a.id,
          status: "needs_review",
          body: "Extra pending draft",
          channel: X,
        }),
      );
      await runAgentTask(h.worker(), task.id);
      expect(await h.rows("agent_tasks")).toContainEqual(
        expect.objectContaining({
          id: task.id,
          status: "queued",
          errorCode: REVIEW_BACKLOG_FULL,
        }),
      );
      for (const fn of Object.values(paid)) expect(fn).not.toHaveBeenCalled();
      // A crash before the first paid reservation can leave the task running.
      // The same capacity barrier must park that recovery in queued as well.
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", task.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "running",
        });
      });
      await runAgentTask(h.worker(), task.id);
      expect(await h.rows("agent_tasks")).toContainEqual(
        expect.objectContaining({
          id: task.id,
          status: "queued",
          errorCode: REVIEW_BACKLOG_FULL,
        }),
      );
      // Model the worker acknowledging its original job, then the owner's review.
      await run(async (tx) => {
        for (const j of await list(tx, project.owner, "jobs"))
          if (data(j).resourceId === task.id)
            await update(tx, project.owner, j, {
              ...data(j),
              status: "succeeded",
            });
        await update(tx, project.owner, c, { ...data(c), status: "rejected" });
      });
      await run((tx) => resumeReviewBacklog(tx, project.owner));
      await run((tx) => resumeReviewBacklog(tx, project.owner));
      const jobs = await h.rows("jobs");
      expect(
        jobs.filter((j) => j.resourceId === task.id && j.status === "queued"),
      ).toHaveLength(1);
    });

    it("frees pending review capacity after a concrete handoff and restores it when the handoff is canceled", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment({ pendingReviewLimit: 2 });
      const c = await run((tx) =>
        create(tx, project.owner, "content", {
          assignmentId: a.id,
          status: "reviewed",
          channel: X,
          body: "Reviewed draft",
        }),
      );
      expect(
        (await run((tx) => reviewBacklog(tx, project.owner, a.id))).pending,
      ).toBe(1);
      const output = await run((tx) =>
        create(tx, project.owner, "publications", {
          assignmentId: a.id,
          contentId: c.id,
          status: "intent_created",
        }),
      );
      expect(
        (await run((tx) => reviewBacklog(tx, project.owner, a.id))).pending,
      ).toBe(0);
      await run((tx) =>
        update(tx, project.owner, output, {
          ...data(output),
          status: "canceled",
        }),
      );
      expect(
        (await run((tx) => reviewBacklog(tx, project.owner, a.id))).pending,
      ).toBe(1);
    });
    it("requires a fresh exact owner confirmation when the review limit changes", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment({ pendingReviewLimit: 2 });
      const changed = await run((tx) =>
        updateAssignment(tx, project.owner, a.id, a.version, {
          pendingReviewLimit: 4,
        }),
      );
      expect(data(changed)).toMatchObject({
        status: "draft",
        pendingReviewLimit: 4,
      });
      expect(data(changed).actionRequestId).toBeTruthy();
      expect(data(changed).confirmation).toBeNull();
    });

    it("rechecks admission at paid retrieval after another draft filled the queue", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment({ pendingReviewLimit: 2 });
      await h.setPolicy({ maxPerDay: 4 });
      await run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
      const [owned] = await h.rows("assignment_runs");
      await expect(
        run((tx) => assertReviewCapacity(tx, project.owner, a.id, owned.id)),
      ).resolves.toBeUndefined();
      await run((tx) =>
        create(tx, project.owner, "content", {
          assignmentId: a.id,
          status: "draft",
          body: "A newly pending manual draft",
          channel: X,
        }),
      );
      await expect(
        retrieveHybrid(
          project.owner,
          {
            query: "Beta access",
            purpose: "public",
            language: "en",
            forModel: true,
          },
          randomUUID(),
          undefined,
          {
            agentRunId: null,
            beforeReserve: (tx) =>
              assertReviewCapacity(tx, project.owner, a.id, owned.id),
          },
        ),
      ).rejects.toThrow(REVIEW_BACKLOG_FULL);
      expect(paid.embed).not.toHaveBeenCalled();
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { projectId: project.owner.projectId },
          }),
        ),
      ).toBe(0);
    });
    it("does not resume a waiting run after all its slots have passed", async () => {
      const h = assignmentRun(project);
      await h.makeAssignment({ pendingReviewLimit: 2 });
      const morning = tomorrowMorning();
      await run((tx) => planAssignmentRuns(tx, project.owner, morning));
      await run((tx) =>
        resumeReviewBacklog(
          tx,
          project.owner,
          new Date(morning.valueOf() + 3 * 86400000),
        ),
      );
      expect(await h.rows("assignment_runs")).toEqual([
        expect.objectContaining({
          status: "canceled",
          errorCode: "SLOT_UNAVAILABLE",
        }),
      ]);
      for (const fn of Object.values(paid)) expect(fn).not.toHaveBeenCalled();
    });
    it("includes older current drafts and exposes scan truncation without unbounded model output", async () => {
      await run(async (tx) => {
        const old = await create(tx, project.owner, "content", {
          channel: X,
          status: "needs_review",
          title: "Old pending review",
          body: "Still current",
        });
        await tx.entity.update({
          where: { id: old.id },
          data: { createdAt: new Date(Date.now() - 40 * 86400000) },
        });
      });
      expect(
        (await run((tx) => marketingHistory(tx, project.owner, [X]))).items,
      ).toContainEqual(
        expect.objectContaining({ title: "Old pending review" }),
      );
      await expect(
        run((tx) => assertDistinctDraft(tx, project.owner, X, "Still current")),
      ).rejects.toThrow("DUPLICATE_CONTENT");
      await run((tx) =>
        tx.entity.createMany({
          data: Array.from({ length: 301 }, (_, i) => ({
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            kind: "content",
            data: { channel: X, status: "draft", body: `Synthetic ${i}` },
          })),
        }),
      );
      const history = await run((tx) =>
        marketingHistory(tx, project.owner, [X]),
      );
      expect(history.truncated).toBe(true);
      expect(history.items.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(12000);
      await expect(
        run((tx) => assertDistinctDraft(tx, project.owner, X, "Another draft")),
      ).rejects.toThrow("NOVELTY_HISTORY_TRUNCATED");
    });

    it("retains unfilled slot capacity when a draft has a superseded revision", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment({ pendingReviewLimit: 3 });
      await h.setPolicy({ maxPerDay: 4 });
      await run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
      const [r] = await h.rows("assignment_runs");
      expect(r.slots).toHaveLength(2);
      await run(async (tx) => {
        const fields = {
          assignmentId: a.id,
          assignmentRunId: r.id,
          channel: X,
          briefKey: `${X}@${r.slots[0].at}`,
          status: "draft",
        };
        await create(tx, project.owner, "content", {
          ...fields,
          body: "Old",
          supersededBy: randomUUID(),
        });
        await create(tx, project.owner, "content", {
          ...fields,
          body: "Revised",
        });
      });
      expect(
        await run((tx) => reviewBacklog(tx, project.owner, a.id)),
      ).toMatchObject({ pending: 1, held: 1, available: 1, blocked: true });
    });
    it("does not block publishing solely because a genuinely different angle uses the same verified fact", async () => {
      await run(async (tx) => {
        const fact = (await list(tx, project.owner, "facts")).find(
          (f) => data(f).key === "beta.access",
        )!;
        const text = String(data(fact).value);
        const evidence = await retrieve(tx, project.owner, {
          query: "beta.access",
          purpose: "public",
          language: "en",
          at: new Date(),
        });
        const base = {
          channel: X,
          type: "social",
          language: "en",
          status: "draft",
          synthetic: true,
          risk: "routine",
          evidenceId: evidence.id,
          claims: [{ kind: "fact", factId: fact.id, text }],
        };
        const first = await create(tx, project.owner, "content", {
          ...base,
          title: "Getting started",
          body: `${text} Begin with an onboarding checklist for your team before arranging the kickoff.`,
        });
        await tx.entity.update({
          where: { id: first.id },
          data: { createdAt: new Date(Date.now() - 1000) },
        });
        const next = await create(tx, project.owner, "content", {
          ...base,
          title: "Troubleshooting",
          body: `${text} Solve invitation issues by checking your mailbox filters and contacting the project administrator.`,
        });
        const check = await preflight(tx, project.owner, next.id, {
          test: true,
        });
        expect(check.blockers).not.toContain("CLAIM_OVERLAP_DUPLICATE");
        expect(check.blockers).not.toContain("DUPLICATE_CONTENT");
      });
    });

    it("withholds source-backed history after evidence or model-use rights change", async () => {
      const result = await run(async (tx) => {
        const fact = (await list(tx, project.owner, "facts")).find(
          (f) => data(f).key === "beta.access",
        )!;
        const evidence = await retrieve(tx, project.owner, {
          query: "beta.access",
          purpose: "public",
          language: "en",
          forModel: true,
          at: new Date(),
        });
        const c = await create(tx, project.owner, "content", {
          title: "Source-backed draft",
          body: String(data(fact).value),
          channel: X,
          status: "draft",
          evidenceId: evidence.id,
          claims: [{ text: data(fact).value, kind: "fact", factId: fact.id }],
        });
        return { fact, c };
      });
      const first = await run((tx) => marketingHistory(tx, project.owner, [X]));
      expect(first.items.find((i) => i.id === result.c.id)?.text).toBe(
        data(result.c).body,
      );
      await run((tx) =>
        update(tx, project.owner, result.fact, {
          ...data(result.fact),
          modelUse: false,
        }),
      );
      const history = await run((tx) =>
        marketingHistory(tx, project.owner, [X]),
      );
      expect(history.items.find((i) => i.id === result.c.id)).toMatchObject({
        title: "Prior content (text withheld)",
        text: "",
        claims: [],
        withheld: "evidence_or_model_use",
      });
    });
    it("preserves absent legacy limits and binds an explicit limit in the owner mandate hash", async () => {
      const h = assignmentRun(project);
      const a = await h.makeAssignment();
      expect(
        await run((tx) => reviewBacklog(tx, project.owner, a.id)),
      ).toMatchObject({ limit: null, blocked: false });
      const d = data(a);
      expect(assignmentHash({ ...d, pendingReviewLimit: 2 })).not.toBe(
        assignmentHash(d),
      );
      expect(assignmentHash({ ...d, pendingReviewLimit: undefined })).toBe(
        assignmentHash(d),
      );
    });
  },
);
