import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { eraseContact } from "../src/modules/support/privacy.ts";
import { supportAttention } from "../src/modules/support/attention.ts";
import { previewIssueReport, reportTicketAsIssue, ticketIssues } from "../src/modules/support/issues-handoff.ts";
import { autoMoveIssue, setIssueStatus } from "../src/modules/issues/issues.ts";
import { issueDetail } from "../src/modules/issues/queries.ts";
import { syncActor, userActor } from "../src/modules/issues/common.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createIssuesProject, withEnv } from "./support/issues-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// The customer's identity: none of it may reach an issue row, its history,
// audits or domain events (privacy canary, plan §8).
const NAME = "Annegret Vollmerhaus";
const EMAIL = "annegret.vollmerhaus@example.org";
const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";

describe.skipIf(!enabled)("Support hand-in to the issue center (WP3.6)", () => {
  const env = withEnv({ ORBIT_ISSUES: "true", ORBIT_SUPPORT: "true", ORBIT_WORK: "true" });
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let inboxId = "";
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const ticket = (body: string, subject = "Withdrawal fails") =>
    p.run((tx) =>
      createTicket(tx, p.owner, {
        inboxId,
        channel: "email",
        inbound: {
          externalId: `<${randomUUID()}@mail.example.invalid>`,
          contact: { email: EMAIL, name: NAME },
          subject,
          bodyText: body,
          attachments: [],
        },
      }),
    );

  beforeAll(async () => {
    env.apply();
    p = await createIssuesProject({ modules: ["issues", "support", "work"] });
    inboxId = await p.run(async (tx) =>
      (await createMailInbox(tx, p.owner, { name: "Mail", channels: ["email"], emailAddress: "support@example.invalid" })).inbox.id,
    );
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("previews the selected messages with the customer's identity removed", async () => {
    const created = await ticket(`Hi, I am ${NAME}. My withdrawal to ${WALLET} fails. Reach me at ${EMAIL}.`);
    const message = await p.run((tx) => tx.supportMessage.findFirstOrThrow({ where: { ticketId: created.ticketId } }));
    const preview = await p.run((tx) => previewIssueReport(tx, p.editor, created.ticketId, { messageIds: [message.id] }));
    expect(preview.symptoms).not.toMatch(/Annegret|Vollmerhaus|annegret|0x52908/);
    expect(preview.symptoms).toContain("[customer name]");
    expect(preview.redaction).toMatchObject({ wallet: 1 });
    expect(preview.sensitive).toEqual([]);
  });

  it("hands a ticket in as a report linked to it, without customer data in issue rows", async () => {
    const created = await ticket(`Withdrawal fails for ${NAME}.`);
    const result = await p.run((tx) =>
      reportTicketAsIssue(tx, p.editor, created.ticketId, {
        title: `Withdrawal fails for ${NAME}`,
        symptoms: `${NAME} (${EMAIL}) cannot withdraw to ${WALLET}.`,
      }),
    );
    const detail = await p.run((tx) => issueDetail(tx, p.editor, result.issueId));
    expect(detail.issue).toMatchObject({ reportCount: 1, ticketCount: 1, status: "new" });
    expect(detail.reports[0]).toMatchObject({ sourceKind: "support", externalId: null });
    expect(detail.links).toEqual([
      expect.objectContaining({ relation: "reported_in", object: expect.objectContaining({ type: "support.ticket", state: "ok" }) }),
    ]);
    // Reporting the same ticket again changes nothing.
    const again = await p.run((tx) => reportTicketAsIssue(tx, p.editor, created.ticketId, { title: "Withdrawal fails" }));
    expect(again.issueId).toBe(result.issueId);
    expect((await p.run((tx) => issueDetail(tx, p.editor, result.issueId))).issue.reportCount).toBe(1);
    // The ticket sees its issue; it is unchanged otherwise.
    const issues = await p.run((tx) => ticketIssues(tx, p.editor, created.ticketId));
    expect(issues.map((l) => l.object.id)).toEqual([result.issueId]);
    const rows = await p.run(async (tx) =>
      JSON.stringify([
        await tx.issue.findMany({ where: { projectId: p.owner.projectId } }),
        await tx.issueReport.findMany({ where: { projectId: p.owner.projectId } }),
        await tx.issueEvent.findMany({ where: { projectId: p.owner.projectId } }),
        await tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: { startsWith: "issues." } } }),
        await tx.domainEvent.findMany({ where: { projectId: p.owner.projectId } }),
      ]),
    );
    for (const secret of ["Annegret", "Vollmerhaus", EMAIL, WALLET.slice(2, 12)]) expect(rows).not.toContain(secret);
  });

  it("needs an acknowledgement for sensitive tickets and the issues permission", async () => {
    const created = await ticket("I will take legal action and talk to my lawyer if this is not fixed.");
    expect(await failure(p.run((tx) => reportTicketAsIssue(tx, p.editor, created.ticketId, { title: "Payout delayed" })))).toBe(
      "SUPPORT_ISSUE_SENSITIVE_ACK_REQUIRED",
    );
    const ok = await p.run((tx) =>
      reportTicketAsIssue(tx, p.editor, created.ticketId, { title: "Payout delayed", acknowledgeSensitive: true }),
    );
    expect(ok.issueId).toBeTruthy();
    // A viewer may read tickets in Support but not report issues.
    const other = await ticket("Another problem");
    expect(await failure(p.run((tx) => reportTicketAsIssue(tx, p.viewer, other.ticketId, { title: "x" })))).toBe("FORBIDDEN");
  });

  it("leaves an internal note and an attention item when the fix is released, never a customer message", async () => {
    const created = await ticket("The export button does nothing.");
    const { issueId } = await p.run((tx) => reportTicketAsIssue(tx, p.editor, created.ticketId, { title: "Export button does nothing" }));
    await p.run(async (tx) => {
      const issue = await setIssueStatus(tx, p.editor, issueId, { status: "confirmed", expectedVersion: 2 }, userActor(p.editor));
      expect(issue.status).toBe("confirmed");
      expect(await autoMoveIssue(tx, p.owner, issueId, "fix_ready", syncActor)).toBe(true);
      expect(await autoMoveIssue(tx, p.owner, issueId, "released", syncActor)).toBe(true);
    });
    await p.deliverEvents();
    const messages = await p.run((tx) =>
      tx.supportMessage.findMany({ where: { ticketId: created.ticketId }, orderBy: { createdAt: "asc" } }),
    );
    const note = messages.find((m) => m.kind === "system" && m.bodyText.includes("Fix released"));
    expect(note).toMatchObject({ visibleToCustomer: false, channel: "internal" });
    expect(messages.filter((m) => m.visibleToCustomer && m.kind !== "customer")).toEqual([]);
    const items = await p.run((tx) => supportAttention(tx, p.editor, new Date()));
    expect(items.find((i) => i.kind === "support_issue_released")).toMatchObject({ count: 1 });
    // A second delivery of the same event adds nothing.
    await p.deliverEvents();
    const notes = await p.run((tx) => tx.supportMessage.count({ where: { ticketId: created.ticketId, kind: "system", bodyText: { contains: "Fix released" } } }));
    expect(notes).toBe(1);
  });

  it("removes the reports' texts when Support erases the contact", async () => {
    const created = await ticket("Card payment fails at step 3.");
    const { issueId } = await p.run((tx) =>
      reportTicketAsIssue(tx, p.editor, created.ticketId, { title: "Card payment fails", symptoms: "Fails at step 3 for this customer." }),
    );
    const contactId = created.contactId;
    await eraseContact(p.owner, contactId);
    await p.deliverEvents();
    const reports = await p.run((tx) => tx.issueReport.findMany({ where: { projectId: p.owner.projectId, externalSystem: "orbit_support" } }));
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.erasedAt && r.symptoms === "[removed on erasure]")).toBe(true);
    const issue = await p.run((tx) => tx.issue.findFirstOrThrow({ where: { id: issueId } }));
    expect(issue.title).toMatch(/removed on erasure/);
    expect(issue.summary).toBeNull();
  });
});
