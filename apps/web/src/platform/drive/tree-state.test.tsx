import { describe, expect, it } from "vitest";
import {
  addChildren,
  focusTarget,
  emptyTree,
  expandPath,
  keyMove,
  toggle,
  visibleRows,
} from "./tree-state";

// The Drive folder tree's state (Drive page design 2026-11-05 §5.1): pure,
// so the component only renders what these functions return.

const R = "rootFolder0001";
const page = (ids: string[], next: string | null = null) => ({
  folders: ids.map((id) => ({ id, name: id.toUpperCase() })),
  nextPageToken: next,
});

describe("Drive tree state", () => {
  it("shows the root expanded and nothing below it until loaded", () => {
    const rows = visibleRows(emptyTree(R, "Root"), R);
    expect(rows).toEqual([
      { id: R, name: "Root", depth: 0, expanded: true, loaded: false },
    ]);
  });

  it("hides the children of a collapsed folder", () => {
    let state = addChildren(emptyTree(R, "Root"), R, page(["a", "b"]), false);
    state = addChildren(state, "a", page(["a1"]), false);
    expect(visibleRows(state, R).map((r) => r.id)).toEqual([R, "a", "b"]);
    state = toggle(state, "a");
    expect(visibleRows(state, R).map((r) => [r.id, r.depth])).toEqual([
      [R, 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
    ]);
  });

  it("appends a further page and offers more while a token is left", () => {
    let state = addChildren(emptyTree(R, "Root"), R, page(["a"], "t2"), false);
    expect(visibleRows(state, R).at(-1)).toEqual({
      id: `more:${R}`,
      name: "",
      depth: 1,
      expanded: false,
      loaded: true,
      more: true,
      parentId: R,
    });
    state = addChildren(state, R, page(["b"]), true);
    expect(visibleRows(state, R).map((r) => r.id)).toEqual([R, "a", "b"]);
  });

  it("expands every ancestor of a deep-linked folder", () => {
    const state = expandPath(emptyTree(R, "Root"), [
      { id: R, name: "Root" },
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    expect([...state.expanded].sort()).toEqual([R, "a"].sort());
    expect(state.names.b).toBe("B");
  });

  it("marks a loaded folder without subfolders as a leaf", () => {
    let state = addChildren(emptyTree(R, "Root"), R, page(["a"]), false);
    state = addChildren(state, "a", page([]), false);
    const a = visibleRows(state, R).find((r) => r.id === "a")!;
    expect([a.loaded, a.expanded]).toEqual([true, false]);
  });
});

describe("Drive tree keys", () => {
  let state = addChildren(emptyTree(R, "Root"), R, page(["a", "b"]), false);
  state = addChildren(state, "a", page(["a1"]), false);

  it("ArrowRight expands a collapsed folder, then enters it", () => {
    const rows = visibleRows(state, R);
    expect(keyMove(rows, "a", "ArrowRight", state)).toEqual({
      focus: "a",
      toggle: "a",
    });
    const open = toggle(state, "a");
    expect(keyMove(visibleRows(open, R), "a", "ArrowRight", open)).toEqual({
      focus: "a1",
    });
  });

  it("ArrowLeft goes to the parent, or collapses an open folder", () => {
    const open = toggle(state, "a");
    const rows = visibleRows(open, R);
    expect(keyMove(rows, "a1", "ArrowLeft", open)).toEqual({ focus: "a" });
    expect(keyMove(rows, "a", "ArrowLeft", open)).toEqual({
      focus: "a",
      toggle: "a",
    });
  });

  it("ArrowUp, ArrowDown, Home and End move along the visible rows", () => {
    const rows = visibleRows(state, R);
    expect(keyMove(rows, R, "ArrowDown", state)).toEqual({ focus: "a" });
    expect(keyMove(rows, "a", "ArrowUp", state)).toEqual({ focus: R });
    expect(keyMove(rows, R, "ArrowUp", state)).toEqual({ focus: R });
    expect(keyMove(rows, "a", "End", state)).toEqual({ focus: "b" });
    expect(keyMove(rows, "b", "Home", state)).toEqual({ focus: R });
  });
});

describe("Drive tree focus", () => {
  const rows = [
    { id: R, name: "Root", depth: 0, expanded: true, loaded: true },
    { id: "a", name: "A", depth: 1, expanded: false, loaded: true },
  ];
  it("keeps a visible focus, else the open folder, else the first row", () => {
    expect(focusTarget(rows, "a", R)).toBe("a");
    expect(focusTarget(rows, "gone", "a")).toBe("a");
    // The open folder was hidden by collapsing an ancestor with the mouse.
    expect(focusTarget(rows, "gone", "hidden")).toBe(R);
  });
});
