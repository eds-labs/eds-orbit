import type { DriveFolder } from "./api";

// The Drive folder tree as pure state (Drive page design 2026-11-05 §5.1):
// children load page by page on first expand; the rows are the visible
// folders in order, so keys and rendering need no tree walk of their own.

export type TreeState = {
  /** Per folder: loaded child ids and the token of the next page. */
  children: Record<string, { ids: string[]; next: string | null } | undefined>;
  names: Record<string, string>;
  expanded: Set<string>;
};
export type TreeRow = {
  id: string;
  name: string;
  depth: number;
  expanded: boolean;
  /** Children are known (possibly none). */
  loaded: boolean;
  /** The "more folders" row of `parentId`. */
  more?: true;
  parentId?: string;
};
export type TreeKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

export function emptyTree(rootId: string, rootName: string): TreeState {
  return {
    children: {},
    names: { [rootId]: rootName },
    expanded: new Set([rootId]),
  };
}

export function addChildren(
  state: TreeState,
  parentId: string,
  page: { folders: DriveFolder[]; nextPageToken: string | null },
  append: boolean,
): TreeState {
  const before = append ? (state.children[parentId]?.ids ?? []) : [];
  const ids = [...before, ...page.folders.map((f) => f.id).filter((id) => !before.includes(id))];
  const names = { ...state.names };
  for (const f of page.folders) names[f.id] = f.name;
  return {
    ...state,
    names,
    children: { ...state.children, [parentId]: { ids, next: page.nextPageToken } },
  };
}

export function toggle(state: TreeState, id: string): TreeState {
  const expanded = new Set(state.expanded);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  return { ...state, expanded };
}

/** Expands the ancestors of the last folder of `path` (root first). */
export function expandPath(state: TreeState, path: DriveFolder[]): TreeState {
  const expanded = new Set(state.expanded);
  const names = { ...state.names };
  path.forEach((f, i) => {
    names[f.id] = f.name;
    if (i < path.length - 1) expanded.add(f.id);
  });
  return { ...state, names, expanded };
}

export function visibleRows(state: TreeState, rootId: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (id: string, depth: number) => {
    const known = state.children[id];
    const expanded = state.expanded.has(id) && !(known && !known.ids.length && !known.next);
    rows.push({ id, name: state.names[id] ?? id, depth, expanded, loaded: Boolean(known) });
    if (!expanded || !known) return;
    for (const child of known.ids) visit(child, depth + 1);
    if (known.next)
      rows.push({
        id: `more:${id}`,
        name: "",
        depth: depth + 1,
        expanded: false,
        loaded: true,
        more: true,
        parentId: id,
      });
  };
  visit(rootId, 0);
  return rows;
}

/** Where the focus goes for a key, and which folder to open or close. */
export function keyMove(
  rows: TreeRow[],
  currentId: string,
  key: TreeKey,
  state: TreeState,
): { focus: string; toggle?: string } {
  const index = Math.max(0, rows.findIndex((r) => r.id === currentId));
  const row = rows[index]!;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(rows.length - 1, index + 1)]!.id };
    case "ArrowUp":
      return { focus: rows[Math.max(0, index - 1)]!.id };
    case "Home":
      return { focus: rows[0]!.id };
    case "End":
      return { focus: rows.at(-1)!.id };
    case "ArrowRight": {
      if (row.more) return { focus: row.id };
      if (!row.expanded) {
        const known = state.children[row.id];
        const leaf = known && !known.ids.length && !known.next;
        return leaf ? { focus: row.id } : { focus: row.id, toggle: row.id };
      }
      const next = rows[index + 1];
      return next && next.depth === row.depth + 1 ? { focus: next.id } : { focus: row.id };
    }
    case "ArrowLeft": {
      if (row.expanded && !row.more) return { focus: row.id, toggle: row.id };
      for (let i = index - 1; i >= 0; i--)
        if (rows[i]!.depth === row.depth - 1) return { focus: rows[i]!.id };
      return { focus: row.id };
    }
  }
}

/**
 * The row that takes the tab stop: the focused row while visible, else the
 * open folder, else the first row (the open folder may sit in a collapsed
 * branch), so the tree stays reachable with the keyboard.
 */
export function focusTarget(rows: readonly TreeRow[], focus: string, current: string): string {
  if (rows.some((r) => r.id === focus)) return focus;
  if (rows.some((r) => r.id === current)) return current;
  return rows[0]?.id ?? current;
}
