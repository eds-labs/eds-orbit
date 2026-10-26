import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { createLink, linksOf } from "../src/platform/links/links.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import { userActor as workActor } from "../src/modules/work/common.ts";
import {
  autoMoveIssue,
  createIssue,
  setIssueStatus,
  setShareReview,
  shareableFields,
  updateIssue,
} from "../src/modules/issues/issues.ts";
import { attachReport } from "../src/modules/issues/reports.ts";
import { mergeIssue } from "../src/modules/issues/merge.ts";
import { issueDetail, listIssues } from "../src/modules/issues/queries.ts";
import { issuesOverview } from "../src/modules/issues/stats.ts";
import { saveIssuesSettings, defaultIssuesSettings } from "../src/modules/issues/settings.ts";
import { syncActor, userActor } from "../src/modules/issues/common.ts";
import { TRANSITIONS, autoMoveAllowed, ISSUE_STATUSES } from "../src/modules/issues/status.ts";
import { createIssuesProject, withEnv } from "./support/issues-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// A marker in every text: the content-free tests look for it in history,
// audits and domain events. The e-mail address must never be stored.
const SECRET = "Geheimprojekt-7f3a";
const EMAIL = "kunde.mueller@example.org";

describe("issue status machine (ADR 0018 I-6)", () => {
  it("lets automatic rules only move forward, with the fix-ready reopen as the one exception", () => {
    expect(autoMoveAllowed("planned", "in_progress")).toBe(true);
    expect(autoMoveAllowed("confirmed", "fix_ready")).toBe(true);
    expect(autoMoveAllowed("fix_ready", "released")).toBe(true);
    expect(autoMoveAllowed("in_progress", "planned")).toBe(false);
    expect(autoMoveAllowed("released", "fix_ready")).toBe(false);
    expect(autoMoveAllowed("triage", "planned")).toBe(false);
    expect(autoMoveAllowed("wont_fix", "in_progress")).toBe(false);
    expect(autoMoveAllowed("fix_ready", "in_progress")).toBe(false);
    expect(autoMoveAllowed("fix_ready", "in_progress", true)).toBe(true);
    expect(autoMoveAllowed("released", "in_progress", true)).toBe(false);
  });

  it("never lets a person reach or leave duplicate by a status change", () => {
    for (const s of ISSUE_STATUSES) expect(TRANSITIONS[s]).not.toContain("duplicate");
    expect(TRANSITIONS.duplicate).toEqual([]);
  });
});

describe.skipIf(!enabled)("issue center services (WP3.4)", () => {
  const env = withEnv({ ORBIT_ISSUES: "true", ORBIT_WORK: "true" });
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const newIssue = (title = `Checkout ${SECRET} fails for ${EMAIL}`) =>
    p.run((tx) => createIssue(tx, p.editor, { title, summary: `Seen by ${EMAIL}. ${SECRET}` }, userActor(p.editor)));
  const report = (issueId: string, extra: Record<string, unknown> = {}) =>
    p.run((tx) =>
      attachReport(
        tx,
        p.editor,
        issueId,
        { sourceKind: "manual", title: `Report ${SECRET}`, symptoms: `Mail me at ${EMAIL}`, ...extra },
        userActor(p.editor),
      ),
    );

  beforeAll(async () => {
    env.apply();
    p = await createIssuesProject({ modules: ["issues", "work"] });
    await p.run((tx) =>
      saveIssuesSettings(
        tx,
        p.owner,
        { ...defaultIssuesSettings(), components: [{ key: "checkout", label: { en: "Checkout", de: "Checkout" } }] },
        1,
      ),
    );
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("numbers issues, redacts their texts and refuses unknown components", async () => {
    const a = await newIssue();
    const b = await newIssue();
    expect(b.number).toBe(a.number + 1);
    expect(a.title).not.toContain(EMAIL);
    expect(a.summary).toContain("[e-mail removed]");
    expect(a.status).toBe("new");
    expect(
      await failure(p.run((tx) => createIssue(tx, p.editor, { title: "x", components: ["nowhere"] }, userActor(p.editor)))),
    ).toBe("ISSUES_COMPONENT_UNKNOWN");
  });

  it("validates status moves and versions", async () => {
    const issue = await newIssue();
    expect(await failure(p.run((tx) => setIssueStatus(tx, p.editor, issue.id, { status: "released", expectedVersion: 1 }, userActor(p.editor))))).toBe(
      "ISSUES_TRANSITION_INVALID",
    );
    expect(await failure(p.run((tx) => setIssueStatus(tx, p.editor, issue.id, { status: "duplicate", expectedVersion: 1 }, userActor(p.editor))))).toBe(
      "ISSUES_MERGE_REQUIRED",
    );
    const confirmed = await p.run((tx) => setIssueStatus(tx, p.editor, issue.id, { status: "confirmed", expectedVersion: 1 }, userActor(p.editor)));
    expect(confirmed.status).toBe("confirmed");
    expect(await failure(p.run((tx) => updateIssue(tx, p.editor, issue.id, { expectedVersion: 1, severity: "s2_major" }, userActor(p.editor))))).toBe(
      "ISSUES_VERSION_CONFLICT",
    );
    // Automatic moves go forward only and are no-ops otherwise.
    expect(await p.run((tx) => autoMoveIssue(tx, p.owner, issue.id, "in_progress", syncActor))).toBe(true);
    expect(await p.run((tx) => autoMoveIssue(tx, p.owner, issue.id, "planned", syncActor))).toBe(false);
    const closed = await p.run(async (tx) => {
      let row = await setIssueStatus(tx, p.editor, issue.id, { status: "wont_fix", expectedVersion: 3 }, userActor(p.editor));
      row = await setIssueStatus(tx, p.editor, issue.id, { status: "closed", expectedVersion: row.version }, userActor(p.editor));
      return row;
    });
    expect(closed.closedAt).not.toBeNull();
  });

  it("attaches reports, counts them, reopens closed issues and keeps re-deliveries idempotent", async () => {
    const issue = await newIssue();
    await p.run(async (tx) => {
      let row = await setIssueStatus(tx, p.editor, issue.id, { status: "wont_fix", expectedVersion: 1 }, userActor(p.editor));
      await setIssueStatus(tx, p.editor, issue.id, { status: "closed", expectedVersion: row.version }, userActor(p.editor));
    });
    const first = await report(issue.id, { externalRef: { system: "n8n", id: "evt-42" }, diagnostics: { code: `E42 ${EMAIL}`, count: 3 } });
    const again = await report(issue.id, { externalRef: { system: "n8n", id: "evt-42" } });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, report: { id: first.report.id } });
    expect(first.report.symptoms).toBe("Mail me at [e-mail removed]");
    expect(first.report.diagnostics).toEqual({ code: "E42 [e-mail removed]", count: 3 });
    expect(first.report.redaction).toEqual({ email: 2 });
    const detail = await p.run((tx) => issueDetail(tx, p.viewer, issue.id));
    expect(detail.issue).toMatchObject({ status: "triage", reportCount: 1 });
    // Viewers see no diagnostics.
    expect(detail.reports[0]).not.toHaveProperty("diagnostics");
    const forEditor = await p.run((tx) => issueDetail(tx, p.editor, issue.id));
    expect(forEditor.reports[0]).toMatchObject({ diagnostics: { count: 3 } });
  });

  it("merges an issue into another and keeps every report and link", async () => {
    const target = await newIssue("Payment page freezes");
    const source = await newIssue("Payment page hangs");
    await report(target.id);
    await report(source.id);
    await report(source.id);
    const task = await p.run((tx) => createTask(tx, p.editor, { title: "Fix payment freeze" }, workActor(p.editor)));
    await p.run((tx) =>
      createLink(
        tx,
        p.editor,
        { source: { type: "work.task", id: task.id }, target: { type: "issues.issue", id: source.id }, relation: "implements" },
        userActor(p.editor),
      ),
    );
    const merged = await p.run((tx) => mergeIssue(tx, p.editor, source.id, { targetIssueId: target.id, expectedVersion: 3 }, userActor(p.editor)));
    expect(merged).toMatchObject({ reports: 2, links: 1 });
    const detail = await p.run((tx) => issueDetail(tx, p.editor, target.id));
    expect(detail.issue.reportCount).toBe(3);
    expect(detail.reports).toHaveLength(3);
    expect(detail.links.map((l) => [l.relation, l.object.type])).toEqual(
      expect.arrayContaining([
        ["implements", "work.task"],
        ["duplicates", "issues.issue"],
      ]),
    );
    expect(detail.progress).toMatchObject({ tasks: 1, done: 0 });
    const old = await p.run((tx) => issueDetail(tx, p.editor, source.id));
    expect(old.issue).toMatchObject({ status: "duplicate", mergedIntoIssueId: target.id, reportCount: 0 });
    expect(await p.run((tx) => linksOf(tx, p.editor, { type: "issues.issue", id: source.id }))).toHaveLength(1);
    expect(
      await failure(p.run((tx) => mergeIssue(tx, p.editor, target.id, { targetIssueId: source.id, expectedVersion: detail.issue.version }, userActor(p.editor)))),
    ).toBe("ISSUES_ISSUE_MERGED");
    expect(await failure(report(source.id))).toBe("ISSUES_ISSUE_MERGED");
  });

  it("clears the coding share review when a text changes", async () => {
    const issue = await newIssue("Export breaks");
    expect(() => shareableFields(issue)).toThrow("ISSUES_SHARE_REVIEW_REQUIRED");
    const reviewed = await p.run((tx) => setShareReview(tx, p.editor, issue.id, { reviewed: true, expectedVersion: 1 }, userActor(p.editor)));
    expect(shareableFields(reviewed).key).toBe(`ISS-${issue.number}`);
    const severity = await p.run((tx) => updateIssue(tx, p.editor, issue.id, { expectedVersion: 2, severity: "s3_minor" }, userActor(p.editor)));
    expect(severity.shareReviewedAt).not.toBeNull();
    const retitled = await p.run((tx) => updateIssue(tx, p.editor, issue.id, { expectedVersion: 3, title: "Export breaks on CSV" }, userActor(p.editor)));
    expect(retitled.shareReviewedAt).toBeNull();
  });

  it("lists, searches and summarizes issues", async () => {
    const issue = await newIssue("Unique zebra crash in checkout");
    await p.run((tx) => updateIssue(tx, p.editor, issue.id, { expectedVersion: 1, severity: "s1_critical", components: ["checkout"] }, userActor(p.editor)));
    const found = await p.run((tx) => listIssues(tx, p.viewer, { q: "zebra" }));
    expect(found.items.map((i) => i.id)).toEqual([issue.id]);
    const byComponent = await p.run((tx) => listIssues(tx, p.viewer, { component: "checkout", sort: "severity" }));
    expect(byComponent.items[0]!.id).toBe(issue.id);
    const byNumber = await p.run((tx) => listIssues(tx, p.viewer, { q: `ISS-${issue.number}`, status: "all" }));
    expect(byNumber.items[0]!.id).toBe(issue.id);
    const overview = await p.run((tx) => issuesOverview(tx, p.viewer));
    expect(overview.metrics.critical).toBeGreaterThanOrEqual(1);
    expect(overview.byComponent).toEqual(expect.arrayContaining([{ component: "checkout", open: 1 }]));
    expect(overview.leadTimesHours).toHaveProperty("newToReleased");
  });

  it("writes no text into history, audits or domain events", async () => {
    const rows = await p.run(async (tx) => {
      const [events, audits, domain] = await Promise.all([
        tx.issueEvent.findMany({ where: { projectId: p.owner.projectId } }),
        tx.auditEvent.findMany({ where: { projectId: p.owner.projectId } }),
        tx.domainEvent.findMany({ where: { projectId: p.owner.projectId } }),
      ]);
      return JSON.stringify([events, audits, domain]);
    });
    expect(rows).not.toContain(SECRET);
    expect(rows).not.toContain(EMAIL);
    // The stored texts themselves never hold the e-mail address either.
    const stored = await p.run(async (tx) =>
      JSON.stringify([await tx.issue.findMany({ where: { projectId: p.owner.projectId } }), await tx.issueReport.findMany({ where: { projectId: p.owner.projectId } })]),
    );
    expect(stored).not.toContain(EMAIL);
  });
});
