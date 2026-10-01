import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { DomainError } from "../src/shared.ts";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import {
  errorCode,
  finishRun,
  hashText,
  recordSpan,
  startRun,
} from "../src/modules/telemetry.ts";

describe("Telemetry helpers", () => {
  it("hashes text as sha256 hex", () => {
    expect(hashText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("maps errors to bounded codes without provider text", () => {
    expect(errorCode(new DomainError("BUDGET_EXCEEDED", 402))).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(errorCode(new Error("USAGE_UNKNOWN"))).toBe("USAGE_UNKNOWN");
    expect(errorCode(new Error("Provider said: secret prompt text"))).toBe(
      "UNEXPECTED",
    );
    expect(errorCode("USAGE_UNKNOWN")).toBe("UNEXPECTED");
    expect(errorCode(undefined)).toBe("UNEXPECTED");
  });
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Failure-tolerant agent telemetry", () => {
  let a: Scope, b: Scope, userId: string, workspaceId: string;
  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic telemetry",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    userId = user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Telemetry",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const [pa, pb] = await Promise.all(
      ["Telemetry A", "Telemetry B"].map((name) =>
        authDb.project.create({ data: { workspaceId, name } }),
      ),
    );
    a = { workspaceId, projectId: pa.id, userId, role: "owner" };
    b = { workspaceId, projectId: pb.id, userId, role: "owner" };
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.delete({ where: { id: userId } });
    await closeDatabase();
  });
  const span = (overrides = {}) => ({
    type: "model_call" as const,
    name: "chat.step",
    model: "synthetic-model",
    status: "succeeded" as const,
    startedAt: new Date(),
    durationMs: 12,
    ...overrides,
  });
  const read = (scope: Scope) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => ({
      runs: await tx.agentRun.findMany(),
      spans: await tx.agentSpan.findMany(),
    }));

  it("records a run, its span with usage and cost, and the final status", async () => {
    const runId = await startRun(a, {
      kind: "chat",
      agentName: "orbit-chat",
      taskClass: "standard",
      subjectType: "chat_run",
      subjectId: randomUUID(),
    });
    expect(runId).toEqual(expect.any(String));
    await recordSpan(
      a,
      runId,
      span({
        usage: {
          inputTokens: 100,
          cachedTokens: 40,
          cacheWriteTokens: 5,
          outputTokens: 30,
          reasoningTokens: 7,
        },
        costMicros: 1234,
        providerResponseId: "resp_synthetic",
        inputHash: hashText("in"),
      }),
    );
    await finishRun(a, runId, "succeeded");
    const { runs, spans } = await read(a);
    const run = runs.find((r) => r.id === runId)!;
    expect(run).toEqual(
      expect.objectContaining({
        status: "succeeded",
        kind: "chat",
        agentName: "orbit-chat",
      }),
    );
    expect(run.endedAt).toBeInstanceOf(Date);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    const stored = spans.filter((s) => s.runId === runId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        type: "model_call",
        model: "synthetic-model",
        attempt: 1,
        inputTokens: 100,
        cachedTokens: 40,
        cacheWriteTokens: 5,
        outputTokens: 30,
        reasoningTokens: 7,
        costMicros: 1234n,
        providerResponseId: "resp_synthetic",
      }),
    );
  });

  it("keeps rows invisible to other projects", async () => {
    const runId = await startRun(a, {
      kind: "retrieval",
      agentName: "knowledge",
      taskClass: "fast",
    });
    await recordSpan(a, runId, span({ type: "embedding", name: "embed" }));
    expect((await read(a)).runs.some((r) => r.id === runId)).toBe(true);
    const other = await read(b);
    expect(other.runs).toHaveLength(0);
    expect(other.spans).toHaveLength(0);
  });

  it("never throws and logs only the error class name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = (await read(a)).spans.length;
    await expect(recordSpan(a, randomUUID(), span())).resolves.toBeUndefined();
    expect((await read(a)).spans).toHaveLength(before);
    await expect(finishRun(a, randomUUID(), "failed", "X")).resolves.toBe(
      undefined,
    );
    expect(
      await startRun(
        { ...a, projectId: "not-a-uuid" },
        { kind: "chat", agentName: "x", taskClass: "fast" },
      ),
    ).toBeNull();
    await expect(recordSpan(a, null, span())).resolves.toBeUndefined();
    await expect(finishRun(a, null, "failed")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "Orbit telemetry write failed",
      expect.any(String),
    );
    for (const call of log.mock.calls) expect(call).toHaveLength(2);
    log.mockRestore();
  });

  it("truncates names and error codes to 120 characters", async () => {
    const runId = await startRun(a, {
      kind: "generation",
      agentName: "orbit-generation",
      taskClass: "quality",
    });
    await recordSpan(
      a,
      runId,
      span({
        name: "x".repeat(500),
        status: "failed",
        errorCode: "E".repeat(500),
      }),
    );
    const stored = (await read(a)).spans.find((s) => s.runId === runId)!;
    expect(stored.name).toHaveLength(120);
    expect(stored.errorCode).toHaveLength(120);
  });
});

describe.skipIf(!enabled)("Agent run and cost read endpoints", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string, projectId: string, otherId: string;
  let ownerId: string, cookie: string;
  const origin = process.env.APP_ORIGIN!;
  const get = (url: string) =>
    app.inject({
      url: `/api/projects/${projectId}${url}`,
      headers: { cookie },
    });
  const runIds: string[] = [];
  const base = Date.parse("2026-03-10T12:00:00.000Z");

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const o = await auth.api.signUpEmail({
      body: { email, name: "Synthetic usage owner", password },
    });
    ownerId = o.user.id;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    const cookies = login.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
    const w = await authDb.workspace.create({
      data: {
        name: "Usage endpoints",
        members: { create: { userId: ownerId, role: "owner" } },
      },
    });
    workspaceId = w.id;
    projectId = (
      await authDb.project.create({ data: { workspaceId, name: "Usage" } })
    ).id;
    otherId = (
      await authDb.project.create({
        data: { workspaceId, name: "Usage other" },
      })
    ).id;
    // 120 runs; every 3 share a timestamp to exercise the id tie-break.
    await scoped(workspaceId, projectId, async (tx) => {
      const rows = Array.from({ length: 120 }, (_, i) => {
        const id = randomUUID();
        runIds.push(id);
        return {
          id,
          workspaceId,
          projectId,
          kind: i % 4 === 0 ? "generation" : "chat",
          agentName: "synthetic",
          taskClass: "standard",
          status: "succeeded",
          startedAt: new Date(base - Math.floor(i / 3) * 1000),
        };
      });
      await tx.agentRun.createMany({ data: rows });
    });
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.delete({ where: { id: ownerId } });
    await app?.close();
    await closeDatabase();
  });

  it("pages runs newest first, 50 at a time, without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const r = await get(`/agent-runs${cursor ? `?cursor=${cursor}` : ""}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      sizes.push(body.runs.length);
      seen.push(...body.runs.map((x: { id: string }) => x.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    const expected = await scoped(workspaceId, projectId, (tx) =>
      tx.agentRun.findMany({
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(seen).toEqual(expected.map((x) => x.id));
  });

  it("does not offer a next page when exactly one page remains", async () => {
    const all = await scoped(workspaceId, projectId, (tx) =>
      tx.agentRun.findMany({
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    );
    const r = await get(`/agent-runs?cursor=${all[69]!.id}`);
    expect(r.json().runs).toHaveLength(50);
    expect(r.json().nextCursor).toBeNull();
  });

  it("filters by kind and rejects unknown kinds and bad cursors", async () => {
    const r = await get("/agent-runs?kind=generation");
    expect(r.statusCode).toBe(200);
    expect(r.json().runs).toHaveLength(30);
    expect(
      r.json().runs.every((x: { kind: string }) => x.kind === "generation"),
    ).toBe(true);
    for (const q of [
      "kind=bogus",
      "cursor=not-a-uuid",
      `cursor=${randomUUID()}`,
    ]) {
      const bad = await get(`/agent-runs?${q}`);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toEqual(expect.any(String));
    }
  });

  it("never lists another project's runs and rejects a foreign-project cursor", async () => {
    const foreign: string[] = Array.from({ length: 3 }, () => randomUUID());
    await scoped(workspaceId, otherId, (tx) =>
      tx.agentRun.createMany({
        data: foreign.map((id, i) => ({
          id,
          workspaceId,
          projectId: otherId,
          kind: "chat",
          agentName: "foreign",
          taskClass: "standard",
          status: "succeeded",
          // Newer than every seeded run, so a leak would show up first.
          startedAt: new Date(base + 3_600_000 + i * 1000),
        })),
      }),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get(`/agent-runs${cursor ? `?cursor=${cursor}` : ""}`);
      expect(r.statusCode).toBe(200);
      seen.push(...r.json().runs.map((x: { id: string }) => x.id));
      cursor = r.json().nextCursor;
    } while (cursor);
    expect(seen.filter((id) => foreign.includes(id))).toEqual([]);
    const bad = await get(`/agent-runs?cursor=${foreign[0]}`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_CURSOR");
    // The same listing from the other project's own route sees only its runs.
    const own = await app.inject({
      url: `/api/projects/${otherId}/agent-runs`,
      headers: { cookie },
    });
    expect(own.json().runs.map((x: { id: string }) => x.id).sort()).toEqual(
      [...foreign].sort(),
    );
  });

  it("aggregates span counts, tokens and cost per run", async () => {
    const runId = randomUUID();
    const s = (type: string, n: number, cost: number | null) => ({
      id: randomUUID(),
      workspaceId,
      projectId,
      runId,
      type,
      name: "n",
      status: "succeeded",
      startedAt: new Date(),
      durationMs: 1,
      inputTokens: n * 10,
      cachedTokens: n,
      cacheWriteTokens: n * 2,
      outputTokens: n * 3,
      reasoningTokens: n * 4,
      costMicros: cost === null ? null : BigInt(cost),
    });
    await scoped(workspaceId, projectId, async (tx) => {
      await tx.agentRun.create({
        data: {
          id: runId,
          workspaceId,
          projectId,
          kind: "image",
          agentName: "agg",
          taskClass: "fast",
          status: "failed",
          errorCode: "USAGE_UNKNOWN",
          startedAt: new Date(base + 60_000),
          durationMs: 42,
        },
      });
      await tx.agentSpan.createMany({
        data: [
          s("model_call", 1, 100),
          s("model_call", 2, 250),
          s("tool_call", 3, null),
          s("embedding", 4, 5_000_000_000),
        ],
      });
    });
    const run = (await get("/agent-runs")).json().runs[0];
    expect(run).toEqual({
      id: runId,
      kind: "image",
      agentName: "agg",
      taskClass: "fast",
      subjectType: null,
      subjectId: null,
      missionId: null,
      status: "failed",
      errorCode: "USAGE_UNKNOWN",
      startedAt: new Date(base + 60_000).toISOString(),
      durationMs: 42,
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 100,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      outputTokens: 30,
      reasoningTokens: 40,
      costMicros: "5000000350",
    });
    const empty = (await get("/agent-runs?kind=generation")).json().runs[0];
    expect(empty).toEqual(
      expect.objectContaining({
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        costMicros: "0",
      }),
    );
  });

  describe("ai-cost", () => {
    const reservation = (
      scopeProject: string,
      state: string,
      amount: number,
      extra: Record<string, unknown> = {},
    ) => ({
      workspaceId,
      projectId: scopeProject,
      key: randomUUID(),
      category: "llm",
      state,
      amountMicros: BigInt(amount),
      ...extra,
    });
    const window = "from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z";
    beforeAll(async () => {
      const at = (d: string) => ({ createdAt: new Date(d) });
      await scoped(workspaceId, projectId, async (tx) => {
        await tx.budgetReservation.createMany({
          data: [
            reservation(projectId, "settled", 500, {
              model: "m-a",
              taskClass: "fast",
              settledMicros: 420n,
              ...at("2026-03-05T23:59:59.000Z"),
            }),
            reservation(projectId, "settled", 300, {
              model: "m-a",
              taskClass: "fast",
              settledMicros: 280n,
              ...at("2026-03-06T00:00:01.000Z"),
            }),
            reservation(projectId, "in_flight", 40, {
              model: "m-a",
              taskClass: "fast",
              ...at("2026-03-06T10:00:00.000Z"),
            }),
            reservation(projectId, "reserved", 10, {
              model: "m-a",
              taskClass: "fast",
              ...at("2026-03-06T11:00:00.000Z"),
            }),
            reservation(projectId, "unknown", 70, {
              model: "m-b",
              taskClass: "quality",
              category: "image",
              ...at("2026-03-06T12:00:00.000Z"),
            }),
            reservation(projectId, "released", 9999, {
              model: "m-b",
              ...at("2026-03-06T13:00:00.000Z"),
            }),
            reservation(projectId, "settled", 5, {
              settledMicros: 5n,
              ...at("2026-03-07T00:00:00.000Z"),
            }),
            reservation(projectId, "settled", 1_000, {
              model: "outside",
              settledMicros: 1_000n,
              ...at("2026-02-20T00:00:00.000Z"),
            }),
          ],
        });
      });
      await scoped(workspaceId, otherId, (tx) =>
        tx.budgetReservation.create({
          data: reservation(otherId, "settled", 77, {
            model: "m-a",
            settledMicros: 77n,
            ...at("2026-03-06T00:00:00.000Z"),
          }),
        }),
      );
    });

    it("groups by model, separating settled, reserved and unknown spend", async () => {
      const r = await get(`/ai-cost?groupBy=model&${window}`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-31T00:00:00.000Z",
        groupBy: "model",
        rows: [
          {
            key: "m-a",
            reservedMicros: "50",
            settledMicros: "700",
            unknownMicros: "0",
            count: 4,
          },
          {
            key: "m-b",
            reservedMicros: "0",
            settledMicros: "0",
            unknownMicros: "70",
            count: 1,
          },
          {
            key: null,
            reservedMicros: "0",
            settledMicros: "5",
            unknownMicros: "0",
            count: 1,
          },
        ],
      });
    });

    it("groups by category, taskClass and mission", async () => {
      const cat = (await get(`/ai-cost?groupBy=category&${window}`)).json();
      expect(cat.rows.map((x: { key: string }) => x.key)).toEqual([
        "image",
        "llm",
      ]);
      const tc = (await get(`/ai-cost?groupBy=taskClass&${window}`)).json();
      expect(tc.rows).toEqual([
        expect.objectContaining({ key: "fast", count: 4 }),
        expect.objectContaining({ key: "quality", count: 1 }),
        expect.objectContaining({ key: null, count: 1 }),
      ]);
      const mission = (await get(`/ai-cost?groupBy=mission&${window}`)).json();
      expect(mission.rows).toEqual([
        expect.objectContaining({ key: null, count: 6, settledMicros: "705" }),
      ]);
    });

    it("groups by UTC day", async () => {
      const r = (await get(`/ai-cost?groupBy=day&${window}`)).json();
      expect(r.rows).toEqual([
        {
          key: "2026-03-05",
          reservedMicros: "0",
          settledMicros: "420",
          unknownMicros: "0",
          count: 1,
        },
        {
          key: "2026-03-06",
          reservedMicros: "50",
          settledMicros: "280",
          unknownMicros: "70",
          count: 4,
        },
        {
          key: "2026-03-07",
          reservedMicros: "0",
          settledMicros: "5",
          unknownMicros: "0",
          count: 1,
        },
      ]);
    });

    it("defaults to the current UTC month grouped by day", async () => {
      await scoped(workspaceId, projectId, (tx) =>
        tx.budgetReservation.create({
          data: reservation(projectId, "settled", 3, { settledMicros: 3n }),
        }),
      );
      const r = (await get("/ai-cost")).json();
      const now = new Date();
      expect(r.groupBy).toBe("day");
      expect(r.from).toBe(
        new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        ).toISOString(),
      );
      expect(r.rows).toEqual([
        expect.objectContaining({
          key: now.toISOString().slice(0, 10),
          settledMicros: "3",
        }),
      ]);
    });

    it("rejects invalid input and ranges over 93 days", async () => {
      for (const q of [
        "groupBy=bogus",
        "from=yesterday",
        "to=2026-13-40T00:00:00Z",
        "from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z",
        "from=2026-03-01T00:00:00Z&to=2026-03-01T00:00:00Z",
      ]) {
        const r = await get(`/ai-cost?${q}`);
        expect(r.statusCode, q).toBe(400);
      }
      const big = await get(
        "/ai-cost?from=2026-01-01T00:00:00Z&to=2026-04-05T00:00:00Z",
      );
      expect(big.statusCode).toBe(400);
      expect(big.json().error.code).toBe("RANGE_TOO_LARGE");
      const ok = await get(
        "/ai-cost?from=2026-01-01T00:00:00Z&to=2026-04-04T00:00:00Z",
      );
      expect(ok.statusCode).toBe(200);
    });

    it("does not leak other projects", async () => {
      const r = (await get(`/ai-cost?groupBy=model&${window}`)).json();
      const a = r.rows.find((x: { key: string }) => x.key === "m-a");
      expect(a.settledMicros).toBe("700");
    });
  });
});
