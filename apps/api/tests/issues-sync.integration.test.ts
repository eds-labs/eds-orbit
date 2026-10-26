import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { updateTask } from "../src/modules/work/tasks.ts";
import { userActor as workActor } from "../src/modules/work/common.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { reportTicketAsIssue } from "../src/modules/support/issues-handoff.ts";
import { setIssueStatus } from "../src/modules/issues/issues.ts";
import { SYNC_ORIGIN, userActor } from "../src/modules/issues/common.ts";
import { reportManually } from "../src/modules/issues/sources/manual.ts";
import { createTaskFromIssue } from "../src/modules/issues/tasks.ts";
import { recordDelivery, releasesView } from "../src/modules/issues/deliveries.ts";
import { SYNC_RULES, syncSubscriber } from "../src/modules/issues/sync.ts";
import { issuesAttention } from "../src/modules/issues/attention.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createIssuesProject, withEnv } from "./support/issues-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

describe("issue sync rules (ADR 0018 I-4)", () => {
  it("never lets a rule write the object type of its own trigger", () => {
    const objectOf = (type: string) => type.split(".").slice(0, 2).join(".");
    for (const rule of SYNC_RULES) expect({ rule: rule.id, same: objectOf(rule.trigger) === rule.writes }).toEqual({ rule: rule.id, same: false });
    expect(SYNC_RULES.map((r) => r.id)).toEqual(expect.arrayContaining(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]));
  });
});

describe.skipIf(!enabled)("issue sync with tasks, deliveries and Support (WP3.9, WP3.11)", () => {
  const env = withEnv({ ORBIT_ISSUES: "true", ORBIT_WORK: "true", ORBIT_SUPPORT: "true" });
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let inboxId = "";
  const status = (id: string) => p.run((tx) => tx.issue.findUniqueOrThrow({ where: { id } })).then((i) => i.status);
  const version = (id: string) => p.run((tx) => tx.issue.findUniqueOrThrow({ where: { id } })).then((i) => i.version);
  const confirmedIssue = async (title: string) => {
    const created = await p.run((tx) => reportManually(tx, p.editor, { title }, userActor(p.editor)));
    const expected = await version(created.issueId);
    await p.run((tx) => setIssueStatus(tx, p.editor, created.issueId, { status: "confirmed", expectedVersion: expected }, userActor(p.editor)));
    return created.issueId;
  };
  const moveTask = async (taskId: string, to: string) => {
    const task = await p.run((tx) => tx.workTask.findUniqueOrThrow({ where: { id: taskId } }));
    await p.run((tx) => updateTask(tx, p.editor, taskId, { expectedVersion: task.version, status: to }, workActor(p.editor)));
  };
  const statusEvents = (issueId: string) =>
    p.run((tx) => tx.issueEvent.count({ where: { issueId, type: "status" } }));

  beforeAll(async () => {
    env.apply();
    p = await createIssuesProject({ modules: ["issues", "work", "support"] });
    inboxId = await p.run(async (tx) =>
      (await createMailInbox(tx, p.owner, { name: "Mail", channels: ["email"], emailAddress: "sync@example.invalid" })).inbox.id,
    );
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("runs the chain task done → fix ready → production → released → Support note once", async () => {
    const ticket = await p.run((tx) =>
      createTicket(tx, p.owner, {
        inboxId,
        channel: "email",
        inbound: { externalId: `<${randomUUID()}@mail.example.invalid>`, contact: { email: "c@example.invalid", name: "C" }, subject: "Export", bodyText: "Export breaks.", attachments: [] },
      }),
    );
    const { issueId } = await p.run((tx) => reportTicketAsIssue(tx, p.editor, ticket.ticketId, { title: "Export breaks" }));
    const expected = await version(issueId);
    await p.run((tx) => setIssueStatus(tx, p.editor, issueId, { status: "confirmed", expectedVersion: expected }, userActor(p.editor)));
    // Tasks need a confirmed issue.
    const { taskId } = await p.run((tx) => createTaskFromIssue(tx, p.editor, issueId, {}, userActor(p.editor)));
    const task = await p.run((tx) => tx.workTask.findUniqueOrThrow({ where: { id: taskId } }));
    expect(task).toMatchObject({ source: "issue" });
    expect(task.title).toMatch(/^ISS-\d+: Export breaks$/);
    await p.deliverEvents();
    expect(await status(issueId)).toBe("planned");
    await moveTask(taskId, "in_progress");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("in_progress");
    await moveTask(taskId, "done");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("fix_ready");
    // Merged and staging deployments release nothing.
    await p.run((tx) => recordDelivery(tx, p.editor, issueId, { kind: "pr_merged", repository: "eds-labs/orbit", prNumber: 12 }, userActor(p.editor)));
    await p.run((tx) => recordDelivery(tx, p.editor, issueId, { kind: "deployed", environment: "staging" }, userActor(p.editor)));
    await p.deliverEvents();
    expect(await status(issueId)).toBe("fix_ready");
    const releases = await p.run((tx) => releasesView(tx, p.viewer));
    expect(releases.items.find((i) => i.id === issueId)).toMatchObject({ merged: true, deployments: [expect.objectContaining({ environment: "staging" })] });
    await p.run((tx) => recordDelivery(tx, p.editor, issueId, { kind: "deployed", environment: "production", commitSha: "abc1234" }, userActor(p.editor)));
    await p.deliverEvents();
    expect(await status(issueId)).toBe("released");
    const notes = () =>
      p.run((tx) => tx.supportMessage.count({ where: { ticketId: ticket.ticketId, kind: "system", bodyText: { contains: "Fix released" } } }));
    expect(await notes()).toBe(1);
    // Replaying every event changes nothing.
    const before = await statusEvents(issueId);
    await p.run(async (tx) => {
      const done = await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" } });
      for (const job of done)
        if ((job.data as { topic?: string }).topic === "domain_event")
          await tx.entity.update({ where: { id: job.id }, data: { data: { ...(job.data as object), status: "queued" } } });
    });
    await p.deliverEvents(1);
    expect(await statusEvents(issueId)).toBe(before);
    expect(await notes()).toBe(1);
    // A person verifies the release.
    await p.run((tx) => recordDelivery(tx, p.editor, issueId, { kind: "verified" }, userActor(p.editor)));
    expect(await status(issueId)).toBe("verified");
  });

  it("takes a fix-ready issue back when a done task is reopened (S7), and only forward otherwise", async () => {
    const issueId = await confirmedIssue("Search crashes");
    const { taskId } = await p.run((tx) => createTaskFromIssue(tx, p.editor, issueId, {}, userActor(p.editor)));
    await moveTask(taskId, "done");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("fix_ready");
    await moveTask(taskId, "todo");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("in_progress");
    // A second, untouched task keeps the issue from fix ready.
    const second = await p.run((tx) => createTaskFromIssue(tx, p.editor, issueId, {}, userActor(p.editor)));
    await moveTask(taskId, "done");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("in_progress");
    await moveTask(second.taskId, "canceled");
    await p.deliverEvents();
    expect(await status(issueId)).toBe("fix_ready");
  });

  it("ignores its own writes and settles a random event storm in a bounded number of jobs", async () => {
    const issueId = await confirmedIssue("Payment flaky");
    const own = await p.run((tx) =>
      syncSubscriber.handler(tx, p.owner, {
        id: randomUUID(),
        type: "work.task.status_changed",
        version: 1,
        subject: { type: "work.task", id: randomUUID() },
        actor: { kind: "system", id: null },
        origin: SYNC_ORIGIN,
        causationId: null,
        correlationId: randomUUID(),
        depth: 0,
        data: { fromCategory: "done", toCategory: "todo" },
        createdAt: new Date(),
      }),
    );
    expect(own).toBeUndefined();
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push((await p.run((tx) => createTaskFromIssue(tx, p.editor, issueId, {}, userActor(p.editor)))).taskId);
    const statuses = ["todo", "in_progress", "in_review", "blocked", "done", "backlog"];
    let seed = 42;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 60; i++) await moveTask(tasks[random(3)]!, statuses[random(statuses.length)]!);
    for (const t of tasks) await moveTask(t, "done");
    const jobs = await p.deliverEvents(20);
    // Each task change and status move is a handful of jobs, never a loop.
    expect(jobs).toBeLessThan(600);
    expect(await status(issueId)).toBe("fix_ready");
    expect(await p.deliverEvents()).toBe(0);
  });

  it("shows a closed issue with open tasks as attention (S6) and changes no task", async () => {
    const issueId = await confirmedIssue("Old layout bug");
    const { taskId } = await p.run((tx) => createTaskFromIssue(tx, p.editor, issueId, {}, userActor(p.editor)));
    await p.deliverEvents();
    const expected = await version(issueId);
    await p.run((tx) => setIssueStatus(tx, p.editor, issueId, { status: "wont_fix", expectedVersion: expected }, userActor(p.editor)));
    await p.deliverEvents();
    const items = await p.run((tx) => issuesAttention(tx, p.editor, new Date()));
    expect(items.find((i) => i.kind === "issues_closed_open_tasks")).toMatchObject({ count: expect.any(Number) });
    const task = await p.run((tx) => tx.workTask.findUniqueOrThrow({ where: { id: taskId } }));
    expect(task.statusCategory).toBe("todo");
  });
});
