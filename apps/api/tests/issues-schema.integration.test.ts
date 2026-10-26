import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { createIssuesProject } from "./support/issues-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// The issue center's tables (WP3.2): database rules the services rely on.
describe.skipIf(!enabled)("issue center schema (ADR 0018)", () => {
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const ids = () => ({ id: randomUUID(), workspaceId: p.owner.workspaceId, projectId: p.owner.projectId });
  const issue = (tx: DbTx, number: number, data: Record<string, unknown> = {}) =>
    tx.issue.create({ data: { ...ids(), number, title: "Checkout button fails", createdBy: p.owner.userId, ...data } });
  const report = (tx: DbTx, issueId: string, data: Record<string, unknown> = {}) =>
    tx.issueReport.create({
      data: {
        ...ids(),
        issueId,
        sourceKind: "webhook",
        title: "Checkout fails",
        symptoms: "The button does nothing",
        occurredAt: new Date(),
        reportedByKind: "integration",
        ...data,
      },
    });

  beforeAll(async () => {
    p = await createIssuesProject();
  });
  afterAll(async () => {
    await p?.cleanup();
    await closeDatabase();
  });

  it("indexes title, summary and components for full-text search", async () => {
    const rows = await p.run(async (tx) => {
      const row = await issue(tx, 1, { summary: "Payment page freezes", components: ["checkout_flow"] });
      return tx.$queryRaw<{ title: boolean; summary: boolean; component: boolean }[]>`
        SELECT "searchVector" @@ to_tsquery('simple', 'checkout') AS title,
               "searchVector" @@ to_tsquery('simple', 'freezes') AS summary,
               "searchVector" @@ to_tsquery('simple', 'checkout_flow') AS component
        FROM "Issue" WHERE id = ${row.id}::uuid`;
    });
    expect(rows).toEqual([{ title: true, summary: true, component: true }]);
  });

  it("refuses a re-delivered external report but allows reports without a reference", async () => {
    const message = await p.run(async (tx) => {
      const row = await issue(tx, 2);
      await report(tx, row.id);
      await report(tx, row.id);
      await report(tx, row.id, { externalSystem: "n8n", externalId: "evt-1" });
      return report(tx, row.id, { externalSystem: "n8n", externalId: "evt-1" });
    }).then(() => "resolved", (e: Error) => e.message);
    expect(message).toMatch(/IssueReport_external_key|Unique constraint/);
  });

  it("marks a duplicate only together with the issue it was merged into", async () => {
    const outcome = await p.run(async (tx) => {
      const target = await issue(tx, 3);
      const source = await issue(tx, 4);
      const withoutTarget = await failure(
        tx.$executeRaw`SAVEPOINT a`.then(() =>
          tx.$executeRawUnsafe(`UPDATE "Issue" SET status = 'duplicate' WHERE id = '${source.id}'`),
        ),
      );
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT a`;
      const toItself = await failure(
        tx.$executeRaw`SAVEPOINT b`.then(() =>
          tx.$executeRawUnsafe(
            `UPDATE "Issue" SET status = 'duplicate', "mergedIntoIssueId" = id WHERE id = '${source.id}'`,
          ),
        ),
      );
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT b`;
      await tx.issue.update({ where: { id: source.id }, data: { status: "duplicate", mergedIntoIssueId: target.id } });
      return { withoutTarget, toItself };
    });
    expect(outcome.withoutTarget).toMatch(/Issue_merged_check/);
    expect(outcome.toItself).toMatch(/Issue_merged_check/);
  });

  it("deletes reports, history and deliveries with their issue, and duplicates with their target", async () => {
    const left = await p.run(async (tx) => {
      const target = await issue(tx, 5);
      const source = await issue(tx, 6, {});
      await tx.issue.update({ where: { id: source.id }, data: { status: "duplicate", mergedIntoIssueId: target.id } });
      await report(tx, target.id);
      await tx.issueEvent.create({ data: { ...ids(), issueId: target.id, type: "created", actorKind: "system" } });
      await tx.issueDelivery.create({
        data: { ...ids(), issueId: target.id, kind: "deployed", environment: "production", source: "manual", observedAt: new Date() },
      });
      await tx.issue.delete({ where: { id: target.id } });
      return {
        issues: await tx.issue.count({ where: { id: { in: [target.id, source.id] } } }),
        reports: await tx.issueReport.count({ where: { issueId: target.id } }),
        events: await tx.issueEvent.count({ where: { issueId: target.id } }),
        deliveries: await tx.issueDelivery.count({ where: { issueId: target.id } }),
      };
    });
    expect(left).toEqual({ issues: 0, reports: 0, events: 0, deliveries: 0 });
  });

  it("requires an environment for a deployment record", async () => {
    const message = await p
      .run(async (tx) => {
        const row = await issue(tx, 7);
        return tx.issueDelivery.create({
          data: { ...ids(), issueId: row.id, kind: "deployed", source: "manual", observedAt: new Date() },
        });
      })
      .then(() => "resolved", (e: Error) => e.message);
    expect(message).toMatch(/IssueDelivery_deployed_check/);
  });
});
