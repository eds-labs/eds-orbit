import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  DRAFT_STATUSES,
  KEEP_REASONS as API_KEEP_REASONS,
  MISSION_KEEP_REASONS as API_MISSION_KEEP_REASONS,
} from "../../../api/src/modules/draft-statuses";
import {
  APPROVAL_STATUSES,
  approvalItems,
  KEEP_REASONS,
  MISSION_KEEP_REASONS,
  cleanupConfirmText,
  cleanupRestoredText,
  cleanupStorageKey,
  confirmCleanup,
  initialCleanupState,
  loadCleanups,
  openCleanupPreview,
  saveCleanups,
  undoCleanup,
  type CleanupState,
  type DraftCleanupSummary,
} from "./draft-cleanup";
import { DraftCleanup, DraftCleanupView } from "./draft-cleanup-panel";
import { Button } from "./ui/primitives";
import { WorkspaceContext } from "./workspace-context";

const item = (id: string, status: string) =>
  ({ id, version: 1, data: { status } }) as never;
const summary = (
  changes: Partial<DraftCleanupSummary> = {},
): DraftCleanupSummary => ({
  preview: true,
  cleanupId: null,
  content: { total: 48, alreadyInPostiz: 2 },
  missions: {
    total: 6,
    kept: { total: 3, byReason: { ACTIVE_JOB: 2, UNSETTLED_CONTENT: 1 } },
  },
  kept: {
    total: 4,
    byReason: {
      HAS_OPEN_PUBLICATION: 3,
      HAS_OPEN_POSTIZ_DRAFT: 0,
      PENDING_DECISION: 0,
      ACTIVE_ASSIGNMENT_RUN: 1,
    },
  },
  ...changes,
});
/** The buttons of a rendered tree, with their label and click handler. */
function buttons(node: ReactNode): { label: string; onClick?: () => void }[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode; onClick?: () => void };
  const own =
    node.type === Button
      ? [{ label: String(props.children), onClick: props.onClick }]
      : [];
  return [...own, ...buttons(props.children)];
}
const view = (
  state: CleanupState,
  handlers: Partial<Parameters<typeof DraftCleanupView>[0]> = {},
) =>
  DraftCleanupView({
    role: "owner",
    locale: "de",
    state,
    pending: false,
    error: null,
    onPreview: () => {},
    onConfirm: () => {},
    onClose: () => {},
    onUndo: () => {},
    ...handlers,
  });
const click = (tree: ReactNode, label: string) => {
  const found = buttons(tree).find((b) => b.label === label);
  expect(found, label).toBeDefined();
  found!.onClick!();
};

describe("approvals filter", () => {
  it("uses the same statuses as the API cleanup", () => {
    expect(APPROVAL_STATUSES).toEqual([...DRAFT_STATUSES]);
    expect(KEEP_REASONS).toEqual(API_KEEP_REASONS);
    expect(MISSION_KEEP_REASONS).toEqual(API_MISSION_KEEP_REASONS);
  });

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
});

describe("DraftCleanup", () => {
  const workspace = (isOwner: boolean, canEdit: boolean) =>
    renderToStaticMarkup(
      <WorkspaceContext.Provider
        value={
          {
            project: { id: "project" },
            locale: "de",
            isOwner,
            canEdit,
            refresh: () => {},
          } as never
        }
      >
        <DraftCleanup />
      </WorkspaceContext.Provider>,
    );

  it("offers the cleanup to the owner only", () => {
    expect(workspace(true, true)).toContain("Alte Entwürfe archivieren");
    expect(workspace(false, true)).toBe("");
    expect(workspace(false, false)).toBe("");
  });

  it("previews, confirms with the counts shown and undoes the cleanup", async () => {
    const call = vi.fn(async (name: string, input: any) => {
      if (name === "restore-draft-cleanup")
        return {
          cleanupId: input.cleanupId,
          restored: { content: 48, missions: 6 },
        };
      if (input.preview) return summary();
      return summary({ preview: false, cleanupId: "cleanup-1" });
    });
    let state = initialCleanupState;
    const previewed = vi.fn();
    click(view(state, { onPreview: previewed }), "Alte Entwürfe archivieren");
    expect(previewed).toHaveBeenCalledOnce();
    state = await openCleanupPreview(state, call);
    expect(call).toHaveBeenLastCalledWith("archive-old-drafts", {
      preview: true,
    });
    const dialog = renderToStaticMarkup(view(state));
    expect(dialog).toContain(
      "48 Entwürfe und 6 Missionen werden archiviert (wiederherstellbar).",
    );
    expect(dialog).toContain(
      "Davon 2 bereits als Entwurf in Postiz (dort bleiben sie unverändert).",
    );
    expect(dialog).toContain(
      "Behalten werden: 3 mit offener Veröffentlichung, 1 aus einem laufenden Auftrag.",
    );
    expect(dialog).toContain(
      "3 Missionen bleiben (2 mit offenem Job, 1 mit nicht abgeschlossenen Inhalten).",
    );
    // The dialog's button runs the confirmation.
    const confirmed = vi.fn();
    click(view(state, { onConfirm: confirmed }), "Archivieren");
    expect(confirmed).toHaveBeenCalledOnce();
    state = await confirmCleanup(state, call);
    expect(call).toHaveBeenLastCalledWith("archive-old-drafts", {
      confirm: true,
      expected: { content: 48, missions: 6, kept: 4 },
    });
    expect(state.preview).toBeNull();
    expect(state.done.map((c) => c.cleanupId)).toEqual(["cleanup-1"]);
    expect(renderToStaticMarkup(view(state))).toContain(
      "48 Entwürfe und 6 Missionen archiviert.",
    );
    // Undo restores exactly this cleanup.
    const undone = vi.fn();
    click(view(state, { onUndo: undone }), "Rückgängig");
    expect(undone).toHaveBeenCalledWith("cleanup-1");
    state = await undoCleanup(state, call, "cleanup-1");
    expect(call).toHaveBeenLastCalledWith("restore-draft-cleanup", {
      cleanupId: "cleanup-1",
    });
    expect(state.done).toEqual([]);
    expect(renderToStaticMarkup(view(state))).toContain(
      "48 Entwürfe und 6 Missionen wiederhergestellt.",
    );
  });

  it("shows the new preview when the counts changed before confirming", async () => {
    let previews = 0;
    const call = vi.fn(async (_name: string, input: any) => {
      if (input.preview)
        return summary({ content: { total: 10 + previews++ } });
      throw new ApiError("CLEANUP_CHANGED", 409);
    });
    const shown = await openCleanupPreview(initialCleanupState, call);
    const state = await confirmCleanup(shown, call);
    expect(state.changed).toBe(true);
    expect(state.preview?.content.total).toBe(11);
    expect(state.done).toEqual([]);
    expect(renderToStaticMarkup(view(state))).toContain(
      "Die Zahlen haben sich inzwischen geändert.",
    );
    // Other refusals reach the mutation's error.
    const failing = vi.fn(async () => {
      throw new ApiError("OWNER_REQUIRED", 403);
    });
    await expect(confirmCleanup(shown, failing)).rejects.toThrow();
  });

  it("keeps the last cleanups across a reload and tolerates blocked storage", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    let n = 0;
    const call = vi.fn(async (_name: string, input: any) =>
      input.preview
        ? summary()
        : summary({ preview: false, cleanupId: `cleanup-${++n}` }),
    );
    let state = initialCleanupState;
    for (let i = 0; i < 2; i += 1)
      state = await confirmCleanup(await openCleanupPreview(state, call), call);
    saveCleanups(storage, "project", state.done);
    // After a reload the first cleanup is not lost.
    expect(loadCleanups(storage, "project").map((c) => c.cleanupId)).toEqual([
      "cleanup-2",
      "cleanup-1",
    ]);
    expect(loadCleanups(storage, "other")).toEqual([]);
    saveCleanups(storage, "project", []);
    expect(values.has(cleanupStorageKey("project"))).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(loadCleanups(blocked, "project")).toEqual([]);
    expect(() => saveCleanups(blocked, "project", state.done)).not.toThrow();
    values.set(cleanupStorageKey("project"), "not json");
    expect(loadCleanups(storage, "project")).toEqual([]);
  });

  it("words singular, plural and an empty restore", () => {
    expect(
      cleanupConfirmText(
        summary({
          content: { total: 1, alreadyInPostiz: 1 },
          missions: {
            total: 0,
            kept: { total: 1, byReason: { NO_CONTENT: 1 } },
          },
          kept: { total: 1, byReason: { PENDING_DECISION: 1 } },
        }),
        "de",
      ),
    ).toEqual([
      "1 Entwurf wird archiviert (wiederherstellbar).",
      "Davon 1 bereits als Entwurf in Postiz (dort bleibt er unverändert).",
      "Behalten wird: 1 mit offener Entscheidung.",
      "1 Mission bleibt (1 ohne eigene Inhalte).",
    ]);
    expect(
      cleanupConfirmText(
        summary({
          content: { total: 2 },
          missions: { total: 1, kept: { total: 0, byReason: {} } },
          kept: { total: 0, byReason: {} },
        }),
        "de",
      ),
    ).toEqual([
      "2 Entwürfe und 1 Mission werden archiviert (wiederherstellbar).",
    ]);
    expect(cleanupRestoredText({ content: 0, missions: 0 }, "de")).toBe(
      "Nichts wiederherzustellen.",
    );
    expect(cleanupRestoredText({ content: 1, missions: 0 }, "de")).toBe(
      "1 Entwurf wiederhergestellt.",
    );
  });
});
