import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  db,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { getActiveIndex } from "../../../packages/knowledge/src/index.ts";
import { ingest } from "../src/platform/knowledge/engine.ts";
import { audit, create } from "../src/shared.ts";
import { enqueue } from "../src/modules/workflow.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Every table in the public schema, by how the business role (orbit_app)
 * may reach it. A new table fails this test until it is classified here,
 * has FORCE RLS where required and the grants in scripts/db-deploy.ts.
 */
const PROJECT_TABLES = [
  "AgentRun",
  "AgentSpan",
  "AuditEvent",
  "BudgetReservation",
  "ChunkEmbedding",
  "DocumentVersion",
  "DomainEvent",
  "Entity",
  "EntityVersion",
  "File",
  "FileBlob",
  "KnowledgeChunk",
  "KnowledgeDocument",
  "KnowledgeIndex",
  "ObjectLink",
  "Outbox",
  "ProjectMarketingProfile",
  "ProjectMarketingProfileVersion",
  "ProjectModule",
  // Support (WP5.1).
  "SupportAttachment",
  "SupportContact",
  "SupportContactIdentity",
  "SupportInbox",
  "SupportMessage",
  "SupportTicket",
  "SupportTicketCounter",
  "SupportTicketEvent",
  // Finance.
  "FinanceAccount",
  "FinanceCategory",
  "FinanceCostCenter",
  "FinanceCounterparty",
  "FinanceDocument",
  "FinanceDocumentRevision",
  "FinanceEntryCounter",
  "FinanceExport",
  "FinanceFxRate",
  "FinanceInvoice",
  "FinanceInvoiceLine",
  "FinanceJournalEntry",
  "FinanceJournalLine",
  "FinanceMailbox",
  "FinancePayment",
  "FinancePaymentAllocation",
  "FinanceRecurring",
  // Project management (ADR 0016).
  "WorkAttachment",
  "WorkChecklistItem",
  "WorkComment",
  "WorkEvent",
  "WorkInitiative",
  "WorkMilestone",
  "WorkTask",
  "WorkTaskCounter",
  "WorkTaskDependency",
  "WorkTaskWatcher",
];
// Project scope plus the chat owner (app.user_id).
const CHAT_TABLES = [
  "ChatConversation",
  "ChatMessage",
  "ChatProposal",
  "ChatRun",
  // Member notifications (WP4.7): private per member the same way.
  "Notification",
  "NotificationPreference",
];
// RLS for the business role, full control only for orbit_auth.
const TENANCY_TABLES = [
  "Project",
  "ProjectMember",
  "ProjectMemberModuleRole",
  "PublicClientKey",
  "Workspace",
  "WorkspaceMember",
];
// Better Auth tables and Prisma's journal: no RLS, never granted to orbit_app.
const AUTH_ONLY_TABLES = [
  "Invitation",
  "InvitationProjectGrant",
  "McpGrant",
  "McpGrantEvent",
  "account",
  "jwks",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
  "SystemAuditEvent",
  "session",
  "user",
  "verification",
];
const SYSTEM_TABLES = ["_prisma_migrations"];
// Control plane with forced row-level security that the business role may
// read where a project grant allows it (ADR 0014); written by orbit_auth.
const GRANTED_READ_TABLES = [
  "AiModelPrice",
  "AiProfile",
  "Connection",
  "ConnectionGrant",
  "ConnectionSecret",
  "KnowledgeShare",
  "WorkflowBinding",
];
const COUNTER_TABLES = ["SpendCounter"];
// Tenancy tables the business role must not touch at all.
const NO_APP_ACCESS = [
  "ProjectMember",
  "ProjectMemberModuleRole",
  "PublicClientKey",
  "Workspace",
  "WorkspaceMember",
  ...AUTH_ONLY_TABLES,
  ...SYSTEM_TABLES,
];
const SCOPED_TABLES = [...PROJECT_TABLES, ...CHAT_TABLES];
// Scoped tables the business role may not fully control, with exactly the
// privileges it has ([select, insert, update, delete]); every other scoped
// table has all four.
const RESTRICTED_GRANTS: Record<string, [boolean, boolean, boolean, boolean]> =
  {
    // Append-only audit log.
    AuditEvent: [true, true, false, false],
    // Disabling a module keeps its row (WP1.4).
    ProjectModule: [true, true, true, false],
    // ADR 0016: links are removed softly; events are append-only and
    // deleted only by retention.
    ObjectLink: [true, true, true, false],
    DomainEvent: [true, true, false, true],
    // Task history is append-only; deleting a task still cascades.
    WorkEvent: [true, true, false, false],
    // Finance records: posted entries, their documents and payments cannot
    // be deleted (spec §4); project deletion still cascades.
    ...Object.fromEntries(
      [
        "FinanceDocument",
        "FinanceDocumentRevision",
        "FinanceEntryCounter",
        "FinanceExport",
        "FinanceInvoice",
        "FinanceInvoiceLine",
        "FinanceJournalEntry",
        "FinanceJournalLine",
        "FinancePayment",
        "FinancePaymentAllocation",
      ].map((t) => [t, [true, true, true, false] as const]),
    ),
  };

type TableInfo = {
  relname: string;
  rls: boolean;
  force: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
};

describe.skipIf(!enabled)("Row-level security matrix (business role)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let tables: TableInfo[];
  // A and C share a workspace; B lives in another one.
  let a: Scope, b: Scope, c: Scope;
  // An existing row of B, so a cross-project outbox insert can fail only on RLS.
  let bEntityId: string;
  // Support inboxes and their mailboxes per project, for the same-project
  // foreign key checks.
  const inboxes = new Map<string, string>();
  const mailboxes = new Map<string, string>();
  // A finance payment account per project, for the same-project key check.
  const financeAccounts = new Map<string, string>();
  // A work initiative per project, for the same-project key check.
  const workInitiatives = new Map<string, string>();

  const synthetic = async () => {
    const row = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic RLS user",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(row.id);
    return row.id;
  };
  const workspace = async (owner: string) => {
    const row = await authDb.workspace.create({
      data: {
        name: "Synthetic RLS workspace",
        members: { create: { userId: owner, role: "owner" } },
      },
    });
    workspaces.push(row.id);
    return row.id;
  };
  const project = async (workspaceId: string, userId: string) => {
    const row = await authDb.project.create({
      data: { workspaceId, name: "Synthetic RLS project" },
    });
    return {
      workspaceId,
      projectId: row.id,
      userId,
      role: "owner",
    } satisfies Scope;
  };
  // A scoped transaction as the chat code runs it (chatScoped sets the user).
  const asScope = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${s.userId}, true)`;
      return fn(tx);
    });
  const visible = (viewer: Scope, table: string, target: Scope) =>
    asScope(viewer, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${table}" WHERE "projectId" = $1::uuid`,
        target.projectId,
      );
      return Number(rows[0]!.n);
    });
  // Runs one statement in its own scoped transaction; a denial aborts only it.
  const attempt = async (viewer: Scope, sql: string, ...params: unknown[]) => {
    try {
      return {
        count: await asScope(viewer, (tx) =>
          tx.$executeRawUnsafe(sql, ...params),
        ),
      };
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) };
    }
  };

  async function seed(s: Scope): Promise<string> {
    return asScope(s, async (tx) => {
      const fileId = randomUUID();
      await tx.fileBlob.create({
        data: {
          key: `projects/${s.projectId}/knowledge/${fileId}`,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          data: Buffer.from([1]),
        },
      });
      await tx.file.create({
        data: {
          id: fileId,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          moduleId: "knowledge",
          key: `projects/${s.projectId}/knowledge/${fileId}`,
          mime: "text/plain",
          size: 1,
          sha256: "0".repeat(64),
          encryption: "aes-256-gcm/v1",
          createdBy: s.userId,
        },
      });
      const source = await create(tx, s, "sources", {
        name: "Synthetic RLS source",
        status: "active",
        generation: 1,
        publicUse: true,
        modelUse: true,
        authority: "official",
        maxAgeHours: 168,
        allowedOrigins: [],
        allowedPaths: ["/"],
      });
      await ingest(tx, s, {
        sourceId: source.id,
        externalId: "rls-guide",
        title: "RLS fixture",
        text: "Synthetic row-level security fixture text.",
        mimeType: "text/plain",
        language: "en",
        expectedGeneration: 1,
      });
      const index = await getActiveIndex(tx, s);
      const chunk = await tx.knowledgeChunk.findFirstOrThrow({
        where: { workspaceId: s.workspaceId, projectId: s.projectId },
      });
      const vector = `[${new Array(index.dimensions).fill(0).join(",")}]`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "ChunkEmbedding" (id, "workspaceId", "projectId", "chunkId", profile, model, dimensions, "indexGeneration", vector)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::vector)`,
        randomUUID(),
        s.workspaceId,
        s.projectId,
        chunk.id,
        index.profile,
        index.model,
        index.dimensions,
        index.generation,
        vector,
      );
      await audit(tx, s, "rls.seed", source.id);
      await enqueue(tx, s, "ingestion", source.id, `rls:${randomUUID()}`);
      // Object links and domain events (ADR 0016).
      await tx.objectLink.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          sourceType: "work.task",
          sourceId: randomUUID(),
          targetType: "support.ticket",
          targetId: randomUUID(),
          relation: "relates_to",
          createdByKind: "system",
        },
      });
      const eventId = randomUUID();
      await tx.domainEvent.create({
        data: {
          id: eventId,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          type: "platform.link.created",
          subjectType: "platform.link",
          subjectId: randomUUID(),
          actorKind: "system",
          origin: "platform",
          correlationId: eventId,
        },
      });
      await tx.budgetReservation.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          key: `rls:${randomUUID()}`,
          amountMicros: 1n,
          category: "rls_test",
          state: "released",
        },
      });
      const runId = randomUUID();
      await tx.agentRun.create({
        data: {
          id: runId,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          kind: "chat",
          agentName: "rls-test",
          taskClass: "chat_operator",
          status: "succeeded",
        },
      });
      await tx.agentSpan.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          runId,
          type: "model_call",
          name: "rls-test",
          status: "succeeded",
          startedAt: new Date(),
          durationMs: 1,
        },
      });
      const profile = await tx.projectMarketingProfile.create({
        data: { workspaceId: s.workspaceId, projectId: s.projectId, data: {} },
      });
      await tx.projectMarketingProfileVersion.create({
        data: {
          profileId: profile.id,
          version: 1,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          data: {},
        },
      });
      await tx.projectModule.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          moduleId: "knowledge",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      const owner = {
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        userId: s.userId,
      };
      await tx.notification.create({
        data: { ...owner, moduleId: "knowledge", kind: "rls_seed", title: "x" },
      });
      await tx.notificationPreference.create({
        data: { ...owner, kind: "rls_seed", inApp: true, email: false },
      });
      const conversation = await tx.chatConversation.create({ data: owner });
      const conversationId = conversation.id;
      await tx.chatMessage.create({
        data: {
          ...owner,
          conversationId,
          sequence: 1,
          role: "user",
          text: "x",
        },
      });
      await tx.chatRun.create({
        data: { ...owner, conversationId, clientRequestId: randomUUID() },
      });
      await tx.chatProposal.create({
        data: {
          ...owner,
          conversationId,
          groupId: randomUUID(),
          version: 1,
          payload: {},
          payloadHash: "rls",
        },
      });
      // The inbox answers from its project's mailbox (a connector entity).
      const mailbox = await tx.entity.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          kind: "connectors",
          data: {
            provider: "email",
            fromAddress: "support@example.invalid",
            status: "read_verified",
          },
        },
      });
      mailboxes.set(s.projectId, mailbox.id);
      const inbox = await tx.supportInbox.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          name: "Synthetic RLS inbox",
          channels: ["email"],
          emailAddress: "support@example.invalid",
          emailConnectionId: mailbox.id,
          createdBy: s.userId,
        },
      });
      const contact = await tx.supportContact.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          email: "customer@example.invalid",
        },
      });
      await tx.supportContactIdentity.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          contactId: contact.id,
          inboxId: inbox.id,
          channel: "widget",
          externalUserId: "rls-user",
        },
      });
      const ticket = await tx.supportTicket.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          number: 1,
          inboxId: inbox.id,
          contactId: contact.id,
          subject: "Synthetic RLS ticket",
          channel: "email",
        },
      });
      const message = await tx.supportMessage.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          ticketId: ticket.id,
          kind: "customer",
          authorContactId: contact.id,
          bodyText: "Synthetic RLS message",
          channel: "email",
          visibleToCustomer: true,
        },
      });
      await tx.supportAttachment.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          messageId: message.id,
          fileId,
          name: "rls.txt",
          mime: "text/plain",
          size: 1,
        },
      });
      await tx.supportTicketCounter.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          lastNumber: 1,
        },
      });
      await tx.supportTicketEvent.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          ticketId: ticket.id,
          type: "created",
          actorKind: "system",
          before: {},
          after: {},
        },
      });
      await seedFinance(tx, s, mailbox.id, fileId);
      await seedWork(tx, s, fileId);
      return inbox.id;
    });
  }

  // One row in every project management table (ADR 0016).
  async function seedWork(tx: DbTx, s: Scope, fileId: string) {
    const row = () => ({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      projectId: s.projectId,
    });
    const initiative = await tx.workInitiative.create({
      data: { ...row(), key: "RLS", title: "Synthetic RLS initiative", createdBy: s.userId },
    });
    workInitiatives.set(s.projectId, initiative.id);
    const milestone = await tx.workMilestone.create({
      data: { ...row(), initiativeId: initiative.id, title: "Synthetic milestone", createdBy: s.userId },
    });
    await tx.workTaskCounter.create({
      data: { workspaceId: s.workspaceId, projectId: s.projectId, lastNumber: 2 },
    });
    const task = (number: number, parentTaskId?: string) =>
      tx.workTask.create({
        data: {
          ...row(),
          number,
          initiativeId: initiative.id,
          milestoneId: milestone.id,
          parentTaskId,
          title: "Synthetic RLS task",
          status: "todo",
          statusCategory: "todo",
          rank: `a${number}`,
          createdBy: s.userId,
        },
      });
    const first = await task(1);
    const second = await task(2, first.id);
    await tx.workChecklistItem.create({
      data: { ...row(), taskId: first.id, text: "Synthetic item" },
    });
    await tx.workTaskDependency.create({
      data: { ...row(), taskId: first.id, dependsOnTaskId: second.id, createdBy: s.userId },
    });
    await tx.workComment.create({
      data: { ...row(), taskId: first.id, authorKind: "user", authorUserId: s.userId, bodyText: "Synthetic comment" },
    });
    await tx.workAttachment.create({
      data: { ...row(), taskId: first.id, fileId, name: "rls.txt", mime: "text/plain", size: 1, addedBy: s.userId },
    });
    await tx.workTaskWatcher.create({
      data: { workspaceId: s.workspaceId, projectId: s.projectId, taskId: first.id, userId: s.userId },
    });
    await tx.workEvent.create({
      data: { ...row(), taskId: first.id, type: "created", actorKind: "user", actorId: s.userId },
    });
  }

  // One row in every finance table, with a balanced posted entry.
  async function seedFinance(
    tx: DbTx,
    s: Scope,
    connectionId: string,
    fileId: string,
  ) {
    const row = () => ({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      projectId: s.projectId,
    });
    const bank = await tx.financeAccount.create({
      data: {
        ...row(),
        code: "1000",
        name: "Bank",
        type: "asset",
        paymentAccount: true,
      },
    });
    financeAccounts.set(s.projectId, bank.id);
    const costs = await tx.financeAccount.create({
      data: { ...row(), code: "6000", name: "Costs", type: "expense" },
    });
    const category = await tx.financeCategory.create({
      data: {
        ...row(),
        name: "Software",
        kind: "expense",
        accountId: costs.id,
      },
    });
    const costCenter = await tx.financeCostCenter.create({
      data: { ...row(), code: "CC1", name: "Synthetic cost center" },
    });
    const counterparty = await tx.financeCounterparty.create({
      data: {
        ...row(),
        name: "Synthetic vendor",
        normalizedName: "synthetic vendor",
        defaultCategoryId: category.id,
      },
    });
    const financeMailbox = await tx.financeMailbox.create({
      data: { ...row(), emailConnectionId: connectionId },
    });
    const document = await tx.financeDocument.create({
      data: {
        ...row(),
        fileId,
        sha256: "c".repeat(64),
        source: "email",
        mailboxId: financeMailbox.id,
        mimeType: "application/pdf",
        status: "booked",
      },
    });
    await tx.financeDocumentRevision.create({
      data: { ...row(), documentId: document.id, version: 1, changes: {} },
    });
    const entry = await tx.financeJournalEntry.create({
      data: {
        ...row(),
        number: "2026-000001",
        entryDate: new Date("2026-10-23"),
        kind: "invoice",
        documentId: document.id,
        postedBy: s.userId,
      },
    });
    const line = (accountId: string, side: string) => ({
      ...row(),
      entryId: entry.id,
      accountId,
      side,
      currency: "USD",
      amountMicros: 1_000_000n,
      fxRate: "1",
      rateDate: new Date("2026-10-23"),
      rateSource: "identity",
      baseAmountMicros: 1_000_000n,
    });
    await tx.financeJournalLine.create({
      data: {
        ...line(costs.id, "debit"),
        categoryId: category.id,
        costCenterId: costCenter.id,
      },
    });
    await tx.financeJournalLine.create({ data: line(bank.id, "credit") });
    await tx.financeEntryCounter.create({
      data: {
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        year: 2026,
        next: 2,
      },
    });
    const recurring = await tx.financeRecurring.create({
      data: {
        ...row(),
        name: "Synthetic subscription",
        counterpartyId: counterparty.id,
        categoryId: category.id,
        interval: "monthly",
        expectedAmountMicros: 1_000_000n,
        currency: "USD",
        nextDueDate: new Date("2026-11-23"),
      },
    });
    const invoice = await tx.financeInvoice.create({
      data: {
        ...row(),
        kind: "invoice",
        direction: "payable",
        counterpartyId: counterparty.id,
        number: "RLS-1",
        issueDate: new Date("2026-10-23"),
        currency: "USD",
        netMicros: 1_000_000n,
        taxMicros: 0n,
        totalMicros: 1_000_000n,
        status: "paid",
        documentId: document.id,
        recurringId: recurring.id,
        entryId: entry.id,
      },
    });
    await tx.financeInvoiceLine.create({
      data: {
        ...row(),
        invoiceId: invoice.id,
        description: "Synthetic line",
        amountMicros: 1_000_000n,
        categoryId: category.id,
      },
    });
    const payment = await tx.financePayment.create({
      data: {
        ...row(),
        date: new Date("2026-10-23"),
        direction: "outgoing",
        accountId: bank.id,
        currency: "USD",
        amountMicros: 1_000_000n,
        counterpartyId: counterparty.id,
      },
    });
    await tx.financePaymentAllocation.create({
      data: {
        ...row(),
        paymentId: payment.id,
        invoiceId: invoice.id,
        amountMicros: 1_000_000n,
        baseMicros: 1_000_000n,
      },
    });
    await tx.financeFxRate.create({
      data: {
        ...row(),
        date: new Date("2026-10-23"),
        currency: "USD",
        perEur: "1.160000",
        source: "ecb",
      },
    });
    await tx.financeExport.create({
      data: {
        ...row(),
        kind: "journal_csv",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-12-31"),
        fileId,
        sha256: "d".repeat(64),
        rowCount: 2,
        createdBy: s.userId,
      },
    });
  }

  beforeAll(async () => {
    tables = await db.$queryRaw<TableInfo[]>`
      SELECT c.relname,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS force,
             has_table_privilege(current_user, c.oid, 'SELECT') AS select,
             has_table_privilege(current_user, c.oid, 'INSERT') AS insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') AS update,
             has_table_privilege(current_user, c.oid, 'DELETE') AS delete
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`;
    const userA = await synthetic(),
      userB = await synthetic();
    const one = await workspace(userA),
      two = await workspace(userB);
    a = await project(one, userA);
    c = await project(one, userA);
    b = await project(two, userB);
    for (const s of [a, b, c]) inboxes.set(s.projectId, await seed(s));
    bEntityId = await asScope(
      b,
      async (tx) =>
        (
          await tx.entity.findFirstOrThrow({
            where: { projectId: b.projectId },
          })
        ).id,
    );
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("classifies every table in the public schema", () => {
    const known = [
      ...SCOPED_TABLES,
      ...TENANCY_TABLES,
      ...AUTH_ONLY_TABLES,
      ...SYSTEM_TABLES,
      ...GRANTED_READ_TABLES,
      ...COUNTER_TABLES,
    ].sort();
    expect(tables.map((t) => t.relname).sort()).toEqual(known);
  });

  it("forces row-level security on every scoped and tenancy table", () => {
    for (const name of [
      ...SCOPED_TABLES,
      ...TENANCY_TABLES,
      ...GRANTED_READ_TABLES,
      ...COUNTER_TABLES,
    ]) {
      const t = tables.find((x) => x.relname === name)!;
      expect({ name, rls: t.rls, force: t.force }).toEqual({
        name,
        rls: true,
        force: true,
      });
    }
  });

  it("grants the business role nothing on auth, membership and system tables", () => {
    for (const name of NO_APP_ACCESS) {
      const t = tables.find((x) => x.relname === name)!;
      expect({
        name,
        select: t.select,
        insert: t.insert,
        update: t.update,
        delete: t.delete,
      }).toEqual({
        name,
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
    }
  });

  it("keeps the audit log append-only and Project read/update-only", () => {
    const auditTable = tables.find((x) => x.relname === "AuditEvent")!;
    expect([
      auditTable.select,
      auditTable.insert,
      auditTable.update,
      auditTable.delete,
    ]).toEqual([true, true, false, false]);
    const projectTable = tables.find((x) => x.relname === "Project")!;
    expect([
      projectTable.select,
      projectTable.insert,
      projectTable.update,
      projectTable.delete,
    ]).toEqual([true, false, true, false]);
  });

  it("lets the business role only read granted connections and keep spend counters (ADR 0014)", () => {
    for (const name of GRANTED_READ_TABLES) {
      const t = tables.find((x) => x.relname === name)!;
      expect({ name, grants: [t.select, t.insert, t.update, t.delete] }).toEqual(
        { name, grants: [true, false, false, false] },
      );
    }
    const counter = tables.find((x) => x.relname === "SpendCounter")!;
    expect([counter.select, counter.insert, counter.update, counter.delete]).toEqual(
      [true, true, true, false],
    );
  });

  it("keeps the system audit log append-only for the auth role", async () => {
    const [grants] = await authDb.$queryRaw<
      { select: boolean; insert: boolean; update: boolean; delete: boolean }[]
    >`SELECT has_table_privilege(current_user, '"SystemAuditEvent"', 'SELECT') AS select,
             has_table_privilege(current_user, '"SystemAuditEvent"', 'INSERT') AS insert,
             has_table_privilege(current_user, '"SystemAuditEvent"', 'UPDATE') AS update,
             has_table_privilege(current_user, '"SystemAuditEvent"', 'DELETE') AS delete`;
    expect(grants).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
  });

  it("grants every scoped table full access except the listed restrictions", () => {
    for (const name of SCOPED_TABLES) {
      const t = tables.find((x) => x.relname === name)!;
      expect({
        name,
        grants: [t.select, t.insert, t.update, t.delete],
      }).toEqual({
        name,
        grants: RESTRICTED_GRANTS[name] ?? [true, true, true, true],
      });
    }
  });

  it("shows no row of any readable table without a project scope", async () => {
    for (const t of tables.filter((x) => x.select)) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${t.relname}"`,
      );
      expect({ table: t.relname, rows: Number(rows[0]!.n) }).toEqual({
        table: t.relname,
        rows: 0,
      });
    }
  });

  it("shows each project its own seeded rows in every scoped table", async () => {
    for (const s of [a, b, c])
      for (const table of SCOPED_TABLES)
        expect({ table, rows: (await visible(s, table, s)) > 0 }).toEqual({
          table,
          rows: true,
        });
  });

  it("hides other projects' rows, in the same and in another workspace", async () => {
    for (const [viewer, target] of [
      [a, b],
      [a, c],
      [b, a],
      [c, a],
    ] as const)
      for (const table of SCOPED_TABLES)
        expect({ table, rows: await visible(viewer, table, target) }).toEqual({
          table,
          rows: 0,
        });
    const projects = await asScope(a, (tx) =>
      tx.project.count({ where: { id: { in: [b.projectId, c.projectId] } } }),
    );
    expect(projects).toBe(0);
  });

  it("hides chat rows from another user of the same project", async () => {
    const stranger = { ...a, userId: randomUUID() };
    for (const table of CHAT_TABLES)
      expect({ table, rows: await visible(stranger, table, a) }).toEqual({
        table,
        rows: 0,
      });
  });

  it("cannot update or delete another project's rows", async () => {
    for (const table of SCOPED_TABLES) {
      const t = tables.find((x) => x.relname === table)!;
      for (const [verb, sql] of [
        [
          "update",
          `UPDATE "${table}" SET "projectId" = "projectId" WHERE "projectId" = $1::uuid`,
        ],
        ["delete", `DELETE FROM "${table}" WHERE "projectId" = $1::uuid`],
      ] as const) {
        const result = await attempt(a, sql, b.projectId);
        if (t[verb])
          expect({ table, verb, result }).toEqual({
            table,
            verb,
            result: { count: 0 },
          });
        else
          expect({
            table,
            verb,
            denied: /permission denied/.test(result.error ?? ""),
          }).toEqual({ table, verb, denied: true });
      }
    }
    // The other project's rows are all still there.
    for (const table of SCOPED_TABLES)
      expect({ table, rows: (await visible(b, table, b)) > 0 }).toEqual({
        table,
        rows: true,
      });
  });

  it("cannot insert rows into another project", async () => {
    const statements: [string, string, unknown[]][] = [
      [
        "Entity",
        `INSERT INTO "Entity" (id, "workspaceId", "projectId", kind, data, "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'missions', '{}', now())`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "Outbox",
        `INSERT INTO "Outbox" (id, "workspaceId", "projectId", topic, "entityId", payload) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ingestion', $4::uuid, '{}')`,
        [randomUUID(), b.workspaceId, b.projectId, bEntityId],
      ],
      [
        "AuditEvent",
        `INSERT INTO "AuditEvent" (id, "workspaceId", "projectId", "actorId", action, "resourceId", metadata) VALUES ($1::uuid, $2::uuid, $3::uuid, 'rls', 'rls.cross', 'x', '{}')`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "BudgetReservation",
        `INSERT INTO "BudgetReservation" (id, "workspaceId", "projectId", key, "amountMicros", category, state) VALUES ($1::uuid, $2::uuid, $3::uuid, $1, 1, 'rls_test', 'released')`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "FileBlob",
        `INSERT INTO "FileBlob" (key, "workspaceId", "projectId", data) VALUES ($3, $1::uuid, $2::uuid, '\\x01')`,
        [b.workspaceId, b.projectId, `projects/${b.projectId}/knowledge/x`],
      ],
      [
        "File",
        `INSERT INTO "File" (id, "workspaceId", "projectId", "moduleId", key, mime, size, sha256, encryption, "createdBy") VALUES ($1::uuid, $2::uuid, $3::uuid, 'knowledge', $1, 'text/plain', 1, repeat('0', 64), 'aes-256-gcm/v1', 'rls')`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "SupportTicket",
        `INSERT INTO "SupportTicket" (id, "workspaceId", "projectId", number, "inboxId", "contactId", subject, channel, "updatedAt") SELECT $1::uuid, $2::uuid, $3::uuid, 99, $4::uuid, $1::uuid, 'x', 'email', now()`,
        [randomUUID(), b.workspaceId, b.projectId, inboxes.get(b.projectId)],
      ],
      [
        "FinanceAccount",
        `INSERT INTO "FinanceAccount" (id, "workspaceId", "projectId", code, name, type) VALUES ($1::uuid, $2::uuid, $3::uuid, 'X1', 'x', 'asset')`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "FinanceJournalEntry",
        `INSERT INTO "FinanceJournalEntry" (id, "workspaceId", "projectId", number, "entryDate", kind, "postedBy") VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-000099', '2026-10-23', 'expense', 'rls')`,
        [randomUUID(), b.workspaceId, b.projectId],
      ],
      [
        "ChatConversation",
        `INSERT INTO "ChatConversation" (id, "workspaceId", "projectId", "userId", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
        [randomUUID(), b.workspaceId, b.projectId, a.userId],
      ],
    ];
    for (const [table, sql, params] of statements) {
      const result = await attempt(a, sql, ...params);
      expect({
        table,
        error: /row-level security policy/.test(result.error ?? "")
          ? "rls"
          : (result.error ?? "inserted"),
      }).toEqual({
        table,
        error: "rls",
      });
    }
  });

  it("keeps support references inside one project, even past RLS", async () => {
    // Foreign key checks bypass row-level security, so the same-project
    // composite keys are what stop a ticket of A pointing at B's inbox.
    const result = await attempt(
      a,
      `INSERT INTO "SupportTicket" (id, "workspaceId", "projectId", number, "inboxId", "contactId", subject, channel, "updatedAt")
       SELECT $1::uuid, $2::uuid, $3::uuid, 98, $4::uuid, c.id, 'x', 'email', now()
         FROM "SupportContact" c WHERE c."projectId" = $3::uuid LIMIT 1`,
      randomUUID(),
      a.workspaceId,
      a.projectId,
      inboxes.get(b.projectId),
    );
    expect(result.error ?? "inserted").toMatch(/foreign key/);
    // Nor can an inbox of A answer from B's mailbox.
    const bound = await attempt(
      a,
      `UPDATE "SupportInbox" SET "emailConnectionId" = $1::uuid WHERE id = $2::uuid`,
      mailboxes.get(b.projectId),
      inboxes.get(a.projectId),
    );
    expect(bound.error ?? "updated").toMatch(/foreign key/);
  });

  it("keeps finance references inside one project, even past RLS", async () => {
    // A payment of A cannot be booked against B's bank account.
    const result = await attempt(
      a,
      `INSERT INTO "FinancePayment" (id, "workspaceId", "projectId", date, direction, "accountId", currency, "amountMicros")
       VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-10-23', 'outgoing', $4::uuid, 'USD', 1)`,
      randomUUID(),
      a.workspaceId,
      a.projectId,
      financeAccounts.get(b.projectId),
    );
    expect(result.error ?? "inserted").toMatch(/foreign key/);
  });

  it("keeps work references inside one project, even past RLS", async () => {
    // A task of A cannot belong to B's initiative.
    const result = await attempt(
      a,
      `INSERT INTO "WorkTask" (id, "workspaceId", "projectId", number, "initiativeId", title, status, "statusCategory", rank, "createdBy")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 99, $4::uuid, 'x', 'todo', 'todo', 'a', 'rls')`,
      randomUUID(),
      a.workspaceId,
      a.projectId,
      workInitiatives.get(b.projectId),
    );
    expect(result.error ?? "inserted").toMatch(/foreign key/);
  });

  it("deletes a project together with its support and finance rows", async () => {
    const owner = await synthetic();
    const doomed = await project(await workspace(owner), owner);
    await seed(doomed);
    await authDb.project.delete({ where: { id: doomed.projectId } });
    for (const table of PROJECT_TABLES.filter(
      (t) =>
        t.startsWith("Support") ||
        t.startsWith("Finance") ||
        t.startsWith("Work"),
    ))
      expect({ table, rows: await visible(doomed, table, doomed) }).toEqual({
        table,
        rows: 0,
      });
  });
});
