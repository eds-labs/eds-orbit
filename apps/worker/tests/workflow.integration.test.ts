import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createClient,
  scoped,
  type PrismaClient,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data } from "../../api/src/shared.ts";
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
          WORKER_HEALTH_FILE: resolve(".runtime/" + queueNamespace + ".json"),
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
        targetAction: "read",
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
  }, 40000);
});
