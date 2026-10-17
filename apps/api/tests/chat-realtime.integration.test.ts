import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import {
  afterCommit,
  authDb,
  closeDatabase,
  lockObserver,
  scoped,
} from "../../../packages/db/src/index.ts";
import {
  chatScoped,
  createConversation,
  runChanged,
  sendMessage,
  stopChatRunForPause,
} from "../src/modules/chat.ts";
import { data, entity } from "../src/shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { openStream, p95 } from "./support/sse-client.ts";

/**
 * Orbit Chat's run stream on the real-time fan-out (WP4.3 Part B): with
 * ORBIT_REALTIME on, the SSE route waits on Redis instead of reading the run
 * every 700 ms under the project lock. Needs the database and Redis.
 */
const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)("Chat run stream on the real-time fan-out", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let base: string;
  let cookie: string;
  let owner: Scope;
  let userId: string;
  const origin = process.env.APP_ORIGIN!;
  let transactions = 0;

  beforeAll(async () => {
    process.env.ORBIT_REALTIME = "true";
    lockObserver.observe = () => void transactions++;
    app = await buildServer();
    const auth = makeAuth(),
      password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const user = await auth.api.signUpEmail({
      body: { email, name: "Realtime owner", password },
    });
    userId = user.user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Realtime chat",
        members: { create: { userId, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Realtime project" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const cookies = response.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    lockObserver.observe = undefined;
    delete process.env.ORBIT_REALTIME;
    if (owner)
      await authDb.workspace.delete({ where: { id: owner.workspaceId } });
    if (userId) await authDb.user.delete({ where: { id: userId } });
    await app?.close();
    await closeDatabase();
  });

  async function newRun() {
    const thread = await createConversation(owner);
    const sent = await sendMessage(owner, thread.id, {
      text: "Wie ist der Projektstand?",
      clientRequestId: randomUUID(),
    });
    return sent;
  }
  /** One step of the runner: commit, then publish (chat-runner's snapshot()). */
  async function step(runId: string, change: Record<string, unknown>) {
    const saved = await chatScoped(owner, (tx) =>
      tx.chatRun.update({
        where: { id: runId },
        data: { ...change, sequence: { increment: 1 } },
      }),
    );
    const at = performance.now();
    runChanged(owner, runId, saved.sequence);
    return { sequence: saved.sequence, at };
  }
  const events = (runId: string, headers: Record<string, string> = {}) =>
    openStream(
      `${base}/api/projects/${owner.projectId}/chat/runs/${runId}/events`,
      { cookie, ...headers },
    );

  it("streams run snapshots under 1 s p95 and reads nothing while idle", async () => {
    const { runId } = await newRun();
    const clients = Array.from({ length: 10 }, () => events(runId));
    for (const client of clients)
      expect(await client.until((e) => e.length === 1)).toBe(true);
    expect(clients[0]!.status).toBe(200);
    expect(clients[0]!.events[0]).toMatchObject({
      event: "snapshot",
      data: { id: runId, status: "queued" },
    });
    // Idle: no transaction at all, where polling made ~1.4 per second and stream.
    const idleFrom = transactions;
    await sleep(2000);
    expect(transactions - idleFrom).toBe(0);

    const steps = [await step(runId, { status: "running" })];
    for (let i = 1; i <= 30; i++) {
      await sleep(60);
      steps.push(await step(runId, { partialText: "Antwort ".repeat(i) }));
    }
    steps.push(await step(runId, { status: "succeeded" }));
    const final = steps.at(-1)!.sequence;
    for (const client of clients) {
      await client.ended;
      expect(client.events.at(-1)).toMatchObject({
        id: final,
        data: { status: "succeeded" },
      });
    }
    const sent = new Map(steps.map((s) => [s.sequence, s.at]));
    const latencies = clients.flatMap((client) =>
      client.events
        .filter((e) => sent.has(e.id!))
        .map((e) => e.at - sent.get(e.id!)!),
    );
    // Snapshots may coalesce, but nearly every step arrives on its own.
    expect(latencies.length).toBeGreaterThan(clients.length * 25);
    if (process.env.REALTIME_REPORT)
      appendFileSync(
        process.env.REALTIME_REPORT,
        `chat SSE p95 ${p95(latencies).toFixed(1)} ms over ${latencies.length} deliveries` +
          "\n",
      );
    expect(p95(latencies)).toBeLessThan(1000);
  });

  it("resumes after Last-Event-ID with the newer snapshot only", async () => {
    const { runId } = await newRun();
    const first = events(runId);
    await first.until((e) => e.length === 1);
    const seen = first.events[0]!.id!;
    await first.close();
    // Changes while the client was away (the proxy's 45 s cut).
    await step(runId, { status: "running" });
    const latest = await step(runId, { partialText: "Teil" });
    const resumed = events(runId, { "last-event-id": String(seen) });
    expect(await resumed.until((e) => e.length === 1)).toBe(true);
    expect(resumed.events[0]).toMatchObject({
      id: latest.sequence,
      data: { partialText: "Teil" },
    });
    // Up to date: a reconnect with the newest cursor sends nothing until a change.
    const current = events(runId, {
      "last-event-id": String(latest.sequence),
    });
    await sleep(500);
    expect(current.events).toHaveLength(0);
    const done = await step(runId, { status: "failed", errorCode: "X_FAILED" });
    await current.ended;
    expect(current.events.map((e) => e.id)).toEqual([done.sequence]);
    await resumed.ended;
  });

  it("ends a stream when the paused worker stops the run, after its commit", async () => {
    const { runId, jobId } = await newRun();
    const client = events(runId);
    await client.until((e) => e.length === 1);
    await scoped(owner.workspaceId, owner.projectId, async (tx) =>
      stopChatRunForPause(
        tx,
        data(await entity(tx, owner, "jobs", jobId!)),
        owner,
      ),
    );
    await client.ended;
    expect(client.events.at(-1)).toMatchObject({
      data: { status: "blocked", errorCode: "PROJECT_PAUSED" },
    });
  });

  it("does not leak another user's run", async () => {
    const other = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Other",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    try {
      // The other member's own run; the owner's session asks for it.
      const otherScope = {
        ...owner,
        userId: other.id,
        role: "editor" as const,
      };
      const thread = await createConversation(otherScope);
      const { runId } = await sendMessage(otherScope, thread.id, {
        text: "Privat",
        clientRequestId: randomUUID(),
      });
      const client = events(runId);
      await client.ended;
      expect(client.status).toBe(404);
      expect(client.events).toHaveLength(0);
    } finally {
      await authDb.user.delete({ where: { id: other.id } });
    }
  });

  it("keeps the polling route while ORBIT_REALTIME is off", async () => {
    process.env.ORBIT_REALTIME = "false";
    try {
      const { runId } = await newRun();
      const client = events(runId);
      expect(await client.until((e) => e.length === 1)).toBe(true);
      // The old route polls: transactions keep coming without any change.
      const from = transactions;
      await sleep(1600);
      expect(transactions - from).toBeGreaterThanOrEqual(2);
      await client.close();
    } finally {
      process.env.ORBIT_REALTIME = "true";
    }
  });
});

describe.skipIf(!enabled)("afterCommit", () => {
  afterAll(async () => closeDatabase());
  it("runs after the commit and never after a rollback", async () => {
    const workspace = await authDb.workspace.create({
      data: { name: "afterCommit" },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "afterCommit" },
    });
    try {
      const calls: string[] = [];
      await scoped(workspace.id, project.id, async (tx) => {
        afterCommit(tx, () => calls.push("committed"));
        afterCommit(tx, () => {
          throw new Error("ignored");
        });
        afterCommit(tx, () => calls.push("second"));
        calls.push("inside");
      });
      expect(calls).toEqual(["inside", "committed", "second"]);
      await expect(
        scoped(workspace.id, project.id, async (tx) => {
          afterCommit(tx, () => calls.push("rolled back"));
          throw new Error("ROLLBACK");
        }),
      ).rejects.toThrow("ROLLBACK");
      expect(calls).not.toContain("rolled back");
      // Outside scoped() nothing runs, and the caller does not fail.
      await authDb.$transaction(async (tx) => {
        expect(afterCommit(tx, () => calls.push("unscoped"))).toBe(false);
      });
      expect(calls).not.toContain("unscoped");
    } finally {
      await authDb.workspace.delete({ where: { id: workspace.id } });
    }
  });
});
