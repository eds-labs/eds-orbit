import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// Tables the business role may read, insert and update but never delete.
const NO_DELETE = [
  "FinanceJournalEntry",
  "FinanceJournalLine",
  "FinanceDocument",
  "FinanceDocumentRevision",
  "FinanceInvoice",
  "FinanceInvoiceLine",
  "FinancePayment",
  "FinancePaymentAllocation",
  "FinanceExport",
  "FinanceEntryCounter",
];

/**
 * Ledger integrity in the database (spec §4): posted lines never change,
 * entries change only to record their reversal, every entry balances in the
 * base currency at commit, and the business role cannot delete ledger rows.
 * Runs as orbit_app inside `scoped`, like the application.
 */
describe.skipIf(!enabled)("finance ledger integrity", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let owner: Scope;
  let cash = "";
  let expense = "";
  let sequence = 0;

  const run = <T>(fn: (tx: DbTx) => Promise<T>, s: Scope = owner) =>
    scoped(s.workspaceId, s.projectId, fn);
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "succeeded";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const newProject = async () => {
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
    } satisfies Scope;
  };
  const account = (
    tx: DbTx,
    s: Scope,
    code: string,
    type: string,
    paymentAccount = false,
  ) =>
    tx.financeAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        code,
        name: `Account ${code}`,
        type,
        paymentAccount,
      },
    });
  const entry = (tx: DbTx, s: Scope, extra: Record<string, unknown> = {}) =>
    tx.financeJournalEntry.create({
      data: {
        id: randomUUID(),
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        number: `2026-${String(++sequence).padStart(6, "0")}`,
        entryDate: new Date("2026-10-23"),
        kind: "expense",
        postedBy: s.userId,
        ...extra,
      },
    });
  const line = (
    tx: DbTx,
    s: Scope,
    entryId: string,
    accountId: string,
    side: "debit" | "credit",
    baseAmountMicros: bigint,
  ) =>
    tx.financeJournalLine.create({
      data: {
        id: randomUUID(),
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        entryId,
        accountId,
        side,
        currency: "USD",
        amountMicros: baseAmountMicros,
        fxRate: "1",
        rateDate: new Date("2026-10-23"),
        rateSource: "identity",
        baseAmountMicros,
      },
    });
  // A balanced entry, its lines inserted in later statements of the transaction.
  const post = (s: Scope = owner, extra: Record<string, unknown> = {}) =>
    run(async (tx) => {
      const e = await entry(tx, s, extra);
      await line(tx, s, e.id, expense, "debit", 12_340_000n);
      await line(tx, s, e.id, cash, "credit", 12_340_000n);
      return e;
    }, s);
  const storedFile = async (tx: DbTx, s: Scope) => {
    const id = randomUUID();
    const key = `projects/${s.projectId}/finance/${id}`;
    await tx.fileBlob.create({
      data: {
        key,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        data: Buffer.from([1]),
      },
    });
    await tx.file.create({
      data: {
        id,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        moduleId: "finance",
        key,
        mime: "application/pdf",
        size: 1,
        sha256: "0".repeat(64),
        encryption: "aes-256-gcm/v1",
        createdBy: s.userId,
      },
    });
    return id;
  };
  const document = async (
    tx: DbTx,
    s: Scope,
    sha256: string,
    status = "received",
  ) =>
    tx.financeDocument.create({
      data: {
        id: randomUUID(),
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        fileId: await storedFile(tx, s),
        sha256,
        source: "upload",
        originalName: "receipt.pdf",
        mimeType: "application/pdf",
        status,
      },
    });

  beforeAll(async () => {
    owner = await newProject();
    await run(async (tx) => {
      cash = (await account(tx, owner, "1000", "asset", true)).id;
      expense = (await account(tx, owner, "6000", "expense")).id;
    });
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("posts a balanced entry whose lines follow in later statements", async () => {
    const e = await post();
    const lines = await run((tx) =>
      tx.financeJournalLine.count({ where: { entryId: e.id } }),
    );
    expect(lines).toBe(2);
  });

  it("refuses lines added to an entry posted in an earlier transaction", async () => {
    const e = await post();
    // Even a balanced pair would re-book money under the old number.
    const message = await failure(
      run(async (tx) => {
        await line(tx, owner, e.id, expense, "debit", 1_000_000n);
        await line(tx, owner, e.id, cash, "credit", 1_000_000n);
      }),
    );
    expect(message).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    // Nor to a reversed entry.
    const reversal = await post(owner, {
      kind: "reversal",
      reversalOfId: e.id,
    });
    await run((tx) =>
      tx.financeJournalEntry.update({
        where: { id: e.id },
        data: { reversedById: reversal.id },
      }),
    );
    expect(
      await failure(
        run(async (tx) => {
          await line(tx, owner, e.id, expense, "debit", 1_000_000n);
          await line(tx, owner, e.id, cash, "credit", 1_000_000n);
        }),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    expect(
      await run((tx) =>
        tx.financeJournalLine.count({ where: { entryId: e.id } }),
      ),
    ).toBe(2);
  });

  it("posts inside a savepoint and forgets a rolled back one", async () => {
    const kept = randomUUID();
    const dropped = randomUUID();
    await run(async (tx) => {
      await tx.$executeRaw`SAVEPOINT finance_post`;
      const e = await entry(tx, owner, { id: kept });
      await line(tx, owner, e.id, expense, "debit", 2_000_000n);
      await tx.$executeRaw`RELEASE SAVEPOINT finance_post`;
      // Lines after the released savepoint still belong to the open entry.
      await line(tx, owner, e.id, cash, "credit", 2_000_000n);
      await tx.$executeRaw`SAVEPOINT finance_drop`;
      await entry(tx, owner, { id: dropped });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT finance_drop`;
      // The rolled back savepoint's entry is no longer open for lines.
      const [open] = await tx.$queryRaw<{ ids: string | null }[]>`
        SELECT current_setting('finance.open_entries', true) AS ids`;
      expect(open!.ids?.split(",")).toContain(kept);
      expect(open!.ids?.split(",")).not.toContain(dropped);
    });
    expect(
      await run((tx) =>
        tx.financeJournalLine.count({ where: { entryId: kept } }),
      ),
    ).toBe(2);
  });

  it("refuses to update a posted line", async () => {
    const e = await post();
    const message = await failure(
      run((tx) =>
        tx.financeJournalLine.updateMany({
          where: { entryId: e.id, side: "debit" },
          data: { baseAmountMicros: 1n, amountMicros: 1n },
        }),
      ),
    );
    expect(message).toMatch(/FINANCE_POSTED_IMMUTABLE/);
  });

  it("refuses to change a posted entry except reversedById once", async () => {
    const original = await post();
    // reversedById must name the entry that reverses this one.
    const unrelated = await post();
    expect(
      await failure(
        run((tx) =>
          tx.financeJournalEntry.update({
            where: { id: original.id },
            data: { reversedById: unrelated.id },
          }),
        ),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    expect(
      await failure(
        run((tx) =>
          tx.financeJournalEntry.update({
            where: { id: original.id },
            data: { memo: "changed" },
          }),
        ),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    const reversal = await post(owner, {
      kind: "reversal",
      reversalOfId: original.id,
    });
    // Recording the reversal together with another change is refused too.
    expect(
      await failure(
        run((tx) =>
          tx.financeJournalEntry.update({
            where: { id: original.id },
            data: { reversedById: reversal.id, memo: "changed" },
          }),
        ),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    await run((tx) =>
      tx.financeJournalEntry.update({
        where: { id: original.id },
        data: { reversedById: reversal.id },
      }),
    );
    const other = await post();
    expect(
      await failure(
        run((tx) =>
          tx.financeJournalEntry.update({
            where: { id: original.id },
            data: { reversedById: other.id },
          }),
        ),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
    expect(
      await failure(
        run((tx) =>
          tx.financeJournalEntry.update({
            where: { id: original.id },
            data: { reversedById: null },
          }),
        ),
      ),
    ).toMatch(/FINANCE_POSTED_IMMUTABLE/);
  });

  it("refuses an unbalanced entry at commit", async () => {
    const id = randomUUID();
    const message = await failure(
      run(async (tx) => {
        const e = await entry(tx, owner, { id });
        await line(tx, owner, e.id, expense, "debit", 10_000_000n);
        await line(tx, owner, e.id, cash, "credit", 9_990_000n);
        // The check is deferred: the statements themselves succeed.
        return e;
      }),
    );
    expect(message).toMatch(/FINANCE_ENTRY_UNBALANCED/);
    expect(
      await run((tx) => tx.financeJournalEntry.count({ where: { id } })),
    ).toBe(0);
  });

  it("refuses an unbalanced entry when the workspace scope changes before commit", async () => {
    const message = await failure(
      run(async (tx) => {
        const e = await entry(tx, owner);
        await line(tx, owner, e.id, expense, "debit", 3_000_000n);
        // Hides the entry and its lines from the check at commit.
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${randomUUID()}, true)`;
      }),
    );
    expect(message).toMatch(/FINANCE_ENTRY_UNBALANCED/);
  });

  it("refuses a single-line entry", async () => {
    expect(
      await failure(
        run(async (tx) => {
          const e = await entry(tx, owner);
          await line(tx, owner, e.id, expense, "debit", 5_000_000n);
        }),
      ),
    ).toMatch(/FINANCE_ENTRY_UNBALANCED/);
    // An entry without lines is refused as well.
    expect(await failure(run((tx) => entry(tx, owner)))).toMatch(
      /FINANCE_ENTRY_UNBALANCED/,
    );
  });

  it("cannot delete journal rows", async () => {
    await post();
    for (const table of NO_DELETE) {
      const message = await failure(
        run((tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "projectId" = $1::uuid`,
            owner.projectId,
          ),
        ),
      );
      expect({ table, denied: /permission denied/.test(message) }).toEqual({
        table,
        denied: true,
      });
    }
  });

  it("project deletion still removes finance rows", async () => {
    const doomed = await newProject();
    let accountId = "";
    await run(async (tx) => {
      const debit = await account(tx, doomed, "6000", "expense");
      const credit = await account(tx, doomed, "1000", "asset", true);
      accountId = debit.id;
      const doc = await document(tx, doomed, "a".repeat(64));
      const e = await entry(tx, doomed, { documentId: doc.id });
      await line(tx, doomed, e.id, debit.id, "debit", 1_000_000n);
      await line(tx, doomed, e.id, credit.id, "credit", 1_000_000n);
    }, doomed);
    await authDb.project.delete({ where: { id: doomed.projectId } });
    const counts = await run(
      async (tx) => ({
        accounts: await tx.financeAccount.count({ where: { id: accountId } }),
        documents: await tx.financeDocument.count(),
        entries: await tx.financeJournalEntry.count(),
        lines: await tx.financeJournalLine.count(),
        files: await tx.file.count(),
      }),
      doomed,
    );
    expect(counts).toEqual({
      accounts: 0,
      documents: 0,
      entries: 0,
      lines: 0,
      files: 0,
    });
  });

  it("refuses a second live document with the same hash", async () => {
    const sha = "b".repeat(64);
    const first = await run((tx) => document(tx, owner, sha));
    expect(await failure(run((tx) => document(tx, owner, sha)))).toMatch(
      /Unique constraint|unique/i,
    );
    // Duplicates and rejected originals keep the hash.
    await run((tx) => document(tx, owner, sha, "duplicate"));
    await run((tx) =>
      tx.financeDocument.update({
        where: { id: first.id },
        data: { status: "rejected" },
      }),
    );
    await run((tx) => document(tx, owner, sha));
  });
});
