import { describe, expect, it } from "vitest";
import type { Entity } from "@/lib/api";
import { sourceRows, SOURCE_REMINDER_DAYS } from "./source-rows";
import { knowledgeCopy } from "./workspace-text";
import type { Summary } from "./workspace-parts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const t = knowledgeCopy.en;

const entity = (id: string, data: Record<string, unknown>) =>
  ({ id, data }) as unknown as Entity;
const draft = (
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
  name = id,
) => entity(id, { status: "draft", input: { kind, name }, ...extra });
const source = (
  id: string,
  extra: Record<string, unknown> = {},
  type = "manual",
) =>
  entity(id, {
    name: id,
    type,
    status: "active",
    lastSuccessfulSyncAt: ago(1),
    maxAgeHours: 24 * 365,
    ...extra,
  });
const run = (id: string, draftId: string, status: string, extra = {}) =>
  entity(id, { draftId, status, ...extra });
const siteRun = (sourceId: string, status: string, extra = {}) =>
  entity(`run-${sourceId}`, { sourceId, status, ...extra });
const proposal = (draftId: string, status: string) =>
  entity(`p-${draftId}-${status}-${Math.random()}`, { draftId, status });

const summary = (parts: Partial<Summary>): Summary => ({
  enabled: true,
  profile: {},
  drafts: [],
  runs: [],
  proposals: [],
  facts: [],
  sources: [],
  ...parts,
});
const rows = (parts: Partial<Summary>) =>
  sourceRows(summary(parts), new Map(), NOW, t, "en");
const one = (parts: Partial<Summary>) => {
  const result = rows(parts);
  expect(result).toHaveLength(1);
  return result[0]!;
};

describe("sourceRows", () => {
  it("reading: an active analysis run has no action", () => {
    const row = one({
      drafts: [draft("d", "github", { activeRunId: "r1" })],
      runs: [run("r1", "d", "analyzing")],
    });
    expect(row.status).toBe("reading");
    expect(row.primary).toBeNull();
  });

  it("reading: an active site run has no action", () => {
    const row = one({
      sources: [source("s", { site: {} }, "website")],
      siteRuns: [siteRun("s", "running")],
    });
    expect(row.status).toBe("reading");
    expect(row.primary).toBeNull();
  });

  it("paused: a source offers resume", () => {
    const row = one({ sources: [source("s", { status: "paused" })] });
    expect(row.status).toBe("paused");
    expect(row.label).toBe(t.paused);
    expect(row.primary).toEqual({ kind: "resume", sourceId: "s" });
  });

  it("failed: a draft opens in the add flow", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r1", "d", "failed", { error: "BUDGET_EXCEEDED" })],
    });
    expect(row.status).toBe("failed");
    expect(row.tone).toBe("danger");
    expect(row.errorCode).toBe("BUDGET_EXCEEDED");
    expect(row.primary).toEqual({ kind: "draft-edit", draftId: "d" });
  });

  it("failed: an unknown analysis outcome counts as failed", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r1", "d", "unknown")],
    });
    expect(row.status).toBe("failed");
  });

  it("failed: a source retries its site read", () => {
    const row = one({
      sources: [source("s", { site: {} }, "website")],
      siteRuns: [siteRun("s", "failed", { errorCode: "SOURCE_TIMEOUT" })],
    });
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("SOURCE_TIMEOUT");
    expect(row.primary).toEqual({ kind: "site-refresh", sourceId: "s" });
  });

  it("waiting: a draft offers the review", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r1", "d", "completed")],
      proposals: [proposal("d", "pending"), proposal("d", "pending")],
    });
    expect(row.status).toBe("waiting");
    expect(row.label).toBe("2 proposals waiting");
    expect(row.primary).toEqual({ kind: "review" });
  });

  it("not finished: a draft without a completed analysis continues setup", () => {
    const row = one({ drafts: [draft("d", "github")] });
    expect(row.status).toBe("not_finished");
    expect(row.label).toBe(t.rowNotFinished);
    expect(row.sentence).toBe(t.rowNotFinishedHint);
    expect(row.primary).toEqual({ kind: "draft-edit", draftId: "d" });
  });

  it("never read: a website source reads its contents", () => {
    const row = one({
      sources: [source("s", { lastSuccessfulSyncAt: null }, "website")],
    });
    expect(row.status).toBe("never_read");
    expect(row.label).toBe(t.neverRead);
    expect(row.primary).toEqual({ kind: "site-import", sourceId: "s" });
  });

  it("never read: a gitbook source reads its contents", () => {
    const row = one({
      sources: [source("s", { lastSuccessfulSyncAt: null }, "gitbook")],
    });
    expect(row.primary).toEqual({ kind: "site-import", sourceId: "s" });
  });

  it("never read: another source goes to the expert page", () => {
    const row = one({
      sources: [source("s", { lastSuccessfulSyncAt: null })],
    });
    expect(row.status).toBe("never_read");
    expect(row.primary).toEqual({ kind: "expert", sourceId: "s" });
  });

  it("out of date: a source with a site refreshes it", () => {
    const row = one({
      sources: [
        source(
          "s",
          { site: {}, lastSuccessfulSyncAt: ago(10), maxAgeHours: 24 },
          "website",
        ),
      ],
    });
    expect(row.status).toBe("out_of_date");
    expect(row.label).toBe(t.staleSource);
    expect(row.primary).toEqual({ kind: "site-refresh", sourceId: "s" });
  });

  it("out of date: a website without a site reads its contents", () => {
    const row = one({
      sources: [
        source(
          "s",
          { lastSuccessfulSyncAt: ago(10), maxAgeHours: 24 },
          "website",
        ),
      ],
    });
    expect(row.primary).toEqual({ kind: "site-import", sourceId: "s" });
  });

  it("out of date: another source goes to the expert page", () => {
    const row = one({
      sources: [
        source("s", { lastSuccessfulSyncAt: ago(10), maxAgeHours: 24 }),
      ],
    });
    expect(row.primary).toEqual({ kind: "expert", sourceId: "s" });
  });

  it("reminder: a github draft updates", () => {
    const row = one({
      drafts: [draft("d", "github", { lastSuccessfulSyncAt: ago(40) })],
      runs: [run("r1", "d", "completed")],
    });
    expect(row.status).toBe("reminder");
    expect(row.label).toBe(t.rowReminder);
    expect(row.sentence).toBe(t.rowReminderHint.replace("{n}", "40"));
    expect(row.primary).toEqual({ kind: "draft-update", draftId: "d" });
  });

  it("up to date: a source has no action", () => {
    const row = one({ sources: [source("s", {}, "website")] });
    expect(row.status).toBe("up_to_date");
    expect(row.label).toBe(t.freshSource);
    expect(row.tone).toBe("success");
    expect(row.primary).toBeNull();
  });

  it("up to date: an expiring source keeps the warning sentence", () => {
    const row = one({
      sources: [source("s", { lastSuccessfulSyncAt: ago(1), maxAgeHours: 30 })],
    });
    expect(row.status).toBe("up_to_date");
    expect(row.tone).toBe("warning");
    expect(row.sentence).toContain("no longer be used from");
  });

  it("up to date: manual freshness keeps the hand-maintained label", () => {
    const row = one({
      sources: [source("s", { lastSuccessfulSyncAt: null }, "verified_facts")],
    });
    expect(row.status).toBe("up_to_date");
    expect(row.label).toBe(t.manualSource);
  });

  it("up to date: a recently read draft has no action", () => {
    const row = one({
      drafts: [draft("d", "github", { lastSuccessfulSyncAt: ago(5) })],
      runs: [run("r1", "d", "completed")],
    });
    expect(row.status).toBe("up_to_date");
    expect(row.primary).toBeNull();
  });

  it("paused beats out of date", () => {
    const row = one({
      sources: [
        source("s", {
          status: "paused",
          lastSuccessfulSyncAt: ago(10),
          maxAgeHours: 24,
        }),
      ],
    });
    expect(row.status).toBe("paused");
  });

  it("reading beats failed", () => {
    const row = one({
      sources: [source("s", { site: {} }, "website")],
      siteRuns: [siteRun("s", "running", { errorCode: "SOURCE_TIMEOUT" })],
    });
    expect(row.status).toBe("reading");
    const draftRow = one({
      drafts: [draft("d", "github", { activeRunId: "r2" })],
      runs: [run("r2", "d", "analyzing"), run("r1", "d", "failed")],
    });
    expect(draftRow.status).toBe("reading");
  });

  it("failed beats waiting", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r2", "d", "failed"), run("r1", "d", "completed")],
      proposals: [proposal("d", "pending")],
    });
    expect(row.status).toBe("failed");
  });

  it("only the latest run decides failure", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r2", "d", "completed"), run("r1", "d", "failed")],
    });
    expect(row.status).not.toBe("failed");
  });

  it("reminder at exactly 30 days and not at 29", () => {
    expect(SOURCE_REMINDER_DAYS).toBe(30);
    const at = (days: number) =>
      one({
        drafts: [draft("d", "website", { lastSuccessfulSyncAt: ago(days) })],
        runs: [run("r1", "d", "completed")],
      }).status;
    expect(at(30)).toBe("reminder");
    expect(at(29)).toBe("up_to_date");
  });

  it("no reminder for manual and file drafts", () => {
    for (const kind of ["manual", "file"]) {
      const row = one({
        drafts: [draft("d", kind, { lastSuccessfulSyncAt: ago(90) })],
        runs: [run("r1", "d", "completed")],
      });
      expect(row.status).toBe("up_to_date");
      expect(row.label).toBe(t.manualSource);
      expect(row.primary).toBeNull();
    }
  });

  it("SOURCE_INACTIVE and KNOWLEDGE_DISABLED are not failed", () => {
    for (const errorCode of ["SOURCE_INACTIVE", "KNOWLEDGE_DISABLED"]) {
      const row = one({
        sources: [source("s", { site: {} }, "website")],
        siteRuns: [siteRun("s", "failed", { errorCode })],
      });
      expect(row.status).toBe("up_to_date");
    }
  });

  it("replaced drafts and revoked sources produce no row", () => {
    expect(
      rows({
        drafts: [draft("d", "github", { status: "replaced" })],
        sources: [
          source("s", { status: "revoked" }),
          source("p", { proposalId: "x" }),
        ],
      }),
    ).toEqual([]);
  });

  it("sort follows the rank, then the name", () => {
    const result = rows({
      drafts: [
        draft("nf", "github", {}, "Unfinished"),
        draft("wt", "github", {}, "Waiting"),
        draft("fl", "github", {}, "Failed"),
        draft("rm", "github", { lastSuccessfulSyncAt: ago(60) }, "Reminder"),
      ],
      runs: [
        run("r-wt", "wt", "completed"),
        run("r-fl", "fl", "failed"),
        run("r-rm", "rm", "completed"),
      ],
      proposals: [proposal("wt", "pending")],
      sources: [
        source("ood", {
          lastSuccessfulSyncAt: ago(10),
          maxAgeHours: 24,
          name: "Old",
        }),
        source("pz", { status: "paused", name: "Paused" }),
        source("b", { name: "Beta" }),
        source("a", { name: "Alpha" }),
        source("nr", { lastSuccessfulSyncAt: null, name: "Never" }),
        source("rd", { site: {}, name: "Reading" }, "website"),
      ],
      siteRuns: [siteRun("rd", "running")],
    });
    expect(result.map((r) => r.name)).toEqual([
      "Failed",
      "Waiting",
      "Never",
      "Unfinished",
      "Old",
      "Reminder",
      "Reading",
      "Paused",
      "Alpha",
      "Beta",
    ]);
  });

  it("one waiting proposal uses the singular", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r1", "d", "completed")],
      proposals: [proposal("d", "pending")],
    });
    expect(row.label).toBe(t.rowWaitingOne);
  });

  it("needs_review proposals count as waiting", () => {
    const row = one({
      drafts: [draft("d", "github")],
      runs: [run("r1", "d", "completed")],
      proposals: [proposal("d", "needs_review"), proposal("d", "accepted")],
    });
    expect(row.status).toBe("waiting");
    expect(row.label).toBe(t.rowWaitingOne);
  });
});
