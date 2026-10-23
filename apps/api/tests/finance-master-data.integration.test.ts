import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { CONNECTION_KIND } from "../src/platform/connections/connections.ts";
import { setMailboxOwner } from "../src/platform/email/ownership.ts";
import { create } from "../src/shared.ts";
import { mailboxOwner } from "../src/platform/email/ownership.ts";
import { postEntry } from "../src/modules/finance/ledger/post.ts";
import { systemAccounts } from "../src/modules/finance/ledger/accounts.ts";
import { applyFinanceTemplate } from "../src/modules/finance/setup.ts";
import {
  readFinanceSettings,
  writeFinanceSettings,
} from "../src/modules/finance/settings.ts";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from "../src/modules/finance/accounts.ts";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../src/modules/finance/categories.ts";
import { createCostCenter, deleteCostCenter } from "../src/modules/finance/cost-centers.ts";
import {
  createCounterparty,
  deleteCounterparty,
  normalizeCounterpartyName,
} from "../src/modules/finance/counterparties.ts";
import {
  createRecurring,
  deleteRecurring,
  monthlyEquivalent,
} from "../src/modules/finance/recurring.ts";
import {
  bindMailbox,
  financeMailboxUse,
  unbindMailbox,
} from "../src/modules/finance/mailboxes.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("normalizeCounterpartyName", () => {
  it('normalizes "OpenAI, L.L.C." to "openai"', () => {
    expect(normalizeCounterpartyName("OpenAI, L.L.C.")).toBe("openai");
    expect(normalizeCounterpartyName("Acme GmbH")).toBe("acme");
    expect(normalizeCounterpartyName("Hetzner Online AG")).toBe("hetzneronline");
    expect(normalizeCounterpartyName("Inc")).toBe("inc");
  });
});

describe("monthlyEquivalent", () => {
  const r = (interval: string, micros: bigint, currency = "USD") => ({
    interval,
    expectedAmountMicros: micros,
    currency,
  });
  it("monthly equivalent of a yearly 120.00 USD is 10.00", () => {
    expect(monthlyEquivalent(r("yearly", 120_000_000n))).toBe(10_000_000n);
    expect(monthlyEquivalent(r("monthly", 12_340_000n))).toBe(12_340_000n);
    expect(monthlyEquivalent(r("quarterly", 30_000_000n))).toBe(10_000_000n);
  });
  it("rounds half-even to the currency decimals", () => {
    // 0.30 / 12 = 0.025 -> 0.02 (tie to even), 0.90 / 12 = 0.075 -> 0.08.
    expect(monthlyEquivalent(r("yearly", 300_000n))).toBe(20_000n);
    expect(monthlyEquivalent(r("yearly", 900_000n))).toBe(80_000n);
    // USDC keeps six decimals.
    expect(monthlyEquivalent(r("yearly", 1_000_000n, "USDC"))).toBe(83_333n);
  });
});

describe.skipIf(!enabled)("finance master data", () => {
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

  const newWorkspace = async () => {
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
    return { userId, workspaceId: workspace.id };
  };
  const newProject = async (w: { userId: string; workspaceId: string }) => {
    const project = await authDb.project.create({
      data: { workspaceId: w.workspaceId, name: "Synthetic finance project" },
    });
    return {
      workspaceId: w.workspaceId,
      projectId: project.id,
      userId: w.userId,
      role: "owner",
    } as Scope;
  };
  const mailbox = (s: Scope) =>
    run(s, async (tx) =>
      (
        await create(tx, s, CONNECTION_KIND, {
          provider: "email",
          fromAddress: `${randomUUID()}@example.invalid`,
        })
      ).id,
    );

  let owner: Scope;
  let sibling: Scope;
  let foreign: Scope;

  beforeAll(async () => {
    const workspace = await newWorkspace();
    owner = await newProject(workspace);
    sibling = await newProject(workspace);
    foreign = await newProject(await newWorkspace());
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("template is idempotent", async () => {
    const first = await run(owner, (tx) => applyFinanceTemplate(tx, owner));
    expect(first.created).toBe(11 + 8);
    const second = await run(owner, (tx) => applyFinanceTemplate(tx, owner));
    expect(second.created).toBe(0);
    await run(owner, async (tx) => {
      expect(await listAccounts(tx, owner)).toHaveLength(11);
      const categories = await listCategories(tx, owner);
      expect(categories).toHaveLength(8);
      const accounts = new Map(
        (await listAccounts(tx, owner)).map((a) => [a.id, a.code]),
      );
      for (const c of categories)
        expect(accounts.get(c.accountId)).toBe(
          c.kind === "income" ? "4000" : "6000",
        );
      // Posting finds all six system roles.
      expect(Object.keys(await systemAccounts(tx, owner))).toHaveLength(6);
    });
  });

  it("leaves a system role held by another account alone", async () => {
    const s = await newProject(await newWorkspace());
    await run(s, (tx) =>
      createAccount(tx, s, {
        code: "7777",
        name: "Own payables",
        type: "liability",
        role: "payables",
      }),
    );
    await run(s, (tx) => applyFinanceTemplate(tx, s));
    await run(s, async (tx) => {
      const rows = await tx.financeAccount.findMany({
        where: { projectId: s.projectId, role: "payables" },
      });
      expect(rows.map((r) => r.code)).toEqual(["7777"]);
      expect(
        (await tx.financeAccount.findFirstOrThrow({
          where: { projectId: s.projectId, code: "1600" },
        })).role,
      ).toBeNull();
    });
  });

  it("checks versions and refuses a second live role holder", async () => {
    await run(owner, async (tx) => {
      const account = await createAccount(tx, owner, {
        code: "1500",
        name: "Savings",
        type: "asset",
        paymentAccount: true,
      });
      const renamed = await updateAccount(tx, owner, account.id, {
        version: account.version,
        name: "Savings account",
      });
      expect(renamed.version).toBe(account.version + 1);
      expect(
        await failure(
          updateAccount(tx, owner, account.id, {
            version: account.version,
            name: "Stale",
          }),
        ),
      ).toBe("VERSION_CONFLICT");
      expect(
        await failure(
          createAccount(tx, owner, {
            code: "1501",
            name: "Second payables",
            type: "liability",
            role: "payables",
          }),
        ),
      ).toBe("FINANCE_ROLE_TAKEN");
    });
  });

  it("refuses to delete referenced rows but archives them", async () => {
    await run(owner, async (tx) => {
      const categories = await listCategories(tx, owner);
      const software = categories.find((c) => c.name === "Software & SaaS")!;
      const child = await createCategory(tx, owner, {
        name: "Dev tools",
        kind: "expense",
        parentId: software.id,
        accountId: software.accountId,
      });
      expect(await failure(deleteCategory(tx, owner, software.id))).toBe(
        "FINANCE_IN_USE",
      );
      expect(
        await failure(
          createCategory(tx, owner, {
            name: "Wrong",
            kind: "income",
            accountId: software.accountId,
          }),
        ),
      ).toBe("FINANCE_ACCOUNT_INVALID");
      const counterparty = await createCounterparty(tx, owner, {
        name: "OpenAI, L.L.C.",
        emailDomains: ["OpenAI.com"],
        defaultCategoryId: child.id,
      });
      expect(counterparty.normalizedName).toBe("openai");
      expect(counterparty.emailDomains).toEqual(["openai.com"]);
      expect(await failure(deleteCategory(tx, owner, child.id))).toBe(
        "FINANCE_IN_USE",
      );
      const recurring = await createRecurring(tx, owner, {
        name: "API plan",
        counterpartyId: counterparty.id,
        interval: "yearly",
        expectedAmountMicros: "120000000",
        currency: "USD",
        nextDueDate: "2027-01-01",
      });
      expect(await failure(deleteCounterparty(tx, owner, counterparty.id))).toBe(
        "FINANCE_IN_USE",
      );
      await deleteRecurring(tx, owner, recurring.id);
      await deleteCounterparty(tx, owner, counterparty.id);
      await deleteCategory(tx, owner, child.id);

      const accountId = software.accountId;
      expect(await failure(deleteAccount(tx, owner, accountId))).toBe(
        "FINANCE_IN_USE",
      );
      const archived = await archiveAccount(tx, owner, accountId);
      expect(archived.archivedAt).not.toBeNull();
      expect(
        (await listAccounts(tx, owner, { includeArchived: true })).some(
          (a) => a.id === accountId,
        ),
      ).toBe(true);
    });
  });

  it("cost center can carry an orbitProjectId of the same workspace only", async () => {
    await run(owner, async (tx) => {
      const ok = await createCostCenter(tx, owner, {
        code: "CC1",
        name: "Sibling project",
        orbitProjectId: sibling.projectId,
      });
      expect(ok.orbitProjectId).toBe(sibling.projectId);
      expect(
        await failure(
          createCostCenter(tx, owner, {
            code: "CC2",
            name: "Foreign",
            orbitProjectId: foreign.projectId,
          }),
        ),
      ).toBe("ORBIT_PROJECT_INVALID");
    });
  });

  it("binding a support mailbox is refused", async () => {
    const id = await mailbox(owner);
    await run(owner, (tx) => setMailboxOwner(tx, owner, id, "support"));
    expect(
      await failure(
        run(owner, (tx) => bindMailbox(tx, owner, { emailConnectionId: id })),
      ),
    ).toBe("EMAIL_MAILBOX_OWNED");
  });

  const supportInbox = (s: Scope, emailConnectionId: string | null) =>
    run(s, (tx) =>
      tx.supportInbox.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          name: "Synthetic inbox",
          channels: ["email"],
          emailAddress: `${randomUUID()}@example.invalid`,
          emailConnectionId,
          createdBy: s.userId,
        },
      }),
    );

  it("binding a mailbox a live Support inbox answers from is refused", async () => {
    const id = await mailbox(owner);
    const inbox = await supportInbox(owner, id);
    expect(
      await failure(
        run(owner, (tx) => bindMailbox(tx, owner, { emailConnectionId: id })),
      ),
    ).toBe("EMAIL_MAILBOX_IN_USE");
    // An archived inbox lets go of the mailbox.
    await run(owner, (tx) =>
      tx.supportInbox.update({
        where: { id: inbox.id },
        data: { archivedAt: new Date() },
      }),
    );
    const bound = await run(owner, (tx) =>
      bindMailbox(tx, owner, { emailConnectionId: id }),
    );
    await run(owner, (tx) => unbindMailbox(tx, owner, bound.id));
  });

  it("binding the default mailbox is refused while unbound Support inboxes use it", async () => {
    const project = await newProject(await newWorkspace());
    const verified = (status: string) =>
      run(project, async (tx) =>
        (
          await create(tx, project, CONNECTION_KIND, {
            provider: "email",
            fromAddress: `${randomUUID()}@example.invalid`,
            status,
          })
        ).id,
      );
    const fallback = await verified("read_verified");
    const second = await verified("read_verified");
    await supportInbox(project, null);
    expect(
      await failure(
        run(project, (tx) =>
          bindMailbox(tx, project, { emailConnectionId: fallback }),
        ),
      ),
    ).toBe("EMAIL_MAILBOX_IN_USE");
    // The unbound inbox receives only the default mailbox's mail.
    const bound = await run(project, (tx) =>
      bindMailbox(tx, project, { emailConnectionId: second }),
    );
    expect(bound.active).toBe(true);
  });

  it("unbinding releases ownership", async () => {
    const id = await mailbox(owner);
    const bound = await run(owner, (tx) =>
      bindMailbox(tx, owner, { emailConnectionId: id }),
    );
    expect(bound.archiveFolder).toBe("Orbit/Processed");
    expect(
      await run(owner, (tx) => financeMailboxUse.inUse(tx, owner, id)),
    ).toBe(1);
    expect(
      await failure(
        run(owner, (tx) => bindMailbox(tx, owner, { emailConnectionId: id })),
      ),
    ).toBe("FINANCE_MAILBOX_BOUND");
    await run(owner, (tx) => unbindMailbox(tx, owner, bound.id));
    expect(
      await run(owner, (tx) => financeMailboxUse.inUse(tx, owner, id)),
    ).toBe(0);
    // Support can claim it now.
    await run(owner, (tx) => setMailboxOwner(tx, owner, id, "support"));
  });

  it("keeps a binding that documents point at, switched off", async () => {
    const id = await mailbox(owner);
    const bound = await run(owner, (tx) =>
      bindMailbox(tx, owner, { emailConnectionId: id }),
    );
    await run(owner, async (tx) => {
      const fileId = randomUUID();
      const key = `projects/${owner.projectId}/finance/${fileId}`;
      await tx.fileBlob.create({
        data: {
          key,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          data: Buffer.from([1]),
        },
      });
      await tx.file.create({
        data: {
          id: fileId,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "finance",
          key,
          mime: "application/pdf",
          size: 1,
          sha256: "1".repeat(64),
          encryption: "aes-256-gcm/v1",
          createdBy: owner.userId,
        },
      });
      await tx.financeDocument.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          fileId,
          sha256: "1".repeat(64),
          source: "email",
          mailboxId: bound.id,
          mimeType: "application/pdf",
        },
      });
    });
    await run(owner, (tx) => unbindMailbox(tx, owner, bound.id));
    await run(owner, async (tx) => {
      const row = await tx.financeMailbox.findUniqueOrThrow({
        where: { id: bound.id },
      });
      expect(row.active).toBe(false);
      expect(await financeMailboxUse.inUse(tx, owner, id)).toBe(0);
    });
    // Binding again reactivates the same row.
    const again = await run(owner, (tx) =>
      bindMailbox(tx, owner, { emailConnectionId: id }),
    );
    expect(again.id).toBe(bound.id);
    expect(again.active).toBe(true);
  });

  it("a repeated unbind never strips another module's claim", async () => {
    const id = await mailbox(owner);
    const bound = await run(owner, (tx) =>
      bindMailbox(tx, owner, { emailConnectionId: id }),
    );
    await run(owner, async (tx) => {
      const fileId = randomUUID();
      const key = `projects/${owner.projectId}/finance/${fileId}`;
      await tx.fileBlob.create({
        data: {
          key,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          data: Buffer.from([1]),
        },
      });
      await tx.file.create({
        data: {
          id: fileId,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "finance",
          key,
          mime: "application/pdf",
          size: 1,
          sha256: "2".repeat(64),
          encryption: "aes-256-gcm/v1",
          createdBy: owner.userId,
        },
      });
      await tx.financeDocument.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          fileId,
          sha256: "2".repeat(64),
          source: "email",
          mailboxId: bound.id,
          mimeType: "application/pdf",
        },
      });
    });
    await run(owner, (tx) => unbindMailbox(tx, owner, bound.id));
    await run(owner, (tx) => setMailboxOwner(tx, owner, id, "support"));
    await run(owner, (tx) => unbindMailbox(tx, owner, bound.id));
    const row = await run(owner, (tx) =>
      tx.entity.findFirstOrThrow({ where: { id } }),
    );
    expect(mailboxOwner(row.data as Record<string, unknown>)).toBe("support");
  });

  it("renaming a category to a live name of its kind is refused", async () => {
    await run(owner, async (tx) => {
      const [a, b] = await Promise.all(
        ["Rename A", "Rename B"].map((name) =>
          listAccounts(tx, owner).then((accounts) =>
            createCategory(tx, owner, {
              name,
              kind: "income",
              accountId: accounts.find((x) => x.code === "4000")!.id,
            }),
          ),
        ),
      );
      expect(
        await failure(
          updateCategory(tx, owner, b!.id, {
            version: b!.version,
            name: "Rename A",
          }),
        ),
      ).toBe("FINANCE_DUPLICATE");
      // Keeping its own name is fine.
      await updateCategory(tx, owner, a!.id, {
        version: a!.version,
        name: "Rename A",
      });
    });
  });

  it("base currency and used currencies are locked by what is recorded", async () => {
    const s = await newProject(await newWorkspace());
    const write = (patch: Parameters<typeof writeFinanceSettings>[3]) =>
      run(s, async (tx) => {
        const { version } = await readFinanceSettings(tx, s);
        return writeFinanceSettings(tx, s, version, patch);
      });
    // Nothing posted yet: the base currency may still change.
    await write({ baseCurrency: "EUR" });
    await write({ baseCurrency: "USD" });
    await run(s, (tx) => applyFinanceTemplate(tx, s));
    const recurring = await run(s, (tx) =>
      createRecurring(tx, s, {
        name: "Euro plan",
        interval: "monthly",
        expectedAmountMicros: "10000000",
        currency: "EUR",
        nextDueDate: "2999-01-01",
      }),
    );
    expect(await failure(write({ currencies: ["USD", "USDC"] }))).toBe(
      "FINANCE_CURRENCY_IN_USE",
    );
    await run(s, (tx) =>
      tx.financeRecurring.update({
        where: { id: recurring.id },
        data: { active: false },
      }),
    );
    await run(s, (tx) =>
      createAccount(tx, s, {
        code: "1010",
        name: "USDC wallet",
        type: "asset",
        paymentAccount: true,
        currency: "USDC",
      }),
    );
    expect(await failure(write({ currencies: ["USD"] }))).toBe(
      "FINANCE_CURRENCY_IN_USE",
    );
    expect(await failure(write({ currencies: ["USD", "USDC"] }))).toBe(
      "succeeded",
    );
    // Once anything is posted the base currency is fixed.
    await run(s, async (tx) => {
      const accounts = await listAccounts(tx, s);
      const line = (code: string, side: "debit" | "credit") => ({
        accountId: accounts.find((x) => x.code === code)!.id,
        side,
        currency: "USD",
        amountMicros: 1_000_000n,
        fxRate: "1",
        rateDate: "2027-03-01",
        rateSource: "identity" as const,
        baseAmountMicros: 1_000_000n,
      });
      await postEntry(tx, s, {
        kind: "income",
        entryDate: "2027-03-01",
        lines: [line("1000", "debit"), line("4000", "credit")],
      });
    });
    expect(await failure(write({ baseCurrency: "USDC" }))).toBe(
      "FINANCE_BASE_CURRENCY_LOCKED",
    );
    // Re-saving the same base currency is fine.
    expect(await failure(write({ baseCurrency: "USD", fxSource: "manual" }))).toBe(
      "succeeded",
    );
  });

  it("currency and payment flag are frozen once an account has postings", async () => {
    await run(owner, async (tx) => {
      const accounts = await listAccounts(tx, owner);
      const bank = accounts.find((x) => x.code === "1000")!;
      const revenue = accounts.find((x) => x.code === "4000")!;
      const line = (accountId: string, side: "debit" | "credit") => ({
        accountId,
        side,
        currency: "USD",
        amountMicros: 5_000_000n,
        fxRate: "1",
        rateDate: "2027-03-01",
        rateSource: "identity" as const,
        baseAmountMicros: 5_000_000n,
      });
      await postEntry(tx, owner, {
        kind: "income",
        entryDate: "2027-03-01",
        lines: [line(bank.id, "debit"), line(revenue.id, "credit")],
      });
      expect(
        await failure(
          updateAccount(tx, owner, bank.id, {
            version: bank.version,
            paymentAccount: false,
          }),
        ),
      ).toBe("FINANCE_IN_USE");
      expect(
        await failure(
          updateAccount(tx, owner, bank.id, {
            version: bank.version,
            currency: "EUR",
          }),
        ),
      ).toBe("FINANCE_IN_USE");
      // Other fields stay editable.
      await updateAccount(tx, owner, bank.id, {
        version: bank.version,
        name: "Main bank",
      });
    });
  });

  it("refuses to delete a cost center used by an allocation or a journal line", async () => {
    await run(owner, async (tx) => {
      const viaAllocation = await createCostCenter(tx, owner, {
        code: "CC-ALLOC",
        name: "Allocated",
      });
      const viaLine = await createCostCenter(tx, owner, {
        code: "CC-LINE",
        name: "Posted",
      });
      const unused = await createCostCenter(tx, owner, {
        code: "CC-FREE",
        name: "Unused",
      });
      await createCounterparty(tx, owner, {
        name: "Allocating Vendor",
        defaultAllocation: [{ costCenterId: viaAllocation.id, bp: 10_000 }],
      });
      const accounts = await listAccounts(tx, owner);
      const bank = accounts.find((x) => x.code === "1000")!;
      const expense = accounts.find((x) => x.code === "6990")!;
      const line = (
        accountId: string,
        side: "debit" | "credit",
        costCenterId?: string,
      ) => ({
        accountId,
        side,
        currency: "USD",
        amountMicros: 2_000_000n,
        fxRate: "1",
        rateDate: "2027-03-02",
        rateSource: "identity" as const,
        baseAmountMicros: 2_000_000n,
        ...(costCenterId ? { costCenterId } : {}),
      });
      await postEntry(tx, owner, {
        kind: "expense",
        entryDate: "2027-03-02",
        lines: [line(expense.id, "debit", viaLine.id), line(bank.id, "credit")],
      });
      expect(await failure(deleteCostCenter(tx, owner, viaAllocation.id))).toBe(
        "FINANCE_IN_USE",
      );
      expect(await failure(deleteCostCenter(tx, owner, viaLine.id))).toBe(
        "FINANCE_IN_USE",
      );
      expect(await failure(deleteCostCenter(tx, owner, unused.id))).toBe(
        "succeeded",
      );
    });
  });
});
