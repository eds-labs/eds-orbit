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
import { systemAccounts } from "../src/modules/finance/ledger/accounts.ts";
import { applyFinanceTemplate } from "../src/modules/finance/setup.ts";
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
} from "../src/modules/finance/categories.ts";
import { createCostCenter } from "../src/modules/finance/cost-centers.ts";
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
});
