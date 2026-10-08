import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  createClient,
  scoped,
  type PrismaClient,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, update } from "../../api/src/shared.ts";
import { enqueue } from "../../api/src/modules/workflow.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../../api/src/modules/chat.ts";
import {
  ingest,
  setFact,
  revokeSource,
} from "../../../packages/knowledge/src/index.ts";
const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
describe.skipIf(!enabled)("Durable real Redis worker lifecycle", () => {
  let db: PrismaClient,
    auth: PrismaClient,
    scope: Scope,
    worker: ChildProcess | undefined,
    sourceId: string;
  let diagnostic = "";
  const queueNamespace = "orbit-acceptance-" + randomUUID().slice(0, 8);
  // A directory that does not exist yet: the worker must create it before writing health.
  const healthDir = join(tmpdir(), queueNamespace, "health");
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn, db);
  function start() {
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
          QUEUE_NAMESPACE: queueNamespace,
          PUBLISHER_INSTANCE_ID: queueNamespace,
          WORKER_HEALTH_FILE: join(healthDir, "worker.json"),
          // Leftover local projects must not delay or share this synthetic workspace queue.
          WORKER_WORKSPACE_ALLOWLIST: scope.workspaceId,
          EXECUTION_MODE: "test",
          ENABLE_EXTERNAL_WRITES: "false",
          LIVE_RAG_EVAL_PASSED: "false",
          OPENAI_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    worker.stderr!.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-3000);
    });
  }
  async function stop(crash = false) {
    if (!worker || worker.exitCode !== null) return;
    const p = worker;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        done();
      }, 3000);
      p.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      p.kill(crash ? "SIGKILL" : "SIGTERM");
    });
    worker = undefined;
  }
  async function waitFor<T>(check: () => Promise<T | false>, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await check();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Worker acceptance timeout " + diagnostic);
  }
  beforeAll(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic worker owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic worker acceptance",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await auth.project.create({
      data: {
        workspaceId: w.id,
        name: "Synthetic worker project",
        mode: "autopilot",
        timezone: "Europe/Berlin",
      },
    });
    scope = {
      workspaceId: w.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    const past = new Date(Date.now() - 86400000).toISOString(),
      future = new Date(Date.now() + 864000000).toISOString();
    await run(async (tx) => {
      const s = await create(tx, scope, "sources", {
        name: "Synthetic official guide",
        status: "active",
        generation: 1,
        publicUse: true,
        modelUse: false,
        authority: "official",
        maxAgeHours: 168,
        allowedOrigins: [],
        allowedPaths: ["/"],
      });
      sourceId = s.id;
      await create(tx, scope, "missions", {
        title: "Synthetic broken follow-up",
        status: "awaiting_followup",
        nextPlanAt: past,
        startAt: past,
        endAt: future,
        maxContents: 3,
        completedRuns: 1,
      });
      await ingest(tx, scope, {
        sourceId,
        externalId: "guide",
        title: "Price fixture",
        text: "Synthetic approved Orbit calendar.",
        mimeType: "text/plain",
        language: "en",
        expectedGeneration: 1,
      });
      await setFact(tx, scope, {
        key: "price",
        value: "19",
        valueType: "decimal",
        currency: "EUR",
        language: "en",
        sourceId,
        validFrom: past,
        validUntil: future,
        status: "verified",
        publicUse: true,
        modelUse: false,
      });
      await create(tx, scope, "policies", {
        mode: "autopilot",
        channels: ["test-social"],
        contentTypes: ["social"],
        allowedOrigins: [],
        startAt: past,
        endAt: future,
        maxPerDay: 2,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 0,
        monthlyBudgetMicros: 0,
        perRunBudgetMicros: 0,
        approvedPaidTests: false,
        active: true,
      });
      await create(tx, scope, "missions", {
        title: "Synthetic autonomous cycle",
        goal: "price",
        audience: "Synthetic",
        language: "en",
        channels: ["test-social"],
        startAt: past,
        endAt: future,
        maxContents: 1,
        targetAction: "Learn more.",
        sourceIds: [sourceId],
        contentType: "social",
        status: "ready",
      });
    });
  });
  afterAll(async () => {
    await stop();
    if (auth && scope) {
      await auth.workspace.delete({ where: { id: scope.workspaceId } });
      await auth.user.delete({ where: { id: scope.userId } });
    }
    await db?.$disconnect();
    await auth?.$disconnect();
    await closeDatabase();
    await rm(join(tmpdir(), queueNamespace), { recursive: true, force: true });
  });
  it("A10/A19/A26/B06: real worker plans, retrieves, drafts, reviews, publishes locally, survives restart, then applies revocation", async () => {
    start();
    const publication = await waitFor(() =>
      run(async (tx) => {
        const p = await tx.entity.findMany({
          where: { projectId: scope.projectId, kind: "publications" },
        });
        return p.find((x) => data(x).status === "published_test") ?? false;
      }),
    );
    expect(data(publication).test).toBe(true);
    expect(existsSync(join(healthDir, "worker.json"))).toBe(true);
    expect(
      await run((tx) =>
        tx.entity.count({
          where: {
            projectId: scope.projectId,
            kind: "exceptions",
            data: { path: ["code"], equals: "FOLLOWUP_CONTENT_MISSING" },
          },
        }),
      ),
    ).toBe(1);
    await stop(true);
    start();
    await waitFor(() =>
      run(async (tx) => {
        const jobs = await tx.entity.findMany({
          where: { projectId: scope.projectId, kind: "jobs" },
        });
        return jobs.length >= 2 &&
          jobs.every((j) => data(j).status === "succeeded")
          ? jobs
          : false;
      }),
    );
    const pubs = await run((tx) =>
      tx.entity.findMany({
        where: { projectId: scope.projectId, kind: "publications" },
      }),
    );
    expect(pubs).toHaveLength(1);
    expect(
      await run((tx) =>
        tx.budgetReservation.count({ where: { projectId: scope.projectId } }),
      ),
    ).toBe(0);
    await run((tx) => revokeSource(tx, scope, sourceId));
    expect(
      await run((tx) =>
        tx.knowledgeChunk.count({ where: { projectId: scope.projectId } }),
      ),
    ).toBe(0);
    expect(
      data(
        await run((tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: publication.id } }),
        ),
      ).status,
    ).toBe("published_test");
    // Later tests start their own worker with their own environment.
    await stop();
  }, 40000);
  it("runs a chat job only with the requesting user's current project access", async () => {
    const former = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic former member",
        email: randomUUID() + "@example.invalid",
      },
    });
    try {
      // The message was queued while the user still had access; it was removed since.
      const queuedBy: Scope = { ...scope, userId: former.id, role: "editor" };
      const thread = await createConversation(queuedBy);
      const sent = await sendMessage(queuedBy, thread.id, {
        text: "What is the project status?",
        clientRequestId: randomUUID(),
      });
      start();
      const finished = await waitFor(async () => {
        const chatRun = await getRun(queuedBy, sent.runId);
        return ["blocked", "failed", "succeeded"].includes(chatRun.status)
          ? chatRun
          : false;
      });
      expect(finished).toMatchObject({
        status: "blocked",
        errorCode: "ACTOR_MEMBERSHIP_REQUIRED",
      });
    } finally {
      await stop();
      await auth.user.delete({ where: { id: former.id } });
    }
  }, 40000);
  it("runs an approved image request in the image queue and stops before any provider call when images are not set up", async () => {
    // Recorded as decideActionRequest would; this project has no image configuration or profile.
    const request = await run((tx) =>
      create(tx, scope, "action_requests", {
        actionType: "image.generate",
        riskClass: "C2",
        approvalMode: "approval_required",
        requestedBy: { kind: "user", userId: scope.userId },
        payload: {
          name: "Synthetic artwork",
          prompt: "A calm geometric abstract artwork.",
          size: "1024x1024",
          quality: "low",
          background: "opaque",
          validUses: ["social"],
          model: "gpt-image-2.5-flare",
          maxCostMicros: 5000,
        },
        packageHash: "0".repeat(64),
        costCeilingMicros: 5000,
        status: "approved",
        decision: {
          userId: scope.userId,
          decision: "approve",
          decidedAt: new Date().toISOString(),
          channel: "web",
        },
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    const job = await run(async (tx) => {
      const queued = await enqueue(
        tx,
        scope,
        "image",
        request.id,
        "action:" + request.id,
      );
      return update(tx, scope, queued, { ...data(queued), maxAttempts: 1 });
    });
    start();
    try {
      const finished = await waitFor(() =>
        run(async (tx) => {
          const row = await tx.entity.findUniqueOrThrow({
            where: { id: job.id },
          });
          return data(row).status === "blocked_dependency" ? row : false;
        }),
      );
      expect(data(finished)).toMatchObject({
        attempts: 1,
        error: "MARKETING_PROFILE_REQUIRED",
      });
      const after = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: request.id } }),
      );
      expect(data(after).status).toBe("approved");
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { key: `${scope.projectId}:image:${request.id}` },
          }),
        ),
      ).toBe(0);
    } finally {
      await stop();
    }
  }, 40000);
  it("runs a specialist task in the agent queue with the registered analytics specialist and records its failure on the task", async () => {
    const { assignment, task, job } = await run(async (tx) => {
      const assignment = await create(tx, scope, "assignments", {
        name: "Synthetic agent assignment",
        contentType: "report",
        channels: [],
        topicFrame: "Weekly figures",
        // Long past: the sweep plans nothing for it.
        schedule: {
          rhythm: "once",
          weekdays: [],
          times: ["10:00"],
          date: "2026-01-01",
          leadMinutes: 60,
        },
        monthlyBudgetMicros: 1000,
        status: "active",
      });
      const taskRow = await create(tx, scope, "agent_tasks", {
        runId: "00000000-0000-4000-8000-000000000000",
        stepKey: "analytics",
        role: "analytics",
        assignmentId: assignment.id,
        assignmentVersion: 1,
        ceilingMicros: 1000,
        input: null,
        output: null,
        status: "queued",
        errorCode: null,
        costMicros: 0,
      });
      const runRow = await create(tx, scope, "assignment_runs", {
        assignmentId: assignment.id,
        assignmentVersion: 1,
        date: "2026-10-20",
        status: "running",
        slots: [],
        unavailable: [],
        steps: [
          {
            key: "analytics",
            role: "analytics",
            dependsOn: [],
            optionalDependsOn: [],
            taskId: taskRow.id,
            status: "queued",
            ceilingMicros: 1000,
          },
        ],
        costMicros: 0,
      });
      const task = await update(tx, scope, taskRow, {
        ...data(taskRow),
        runId: runRow.id,
      });
      const job = await enqueue(
        tx,
        scope,
        "agent",
        task.id,
        `agent:${task.id}`,
      );
      return { assignment, task, job };
    });
    // The runner refuses every task while Orbit Agents is off.
    process.env.ORBIT_AGENTS = "true";
    start();
    try {
      // The worker registered the analytics specialist: it stops before any paid call (no verified model in this project), the job completes.
      const finished = await waitFor(() =>
        run(async (tx) => {
          const row = await tx.entity.findUniqueOrThrow({
            where: { id: job.id },
          });
          return data(row).status === "succeeded" ? row : false;
        }),
      );
      expect(data(finished).attempts).toBe(1);
      const after = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: task.id } }),
      );
      expect(data(after)).toMatchObject({
        status: "failed",
        errorCode: "MODEL_CAPABILITY_NOT_VERIFIED",
        input: { assignment: { id: assignment.id } },
      });
      expect(
        await run((tx) =>
          tx.budgetReservation.count({
            where: { key: { startsWith: `${scope.projectId}:agent:` } },
          }),
        ),
      ).toBe(0);
    } finally {
      delete process.env.ORBIT_AGENTS;
      await stop();
    }
  }, 40000);
});
