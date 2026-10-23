import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  SYSTEM_ROLES,
  systemAccounts,
} from "../src/modules/finance/ledger/accounts.ts";
import { postEntry } from "../src/modules/finance/ledger/post.ts";
import { postingLines, type DraftLine } from "../src/modules/finance/ledger/posting.ts";
import { reverseEntry } from "../src/modules/finance/ledger/reversal.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The posting core against the database (spec §7): gap-free numbering per
 * project and year under concurrency, one reversal per entry, and no posting
 * before the system accounts exist. Runs as orbit_app inside `scoped`.
 */
describe.skipIf(!enabled)("finance ledger posting", () => {
  const users: string[] = [];
  const workspaces: string[] = [];

  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "succeeded";
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };

  const newProject = async (): Promise<Scope> => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic finance user",
        email: `${userId}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic finance workspace",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic finance project" },
    });
    return {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
  };
  const account = (
    tx: DbTx,
    s: Scope,
    code: string,
    type: string,
    extra: { role?: string; paymentAccount?: boolean } = {},
  ) =>
    tx.financeAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        code,
        name: `Account ${code}`,
        type,
        ...extra,
      },
    });
  const ROLE_TYPES: Record<(typeof SYSTEM_ROLES)[number], string> = {
    payables: "liability",
    receivables: "asset",
    owner_contributions: "equity",
    owner_draws: "equity",
    fx_gain_loss: "expense",
    rounding: "expense",
  };
  // The system accounts Task 10's template creates later, made directly.
  const setUp = (s: Scope) =>
    run(s, async (tx) => {
      for (const [index, role] of SYSTEM_ROLES.entries())
        await account(tx, s, `9${index}00`, ROLE_TYPES[role], { role });
      const bank = await account(tx, s, "1000", "asset", { paymentAccount: true });
      const software = await account(tx, s, "6000", "expense");
      return { bank: bank.id, software: software.id };
    });
  const cash = (bank: string, software: string, micros = 25_000_000n): DraftLine[] =>
    (["debit", "credit"] as const).map((side) => ({
      accountId: side === "debit" ? software : bank,
      side,
      currency: "USD",
      amountMicros: micros,
      fxRate: "1",
      rateDate: "2027-03-01",
      rateSource: "identity",
      baseAmountMicros: micros,
    }));

  let owner: Scope;
  let bank = "";
  let software = "";

  beforeAll(async () => {
    owner = await newProject();
    ({ bank, software } = await setUp(owner));
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("posts and numbers entries per year without gaps under concurrency", async () => {
    const posted = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(owner, (tx) =>
          postEntry(tx, owner, {
            kind: "expense",
            entryDate: "2027-03-01",
            lines: cash(bank, software),
          }),
        ),
      ),
    );
    expect(posted.map((p) => p.number).sort()).toEqual([
      "2027-000001",
      "2027-000002",
      "2027-000003",
      "2027-000004",
      "2027-000005",
    ]);
    // Another year starts at 1; a failed posting leaves no gap.
    expect(
      await failure(
        run(owner, (tx) =>
          postEntry(tx, owner, {
            kind: "expense",
            entryDate: "2028-01-02",
            lines: [cash(bank, software)[0]!, cash(bank, software, 1_000_000n)[1]!],
          }),
        ),
      ),
    ).toBe("FINANCE_ENTRY_UNBALANCED");
    const next = await run(owner, (tx) =>
      postEntry(tx, owner, {
        kind: "expense",
        entryDate: "2028-01-02",
        lines: cash(bank, software),
      }),
    );
    expect(next.number).toBe("2028-000001");

    const events = await run(owner, (tx) =>
      tx.auditEvent.findMany({
        where: { projectId: owner.projectId, resourceId: next.id },
      }),
    );
    expect(events.map((e) => [e.action, e.metadata])).toEqual([
      ["finance.entry.posted", { kind: "expense", lines: 2 }],
    ]);
  });

  it("posts a split payable invoice from the posting rules", async () => {
    const { entry, lines } = await run(owner, async (tx) => {
      const roles = await systemAccounts(tx, owner);
      const category = await tx.financeCategory.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          name: "Software",
          kind: "expense",
          accountId: software,
        },
      });
      const centers = [];
      for (const code of ["A", "B"])
        centers.push(
          await tx.financeCostCenter.create({
            data: {
              id: randomUUID(),
              workspaceId: owner.workspaceId,
              projectId: owner.projectId,
              code,
              name: `Center ${code}`,
            },
          }),
        );
      const draft = postingLines(
        {
          kind: "invoice",
          direction: "payable",
          currency: "EUR",
          baseCurrency: "USD",
          lines: [
            {
              amountMicros: 100_000_000n,
              taxMicros: 19_000_000n,
              categoryAccountId: software,
              categoryId: category.id,
              allocation: [
                { costCenterId: centers[0]!.id, bp: 6000 },
                { costCenterId: centers[1]!.id, bp: 4000 },
              ],
            },
          ],
        },
        roles,
        { rate: "1.087500000000", rateDate: "2027-02-26", source: "ecb" },
        2,
      );
      const entry = await postEntry(tx, owner, {
        kind: "invoice",
        entryDate: "2027-03-01",
        lines: draft,
      });
      const lines = await tx.financeJournalLine.findMany({
        where: { projectId: owner.projectId, entryId: entry.id },
      });
      return { entry, lines };
    });
    expect(entry.number).toMatch(/^2027-\d{6}$/);
    expect(lines).toHaveLength(3);
    const debit = lines.filter((l) => l.side === "debit");
    expect(debit.map((l) => l.costCenterId).every(Boolean)).toBe(true);
    expect(
      debit.reduce((acc, l) => acc + l.baseAmountMicros, 0n),
    ).toBe(lines.find((l) => l.side === "credit")!.baseAmountMicros);
    expect(lines[0]!.rateDate.toISOString().slice(0, 10)).toBe("2027-02-26");
    expect(lines[0]!.fxRate.toFixed()).toBe("1.0875");
  });

  it("reverses once", async () => {
    const original = await run(owner, (tx) =>
      postEntry(tx, owner, {
        kind: "expense",
        entryDate: "2027-04-01",
        memo: "Original",
        lines: cash(bank, software, 12_340_000n),
      }),
    );
    const reversal = await run(owner, (tx) =>
      reverseEntry(tx, owner, original.id, "Booked twice", "2027-04-02"),
    );
    expect(reversal.number).toMatch(/^2027-\d{6}$/);

    const state = await run(owner, async (tx) => ({
      entries: await tx.financeJournalEntry.findMany({
        where: { projectId: owner.projectId, id: { in: [original.id, reversal.id] } },
      }),
      lines: await tx.financeJournalLine.findMany({
        where: { projectId: owner.projectId, entryId: { in: [original.id, reversal.id] } },
      }),
      events: await tx.auditEvent.findMany({
        where: { projectId: owner.projectId, resourceId: reversal.id },
      }),
    }));
    const byId = new Map(state.entries.map((e) => [e.id, e]));
    expect(byId.get(original.id)!.reversedById).toBe(reversal.id);
    expect(byId.get(reversal.id)).toMatchObject({
      kind: "reversal",
      reversalOfId: original.id,
      memo: "Booked twice",
    });
    expect(byId.get(reversal.id)!.entryDate.toISOString().slice(0, 10)).toBe("2027-04-02");
    const sides = (entryId: string) =>
      state.lines
        .filter((l) => l.entryId === entryId)
        .map((l) => [l.accountId, l.side, l.amountMicros, l.baseAmountMicros])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(sides(reversal.id)).toEqual(
      sides(original.id).map(([a, side, m, b]) => [
        a,
        side === "debit" ? "credit" : "debit",
        m,
        b,
      ]),
    );
    // The reason stays out of the audit trail.
    expect(state.events.map((e) => [e.action, e.metadata])).toEqual([
      ["finance.entry.reversed", { kind: "reversal", lines: 2, reversalOfId: original.id }],
    ]);

    expect(
      await failure(run(owner, (tx) => reverseEntry(tx, owner, original.id, "Again"))),
    ).toBe("FINANCE_ALREADY_REVERSED");
    expect(
      await failure(run(owner, (tx) => reverseEntry(tx, owner, reversal.id, "Undo"))),
    ).toBe("FINANCE_REVERSAL_NOT_REVERSIBLE");
    expect(
      await failure(run(owner, (tx) => reverseEntry(tx, owner, randomUUID(), "Missing"))),
    ).toBe("FINANCE_ENTRY_NOT_FOUND");
  });

  it("refuses posting before setup", async () => {
    const fresh = await newProject();
    expect(await failure(run(fresh, (tx) => systemAccounts(tx, fresh)))).toBe(
      "FINANCE_SETUP_REQUIRED",
    );
    // An archived system account counts as missing.
    await setUp(fresh);
    await run(fresh, (tx) =>
      tx.financeAccount.updateMany({
        where: { projectId: fresh.projectId, role: "rounding" },
        data: { archivedAt: new Date() },
      }),
    );
    expect(await failure(run(fresh, (tx) => systemAccounts(tx, fresh)))).toBe(
      "FINANCE_SETUP_REQUIRED",
    );
    // Other projects' accounts do not count.
    const roles = await run(owner, (tx) => systemAccounts(tx, owner));
    expect(Object.keys(roles).sort()).toEqual([...SYSTEM_ROLES].sort());
  });
});
