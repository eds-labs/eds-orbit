import { describe, expect, it } from "vitest";
import {
  approvalItems,
  cleanupConfirmText,
  cleanupDoneText,
} from "./draft-cleanup";

const item = (id: string, status: string) =>
  ({ id, version: 1, data: { status } }) as never;

describe("old draft cleanup", () => {
  it("leaves archived drafts out of the approvals list", () => {
    const listed = approvalItems([
      item("review", "review"),
      item("needs", "needs_review"),
      item("reviewed", "reviewed"),
      item("draft", "draft"),
      item("blocked", "blocked"),
      item("pending", "pending_approval"),
      item("archived", "archived"),
      item("published", "published"),
    ]);
    expect(listed.map((c: { id: string }) => c.id)).toEqual([
      "review",
      "needs",
      "reviewed",
      "draft",
      "blocked",
      "pending",
    ]);
  });

  it("names what is archived and kept before and after the run", () => {
    const summary = {
      preview: true,
      content: { total: 48 },
      missions: { total: 6 },
      kept: { total: 3 },
    };
    expect(cleanupConfirmText(summary, "de")).toBe(
      "48 Entwürfe und 6 Missionen werden archiviert (wiederherstellbar). Behalten werden 3 mit offener Veröffentlichung.",
    );
    expect(cleanupDoneText(summary, "de")).toBe(
      "48 Entwürfe und 6 Missionen archiviert.",
    );
  });
});
