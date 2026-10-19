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
import { loadConfig } from "../../../packages/config/src/index.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Production uLiquid, 2026-10-19: eight image reservations settled with an
 * unclear outcome kept "AI cost unclear: $2.60" on the home page for 17 days
 * with nothing the owner could do about it. The owner action settles the
 * month's unclear reservations at their reserved amount, which the month's
 * total already counts.
 */
describe.skipIf(!enabled)("settle-unknown-reservations", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn, db);
  const settle = () =>
    run((tx) => {
      const handler = platformActions["settle-unknown-reservations"]!;
      if (handler.transaction !== "shared") throw new Error("shared expected");
      return handler.run(tx, {
        scope,
        input: {},
        config: loadConfig(),
        auth: null as never,
      }) as Promise<{ settled: number; micros: string }>;
    });
  const reservation = (
    state: string,
    amount: number,
    createdAt: Date,
    settled: number | null = null,
  ) =>
    run((tx) =>
      tx.budgetReservation.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          key: `${scope.projectId}:${randomUUID()}`,
          category: "image_generation",
          amountMicros: BigInt(amount),
          settledMicros: settled === null ? null : BigInt(settled),
          state,
          createdAt,
        },
      }),
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
    await db.$disconnect();
    await auth.$disconnect();
  });

  it("settles this month's unclear reservations at the reserved amount and leaves the rest alone", async () => {
    const now = new Date();
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86400000,
    );
    const a = await reservation("unknown", 1_000_000, now);
    const b = await reservation("unknown", 100_000, now);
    const old = await reservation("unknown", 700_000, lastMonth);
    const done = await reservation("settled", 100_000, now, 40_000);
    const open = await reservation("in_flight", 100_000, now);
    const before = await run((tx) => reservationMonth(tx, scope, now));
    expect(before.unknown).toEqual(
      expect.objectContaining({ micros: 1_100_000 }),
    );

    expect(await settle()).toEqual({ settled: 2, micros: "1100000" });

    const rows = new Map(
      (
        await run((tx) =>
          tx.budgetReservation.findMany({
            where: { projectId: scope.projectId },
          }),
        )
      ).map((r) => [r.id, r]),
    );
    for (const row of [a, b])
      expect(rows.get(row.id)).toEqual(
        expect.objectContaining({
          state: "settled",
          settledMicros: row.amountMicros,
        }),
      );
    expect(rows.get(old.id)!.state).toBe("unknown");
    expect(rows.get(done.id)!.settledMicros).toBe(40_000n);
    expect(rows.get(open.id)!.state).toBe("in_flight");
    // The month's total is unchanged: the unclear part was counted at its
    // reserved amount already.
    const after = await run((tx) => reservationMonth(tx, scope, now));
    expect(after.spentMicros).toBe(before.spentMicros);
    expect(after.unknown).toBeNull();
    const audits = await run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "budget.unknown_reservations_settled",
        },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ count: 2, micros: "1100000" });
    // A second call finds nothing and writes no audit.
    expect(await settle()).toEqual({ settled: 0, micros: "0" });
  });
});
