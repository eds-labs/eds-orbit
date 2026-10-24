import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, update } from "../src/platform/shared.ts";
import {
  activePolicyRecord,
  activeSpendMandateRef,
  requireSpendMandate,
} from "../src/platform/ai/spend-mandate.ts";
import { reserve } from "../src/platform/ai/budget.ts";
import { activePolicy } from "../src/modules/policy.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/** The AI spend mandate read from the active marketing policy (WP1.2, AD-10 step 1). */
describe.skipIf(!enabled)("AI spend mandate projection", () => {
  let scope: Scope;
  const users: string[] = [];
  const workspaces: string[] = [];
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const policy = (overrides: Record<string, unknown> = {}) => ({
    mode: "assisted",
    channels: ["x-int"],
    contentTypes: ["social"],
    allowedOrigins: ["https://example.invalid"],
    startAt: new Date(Date.now() - HOUR).toISOString(),
    endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    maxPerDay: 2,
    minIntervalMinutes: 60,
    dailyBudgetMicros: 1_000_000,
    monthlyBudgetMicros: 20_000_000,
    perRunBudgetMicros: 200_000,
    approvedPaidTests: true,
    active: true,
    activatedAt: new Date().toISOString(),
    activatedBy: "owner",
    ...overrides,
  });

  beforeAll(async () => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic mandate owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic mandate",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic mandate project" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("requires an active policy, as the paid calls did before", async () => {
    await run(async (tx) => {
      await create(tx, scope, "policies", policy({ active: false }));
      await expect(requireSpendMandate(tx, scope)).rejects.toThrow(
        "POLICY_REQUIRED",
      );
      expect(await activeSpendMandateRef(tx, scope)).toBeNull();
      expect(await activePolicyRecord(tx, scope)).toBeNull();
    });
  });

  it("projects the active policy onto the spend limits and its record version", async () => {
    await run(async (tx) => {
      const row = await create(tx, scope, "policies", policy());
      const stored = row.data as { startAt: string; endAt: string };
      expect(await requireSpendMandate(tx, scope)).toEqual({
        id: row.id,
        version: row.version,
        limits: {
          startAt: stored.startAt,
          endAt: stored.endAt,
          approvedPaidTests: true,
          dailyBudgetMicros: 1_000_000,
          monthlyBudgetMicros: 20_000_000,
          perRunBudgetMicros: 200_000,
        },
        // Without a platform record the Marketing policy is the source (ADR 0015).
        source: "marketing_policy",
      });
      // Marketing reads the same record.
      expect((await activePolicy(tx, scope))?.id).toBe(row.id);
      expect(await activeSpendMandateRef(tx, scope)).toEqual({
        id: row.id,
        version: row.version,
        data: {
          startAt: (row.data as { startAt: string }).startAt,
          endAt: (row.data as { endAt: string }).endAt,
        },
      });
      await update(tx, scope, row, { ...(row.data as object), active: false });
    });
  });

  it("validates the budget fields only: an invalid publishing field no longer stops paid AI (ADR 0015)", async () => {
    await run(async (tx) => {
      const publishing = await create(
        tx,
        scope,
        "policies",
        policy({ maxPerDay: 99 }),
      );
      expect((await requireSpendMandate(tx, scope)).id).toBe(publishing.id);
      await update(tx, scope, publishing, {
        ...(publishing.data as object),
        active: false,
      });
      // An invalid budget still fails; its reference does not.
      const budget = await create(
        tx,
        scope,
        "policies",
        policy({ dailyBudgetMicros: -1 }),
      );
      await expect(requireSpendMandate(tx, scope)).rejects.toBeInstanceOf(
        ZodError,
      );
      expect((await activeSpendMandateRef(tx, scope))?.id).toBe(budget.id);
      await update(tx, scope, budget, { ...(budget.data as object), active: false });
    });
  });

  it("reserves against the limits alone", async () => {
    await run(async (tx) => {
      const row = await create(tx, scope, "policies", policy());
      const { limits } = await requireSpendMandate(tx, scope);
      const reservation = await reserve(
        tx,
        scope,
        `mandate:${randomUUID()}`,
        "test",
        1_000,
        limits,
      );
      expect(reservation.state).toBe("reserved");
      await expect(
        reserve(tx, scope, `mandate:${randomUUID()}`, "test", 300_000, limits),
      ).rejects.toThrow("BUDGET_NOT_APPROVED");
      await expect(
        reserve(tx, scope, `mandate:${randomUUID()}`, "test", 1_000, {
          ...limits,
          approvedPaidTests: false,
        }),
      ).rejects.toThrow("BUDGET_NOT_APPROVED");
      await expect(
        reserve(tx, scope, `mandate:${randomUUID()}`, "test", 1_000, {
          ...limits,
          endAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ).rejects.toThrow("PAID_MANDATE_EXPIRED");
      await update(tx, scope, row, { ...(row.data as object), active: false });
    });
  });
});
