import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type DbTx,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { platformActions } from "../src/platform/http/platform-actions.ts";
import { reservationMonth } from "../src/platform/attention/platform-items.ts";
import { monthOf } from "../src/platform/ai/org-budget.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Production uLiquid, 2026-10-19: eight image reservations settled with an
 * unclear outcome kept "AI cost unclear: $2.60" on the home page for 17 days
 * with nothing the owner could do about it. The owner action settles
 * unclear reservations at their reserved amount, which their month already
 * counts. Since plan 2026-11-10 (WP2 C) the owner names each reservation,
 * gives a reason and confirms; any month; only `unknown` rows of this
 * project; counters move once.
 */
describe.skipIf(!enabled)("settle-unknown-reservations", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>, s: Scope = scope) =>
    scoped(s.workspaceId, s.projectId, fn, db);
  const settle = (input: Record<string, unknown>, s: Scope = scope) =>
    run((tx) => {
      const handler = platformActions["settle-unknown-reservations"]!;
      if (handler.transaction !== "shared") throw new Error("shared expected");
      return handler.run(tx, {
        scope: s,
        input,
        config: loadConfig(),
        auth: null as never,
      }) as Promise<{ settled: number; micros: string; reservationIds: string[] }>;
    }, s);
  const valid = (reservationIds: string[], over: Record<string, unknown> = {}) => ({
    reservationIds,
    reason: "provider_invoice_checked",
    confirm: true,
    ...over,
  });
  const reservation = (
    state: string,
    amount: number,
    createdAt: Date,
    settled: number | null = null,
    s: Scope = scope,
  ) =>
    run(
      (tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key: `${s.projectId}:${randomUUID()}`,
            category: "image_generation",
            amountMicros: BigInt(amount),
            settledMicros: settled === null ? null : BigInt(settled),
            state,
            createdAt,
            // Counted on the organization's month counters (phase C).
            orgProvider: "openai",
          },
        }),
      s,
    );
  const counter = async (month: Date, key = "total") => {
    const row = await auth.organizationSpendCounter.findFirst({
      where: { workspaceId: scope.workspaceId, scopeKey: key, periodStart: month },
    });
    return { reserved: Number(row?.reservedMicros ?? 0), settled: Number(row?.settledMicros ?? 0) };
  };
  const seedCounter = (month: Date, reserved: number) =>
    auth.organizationSpendCounter.createMany({
      data: ["total", "openai"].map((scopeKey) => ({
        workspaceId: scope.workspaceId,
        scopeKey,
        periodStart: month,
        reservedMicros: BigInt(reserved),
        settledMicros: 0n,
      })),
    });
  const audits = () =>
    run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "budget.unknown_reservations_settled",
        },
      }),
    );
  const rows = async () =>
    new Map(
      (
        await run((tx) =>
          tx.budgetReservation.findMany({ where: { projectId: scope.projectId } }),
        )
      ).map((r) => [r.id, r]),
    );

  beforeEach(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic unclear cost",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const p = await auth.project.create({
      data: { workspaceId: w.id, name: "Unclear cost" },
    });
    scope = {
      workspaceId: w.id,
      projectId: p.id,
      userId: user.id,
      role: "owner",
    };
  });
  afterEach(async () => {
    await auth.workspace.delete({ where: { id: scope.workspaceId } }).catch(() => null);
    await db.$disconnect();
    await auth.$disconnect();
  });

  it("settles only the named unclear reservations at the reserved amount, any month, with an audited reason", async () => {
    const now = new Date();
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86400000,
    );
    await seedCounter(monthOf(now), 1_100_000);
    await seedCounter(monthOf(lastMonth), 700_000);
    const earlier = (ms: number) => new Date(Math.max(now.getTime() - ms, monthOf(now).getTime()));
    const a = await reservation("unknown", 1_000_000, earlier(2000));
    const b = await reservation("unknown", 100_000, earlier(1000));
    const old = await reservation("unknown", 700_000, lastMonth);
    const untouched = await reservation("unknown", 50_000, now);
    const before = await run((tx) => reservationMonth(tx, scope, now));

    const result = await settle(
      valid([a.id, b.id, old.id], { note: "Checked the OpenAI invoice for October." }),
    );
    expect(result).toMatchObject({ settled: 3, micros: "1800000" });
    // Oldest first: the order the rows were read and settled in.
    expect(result.reservationIds).toEqual([old.id, a.id, b.id]);
    const after = await rows();
    for (const row of [a, b, old])
      expect(after.get(row.id)).toEqual(
        expect.objectContaining({ state: "settled", settledMicros: row.amountMicros }),
      );
    expect(after.get(untouched.id)!.state).toBe("unknown");
    // The month's total is unchanged: the unclear part was counted at its
    // reserved amount already.
    const month = await run((tx) => reservationMonth(tx, scope, now));
    expect(month.spentMicros).toBe(before.spentMicros);
    expect(month.unknown).toEqual(expect.objectContaining({ micros: 50_000 }));
    // Each row's own month moves from reserved to settled once.
    expect(await counter(monthOf(now))).toEqual({ reserved: 0, settled: 1_100_000 });
    expect(await counter(monthOf(lastMonth), "openai")).toEqual({ reserved: 0, settled: 700_000 });
    const [entry, ...more] = await audits();
    expect(more).toHaveLength(0);
    // Content-free: ids, reason, amount and the note's length, not its text.
    expect(entry!.metadata).toEqual({
      count: 3,
      micros: "1800000",
      reservationIds: result.reservationIds,
      reason: "provider_invoice_checked",
      noteLength: 39,
    });
    expect(JSON.stringify(entry!.metadata)).not.toContain("invoice for");
  });

  it("needs ids, a known reason and confirm:true", async () => {
    const a = await reservation("unknown", 100_000, new Date());
    for (const input of [
      {},
      { reason: "provider_invoice_checked", confirm: true },
      valid([]),
      valid([a.id], { confirm: false }),
      valid([a.id], { confirm: undefined }),
      valid([a.id], { reason: "looks_fine" }),
      valid([a.id], { note: "x".repeat(301) }),
      valid([a.id], { all: true }),
      valid(["not-a-uuid"]),
    ])
      await expect(settle(input)).rejects.toThrow();
    expect((await rows()).get(a.id)!.state).toBe("unknown");
    expect(await audits()).toHaveLength(0);
  });

  it("refuses rows in flight, settled or released and changes nothing", async () => {
    const now = new Date();
    const unclear = await reservation("unknown", 100_000, now);
    const done = await reservation("settled", 100_000, now, 40_000);
    const live = await reservation("in_flight", 100_000, now);
    const released = await reservation("released", 100_000, now);
    for (const other of [done, live, released])
      await expect(settle(valid([unclear.id, other.id]))).rejects.toMatchObject({
        code: "RESERVATION_NOT_UNKNOWN",
        status: 409,
      });
    const after = await rows();
    expect(after.get(unclear.id)!.state).toBe("unknown");
    expect(after.get(done.id)!.settledMicros).toBe(40_000n);
    expect(after.get(live.id)!.state).toBe("in_flight");
    expect(await audits()).toHaveLength(0);
  });

  it("moves counters once: a repeated call is refused and changes nothing", async () => {
    const now = new Date();
    await seedCounter(monthOf(now), 300_000);
    const a = await reservation("unknown", 300_000, now);
    expect((await settle(valid([a.id]))).settled).toBe(1);
    const once = await counter(monthOf(now));
    await expect(settle(valid([a.id]))).rejects.toMatchObject({
      code: "RESERVATION_NOT_UNKNOWN",
    });
    // Two calls at once: the project lock serializes them; one settles.
    const b = await reservation("unknown", 200_000, now);
    const raced = await Promise.allSettled([settle(valid([b.id])), settle(valid([b.id]))]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(once).toEqual({ reserved: 0, settled: 300_000 });
    expect(await counter(monthOf(now))).toEqual({ reserved: 0, settled: 500_000 });
    expect(await audits()).toHaveLength(2);
  });

  it("never reaches another project's reservation and refuses an editor", async () => {
    const other = await auth.project.create({
      data: { workspaceId: scope.workspaceId, name: "Other project" },
    });
    const otherScope = { ...scope, projectId: other.id };
    const foreign = await reservation("unknown", 100_000, new Date(), null, otherScope);
    await expect(settle(valid([foreign.id]))).rejects.toMatchObject({
      code: "RESERVATION_MISSING",
      status: 404,
    });
    const own = await reservation("unknown", 100_000, new Date());
    await expect(
      settle(valid([own.id]), { ...scope, role: "editor" }),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
    expect(
      (await run((tx) => tx.budgetReservation.findFirstOrThrow({ where: { id: foreign.id } }), otherScope))
        .state,
    ).toBe("unknown");
    expect((await rows()).get(own.id)!.state).toBe("unknown");
  });
});
