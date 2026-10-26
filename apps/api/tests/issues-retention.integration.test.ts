import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { userActor } from "../src/modules/issues/common.ts";
import { setIssueStatus } from "../src/modules/issues/issues.ts";
import { issuesRetention } from "../src/modules/issues/retention.ts";
import { reportManually } from "../src/modules/issues/sources/manual.ts";
import { createIssuesProject, withEnv } from "./support/issues-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const MONTH = 30 * 86_400_000;

/** Retention (Q-P3-5): closed issues after 36 months, diagnostics after 12. */
describe.skipIf(!enabled)("issue center retention (WP3.15)", () => {
  const env = withEnv({ ORBIT_ISSUES: "true" });
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  beforeAll(async () => {
    env.apply();
    p = await createIssuesProject();
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("deletes old closed issues with their reports and empties old diagnostics", async () => {
    const closed = await p.run((tx) => reportManually(tx, p.editor, { title: "Old closed" }, userActor(p.editor)));
    const open = await p.run((tx) => reportManually(tx, p.editor, { title: "Still open" }, userActor(p.editor)));
    await p.run(async (tx) => {
      let row = await tx.issue.findUniqueOrThrow({ where: { id: closed.issueId } });
      row = await setIssueStatus(tx, p.editor, row.id, { status: "wont_fix", expectedVersion: row.version }, userActor(p.editor));
      await setIssueStatus(tx, p.editor, row.id, { status: "closed", expectedVersion: row.version }, userActor(p.editor));
      await tx.issue.update({ where: { id: closed.issueId }, data: { closedAt: new Date(Date.now() - 37 * MONTH) } });
      await tx.issueReport.updateMany({
        where: { issueId: open.issueId },
        data: { diagnostics: { code: 500 }, receivedAt: new Date(Date.now() - 13 * MONTH) },
      });
    });
    expect(await issuesRetention(p.owner)).toEqual({ issues: 1, diagnostics: 1 });
    const left = await p.run(async (tx) => ({
      closed: await tx.issue.count({ where: { id: closed.issueId } }),
      reports: await tx.issueReport.count({ where: { issueId: closed.issueId } }),
      open: await tx.issueReport.findFirstOrThrow({ where: { issueId: open.issueId } }),
    }));
    expect(left.closed).toBe(0);
    expect(left.reports).toBe(0);
    expect(left.open.diagnostics).toEqual({});
    // Nothing more on a second run.
    expect(await issuesRetention(p.owner)).toEqual({ issues: 0, diagnostics: 0 });
  });
});
