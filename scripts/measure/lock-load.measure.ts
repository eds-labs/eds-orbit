import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import {
  closeDatabase,
  lockObserver,
  scoped,
  type LockSample,
} from "../../packages/db/src/index.ts";

// Synthetic provider latency: model calls and embeddings take real time, so
// a transaction that spans one shows up as a long hold.
const MODEL_MS = 1500;
const EMBED_MS = 1000;
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, EMBED_MS));
    return {
      vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 10,
        outputTokens: 0,
        costMicros: 1,
      },
    };
  }),
  streamChat: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, MODEL_MS));
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "Status ok." };
        yield {
          type: "response.completed",
          response: {
            usage: { input_tokens: 100, output_tokens: 10 },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Status ok." }],
              },
            ],
          },
        };
      },
    };
  }),
}));
import { create } from "../../apps/api/src/shared.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../../apps/api/src/modules/chat.ts";
import { runChat } from "../../apps/api/src/modules/chat-runner.ts";
import { retrieveHybrid } from "../../apps/api/src/platform/knowledge/retrieval.ts";
import { sweepProject } from "../../apps/api/src/platform/jobs/scheduler.ts";
import { createPackageProject } from "../../apps/api/tests/support/package-project.ts";

const PHASE_MS = Number(process.env.LOCK_PHASE_MS ?? 15_000);
const POLLERS = Number(process.env.LOCK_POLLERS ?? 5);
// The load generator a transaction belongs to.
const workload = new AsyncLocalStorage<string>();

type Sample = LockSample & { site: string; phase: string; load: string };
const samples: Sample[] = [];
// End-to-end time of each generator call, including the connection pool.
const calls: Array<{ load: string; phase: string; ms: number }> = [];
let phase = "setup";

/** The first two application frames of the current stack: the call site. */
function site(stack = new Error().stack ?? "") {
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => line.match(/(apps\/api\/src\/[^:]+):(\d+)/)?.slice(1, 3))
    .filter((m): m is string[] => Boolean(m))
    .filter(([file]) => !file!.includes("platform/tenancy/scope.ts"));
  const own = stack.includes("lock-load.measure.ts") && !frames.length;
  return own
    ? "(call site not in the async stack)"
    : frames
        .slice(0, 2)
        .map(([file, line]) => `${file!.replace("apps/api/src/", "")}:${line}`)
        .join(" < ") || "unknown";
}

const pct = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!;
};
const round = (n: number) => Math.round(n * 10) / 10;

afterAll(async () => {
  lockObserver.observe = undefined;
  await closeDatabase();
});

it("measures lock wait and hold per load under a synthetic multi-user load", async () => {
  process.env.ORBIT_CONTENT_PACKAGES = "true";
  const project = await createPackageProject({ name: "Synthetic lock load" });
  const { owner, editor } = project;
  const worker = { ...owner, userId: "worker", role: "owner" as const };
  lockObserver.observe = (sample) =>
    samples.push({
      ...sample,
      site: site(),
      phase,
      load: workload.getStore() ?? "setup",
    });

  let stop = false;
  const loop = (load: string, everyMs: number, work: () => Promise<unknown>) =>
    workload.run(load, async () => {
      while (!stop) {
        const started = Date.now();
        try {
          await work();
          calls.push({ load, phase, ms: Date.now() - started });
        } catch {
          // Load generators keep going; failures show up as missing calls.
        }
        await new Promise((r) =>
          setTimeout(r, Math.max(0, everyMs - (Date.now() - started))),
        );
      }
    });
  // A chat run to poll, kept running by back-to-back runs.
  const thread = await createConversation(editor);
  const send = async () =>
    (
      await sendMessage(editor, thread.id, {
        text: "Status?",
        clientRequestId: randomUUID(),
      })
    ).runId;
  let runId = await send();
  const chats = loop("chat_run", 0, async () => {
    await runChat(editor, runId);
    runId = await send();
  });
  const writers = [0, 1].map(() =>
    loop("writer", 300, () =>
      scoped(owner.workspaceId, owner.projectId, (tx) =>
        create(tx, owner, "preferences", {
          key: `load.${randomUUID()}`,
          value: "synthetic",
          status: "confirmed",
        }),
      ),
    ),
  );
  const sweeps = loop("sweep", 2000, () =>
    scoped(owner.workspaceId, owner.projectId, (tx) =>
      sweepProject(tx, worker),
    ),
  );
  const searches = loop("search", 3000, () =>
    retrieveHybrid(owner, {
      query: "beta access",
      language: "en",
      purpose: "public",
      forModel: true,
      at: new Date(),
      topK: 6,
    }),
  );

  phase = "without_pollers";
  await new Promise((r) => setTimeout(r, PHASE_MS));
  phase = "with_pollers";
  const pollers = Array.from({ length: POLLERS }, () =>
    loop("stream_poll", 700, () => getRun(editor, runId)),
  );
  await new Promise((r) => setTimeout(r, PHASE_MS));
  stop = true;
  await Promise.all([chats, ...writers, sweeps, searches, ...pollers]);
  lockObserver.observe = undefined;
  await project.cleanup();
  delete process.env.ORBIT_CONTENT_PACKAGES;

  const measured = samples.filter((s) => s.phase !== "setup");
  const stats = (values: number[]) => ({
    p50: round(pct(values, 50)),
    p95: round(pct(values, 95)),
    max: round(values.length ? Math.max(...values) : 0),
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const p of ["without_pollers", "with_pollers"]) {
    const inPhase = measured.filter((s) => s.phase === p);
    const loads = [...new Set(inPhase.map((s) => s.load))].sort();
    for (const load of [...loads, "ALL"]) {
      const own = inPhase.filter((s) => load === "ALL" || s.load === load);
      const call = calls.filter(
        (c) => c.phase === p && (load === "ALL" || c.load === load),
      );
      const wait = stats(own.map((s) => s.waitMs));
      const hold = stats(own.map((s) => s.holdMs));
      const latency = stats(call.map((c) => c.ms));
      rows.push({
        phase: p,
        load,
        transactions: own.length,
        waitP50: wait.p50,
        waitP95: wait.p95,
        waitMax: wait.max,
        holdP50: hold.p50,
        holdP95: hold.p95,
        holdMax: hold.max,
        calls: call.length,
        callP95: latency.p95,
        callMax: latency.max,
      });
    }
  }
  // The longest holds with their call sites: the candidates for a long lock.
  const longest = [...measured]
    .sort((a, b) => b.holdMs - a.holdMs)
    .slice(0, 5)
    .map((s) => ({ load: s.load, site: s.site, holdMs: round(s.holdMs) }));
  console.table(rows);
  console.table(longest);
  if (process.env.LOCK_REPORT_FILE)
    writeFileSync(
      process.env.LOCK_REPORT_FILE,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          phaseMs: PHASE_MS,
          pollers: POLLERS,
          modelMs: MODEL_MS,
          embedMs: EMBED_MS,
          rows,
          longest,
        },
        null,
        2,
      ),
    );
  expect(measured.length).toBeGreaterThan(0);
});
