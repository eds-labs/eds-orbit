import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  LARGEST_LEASE_MS,
  STALE_AFTER_MS,
  listReservations,
  nextActionOf,
  reservationBreakdown,
  reservationModule,
  reservationStatus,
} from "../src/platform/ai/reservation-diagnosis.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const MINUTE = 60_000;
const SECRET_RESPONSE_ID = "resp_synthetic_never_shown_7f3a";

/**
 * The cost diagnosis (plan 2026-11-10, WP2 C): every reservation of every
 * month, its derived status (a live call, a stale one, an unclear outcome)
 * and the next step, read inside the project's own transaction. Nothing
 * here changes a reservation.
 */
describe("reservation status rules", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);

  it("derives the stale threshold from the longest job lease", () => {
    const leases = [...registeredJobs().values()].map((j) => j.leaseMs ?? 120_000);
    expect(Math.max(...leases)).toBeLessThanOrEqual(LARGEST_LEASE_MS);
    expect(STALE_AFTER_MS).toBe(15 * MINUTE);
  });

  it("keeps a live call, marks a lost or ended one stale and passes the stored outcome through", () => {
    expect(reservationStatus({ state: "in_flight", createdAt: at(2) }, { status: "running" }, now)).toBe("in_flight");
    expect(reservationStatus({ state: "reserved", createdAt: at(2) }, null, now)).toBe("reserved");
    expect(reservationStatus({ state: "in_flight", createdAt: at(2) }, { status: "failed" }, now)).toBe("stale");
    expect(reservationStatus({ state: "in_flight", createdAt: at(16) }, { status: "running" }, now)).toBe("stale");
    expect(reservationStatus({ state: "reserved", createdAt: at(16) }, null, now)).toBe("stale");
    for (const state of ["settled", "unknown", "released"] as const)
      expect(reservationStatus({ state, createdAt: at(600) }, { status: "failed" }, now)).toBe(state);
    expect(nextActionOf("in_flight")).toBe("wait");
    expect(nextActionOf("stale")).toBe("check_run");
    expect(nextActionOf("unknown")).toBe("check_billing_then_settle");
    expect(nextActionOf("settled")).toBe("none");
  });

  it("names the module from category, task class or run kind", () => {
    expect(reservationModule({ category: "support_text", taskClass: "support_triage" })).toBe("support");
    expect(reservationModule({ category: "custom", taskClass: "support_draft" })).toBe("support");
    expect(reservationModule({ category: "image_generation", taskClass: null })).toBe("marketing");
    expect(reservationModule({ category: "chat_text", taskClass: "chat_operator" })).toBe("assistant");
    expect(reservationModule({ category: "custom", taskClass: null, runKind: "agent" })).toBe("agents");
    expect(reservationModule({ category: "custom", taskClass: null })).toBe("platform");
  });
});

describe.skipIf(!enabled)("GET /api/projects/:id/ai-reservations", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let a: Scope;
  let b: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ids: Record<string, string> = {};
  const run = <T>(s: Scope, fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn);

  async function reservation(
    s: Scope,
    name: string,
    state: string,
    createdAt: Date,
    extra: Record<string, unknown> = {},
  ) {
    const row = await run(s, (tx) =>
      tx.budgetReservation.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          key: `${s.projectId}:${randomUUID()}`,
          category: "support_text",
          taskClass: "support_triage",
          model: "claude-haiku-5-5",
          amountMicros: 100_000n,
          settledMicros: state === "settled" ? 40_000n : null,
          state,
          createdAt,
          ...extra,
        },
      }),
    );
    ids[name] = row.id;
    return row;
  }
  async function agentRun(s: Scope, status: string) {
    const id = randomUUID();
    await run(s, (tx) =>
      tx.agentRun.create({
        data: {
          id,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          kind: "support",
          agentName: "support",
          taskClass: "support_triage",
          status,
          ...(status === "running" ? {} : { endedAt: new Date() }),
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic diagnosis owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic diagnosis",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const [one, two] = await Promise.all(
      ["Diagnosis A", "Diagnosis B"].map((name) =>
        authDb.project.create({ data: { workspaceId: workspace.id, name } }),
      ),
    );
    a = { workspaceId: workspace.id, projectId: one!.id, userId: created.user.id, role: "owner" };
    b = { ...a, projectId: two!.id };
    const now = Date.now();
    const live = await agentRun(a, "running");
    const ended = await agentRun(a, "failed");
    const done = await agentRun(a, "succeeded");
    await reservation(a, "live", "in_flight", new Date(now - 2 * MINUTE), { agentRunId: live });
    await reservation(a, "endedRun", "in_flight", new Date(now - 2 * MINUTE), { agentRunId: ended });
    await reservation(a, "lost", "reserved", new Date(now - 20 * MINUTE));
    await reservation(a, "unclear", "unknown", new Date(now - 3 * MINUTE));
    await reservation(a, "settled", "settled", new Date(now - 4 * MINUTE), { agentRunId: done });
    await reservation(a, "released", "released", new Date(now - 5 * MINUTE));
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 86_400_000);
    await reservation(a, "oldUnclear", "unknown", lastMonth);
    await reservation(b, "foreign", "unknown", new Date(now - MINUTE));
    await run(a, (tx) =>
      tx.agentSpan.create({
        data: {
          id: randomUUID(),
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          runId: done,
          type: "model_call",
          name: "messages.create",
          status: "succeeded",
          startedAt: new Date(),
          durationMs: 10,
          budgetReservationId: ids.settled!,
          providerResponseId: SECRET_RESPONSE_ID,
        },
      }),
    );
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: "198.18.9.3" },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lists every month's reservations with derived status, run and next step", async () => {
    const page = await listReservations(a, { state: "all" });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(ids.live!)).toMatchObject({
      status: "in_flight",
      nextAction: "wait",
      module: "support",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      run: { kind: "support", status: "running", errorCode: null },
      reservedMicros: "100000",
      settledMicros: null,
      providerConfirmed: false,
    });
    expect(byId.get(ids.endedRun!)).toMatchObject({ status: "stale", nextAction: "check_run" });
    expect(byId.get(ids.lost!)).toMatchObject({ status: "stale", run: null });
    expect(byId.get(ids.unclear!)).toMatchObject({
      status: "unknown",
      nextAction: "check_billing_then_settle",
    });
    expect(byId.get(ids.settled!)).toMatchObject({
      status: "settled",
      settledMicros: "40000",
      providerConfirmed: true,
    });
    expect(byId.get(ids.released!)).toMatchObject({ status: "released", nextAction: "none" });
    expect(byId.get(ids.oldUnclear!)).toMatchObject({ status: "unknown" });
    expect(page.items).toHaveLength(7);
    expect(page.staleAfterMs).toBe(STALE_AFTER_MS);
    expect(page.summary).toMatchObject({
      month: {
        settledMicros: 40_000,
        inFlightMicros: 100_000,
        staleMicros: 200_000,
        unknownMicros: 100_000,
        reservedMicros: 400_000,
      },
      unknownAllMonths: { micros: 200_000, count: 2 },
    });
    // The open filter leaves out settled and released rows.
    const open = await listReservations(a, { state: "open" });
    expect(open.items.map((i) => i.status).sort()).toEqual(
      ["in_flight", "stale", "stale", "unknown", "unknown"],
    );
    expect((await listReservations(a, { state: "unknown" })).items).toHaveLength(2);
  });

  it("never shows another project's reservation, even with its id as cursor", async () => {
    const page = await listReservations(a, { state: "all" });
    expect(page.items.map((i) => i.id)).not.toContain(ids.foreign);
    await expect(
      listReservations(a, { state: "all", cursor: ids.foreign }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const other = await listReservations(b, { state: "all" });
    expect(other.items.map((i) => i.id)).toEqual([ids.foreign]);
    // Row-level security as well: the raw table in A's transaction.
    expect(
      await run(a, (tx) => tx.budgetReservation.count({ where: { id: ids.foreign } })),
    ).toBe(0);
  });

  it("pages with a cursor and keeps the dashboard to this month, split", async () => {
    await run(a, (tx) =>
      tx.budgetReservation.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          key: `${a.projectId}:page-${i}-${randomUUID()}`,
          category: "text",
          amountMicros: 1_000n,
          settledMicros: 1_000n,
          state: "settled",
          createdAt: new Date(Date.now() - 30 * MINUTE - i * 1000),
        })),
      }),
    );
    const first = await listReservations(a, { state: "all" });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await listReservations(a, { state: "all", cursor: first.nextCursor! });
    expect(second.summary).toBeNull();
    expect(second.items.length).toBe(7);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(57);
    const month = await run(a, (tx) => reservationBreakdown(tx, a));
    expect(month).toMatchObject({ staleMicros: 200_000, unknownMicros: 100_000, settledMicros: 90_000 });
  });

  it("answers over HTTP without provider response ids", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${a.projectId}/ai-reservations?state=all&revision=3`,
      headers: { origin, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET_RESPONSE_ID);
    expect(response.body).not.toContain("providerResponseId");
    expect(response.json().items.length).toBeGreaterThan(0);
    const dashboard = await app.inject({
      method: "GET",
      url: `/api/projects/${a.projectId}/dashboard`,
      headers: { origin, cookie },
    });
    expect(dashboard.json().budget).toMatchObject({
      inFlightMicros: 100_000,
      staleMicros: 200_000,
      unknownMicros: 100_000,
      reservedMicros: 400_000,
    });
    const bad = await app.inject({
      method: "GET",
      url: `/api/projects/${a.projectId}/ai-reservations?state=everything`,
      headers: { origin, cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
