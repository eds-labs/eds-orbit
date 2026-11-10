"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import { drivePaths, type DriveFolder, type DriveFolderPage } from "./api";
import { driveText } from "./labels";
import {
  addChildren,
  emptyTree,
  expandPath,
  focusTarget,
  keyMove,
  toggle,
  visibleRows,
  type TreeKey,
  type TreeState,
} from "./tree-state";

// The folder tree of the Drive page (design 2026-11-05 §5.1): a WAI-ARIA
// tree with a roving tab index. Children load on first expand, a page of
// 200 at a time; a deep-linked folder opens its ancestors.

const KEYS = new Set<TreeKey>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function FolderTree({
  projectId,
  rootId,
  rootName,
  path,
  current,
  onSelect,
  locale,
}: {
  projectId: string;
  rootId: string;
  rootName: string;
  /** From the root to the open folder; its ancestors are expanded. */
  path: DriveFolder[];
  current: string;
  onSelect: (folderId: string) => void;
  locale: "en" | "de";
}) {
  const t = driveText(locale);
  const paths = drivePaths(projectId);
  const [tree, setTree] = useState<TreeState>(() => expandPath(emptyTree(rootId, rootName), path));
  const [focus, setFocus] = useState(current);
  const [failed, setFailed] = useState<string | null>(null);
  const loading = useRef(new Set<string>());
  const items = useRef(new Map<string, HTMLLIElement>());
  const pathKey = path.map((p) => p.id).join("/");

  // A new root (the owner changed the project folder) starts a new tree.
  useEffect(() => {
    setTree(expandPath(emptyTree(rootId, rootName), path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId]);
  useEffect(() => {
    setTree((state) => expandPath(state, path));
    setFocus(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, current]);

  const load = (parentId: string, pageToken: string | null) => {
    const key = `${parentId}:${pageToken ?? ""}`;
    if (loading.current.has(key)) return;
    loading.current.add(key);
    api<DriveFolderPage>(paths.folders(parentId, pageToken))
      .then((page) => {
        setFailed(null);
        setTree((state) => addChildren(state, parentId, page, pageToken !== null));
      })
      .catch(() => setFailed(parentId))
      .finally(() => loading.current.delete(key));
  };
  // Every expanded folder whose children are unknown loads them.
  useEffect(() => {
    for (const id of tree.expanded) if (!tree.children[id]) load(id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.expanded, tree.children]);

  const rows = useMemo(() => visibleRows(tree, rootId), [tree, rootId]);
  const focusable = focusTarget(rows, focus, current);

  function activate(id: string) {
    const row = rows.find((r) => r.id === id);
    if (row?.more && row.parentId) load(row.parentId, tree.children[row.parentId]?.next ?? null);
    else onSelect(id);
  }

  return (
    <ul
      className="drive-tree"
      role="tree"
      aria-label={t.treeLabel}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(focusable);
          return;
        }
        if (!KEYS.has(event.key as TreeKey)) return;
        event.preventDefault();
        const move = keyMove(rows, focusable, event.key as TreeKey, tree);
        if (move.toggle) setTree((state) => toggle(state, move.toggle!));
        setFocus(move.focus);
        items.current.get(move.focus)?.focus();
      }}
    >
      {rows.map((row) => {
        const selected = row.id === current;
        const leaf = row.loaded && !row.expanded && tree.children[row.id]?.ids.length === 0;
        return (
          <li
            key={row.id}
            ref={(node) => {
              if (node) items.current.set(row.id, node);
              else items.current.delete(row.id);
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={row.more ? undefined : selected}
            aria-expanded={row.more || leaf ? undefined : row.expanded}
            tabIndex={row.id === focusable ? 0 : -1}
            className={selected ? "drive-tree-row is-selected" : "drive-tree-row"}
            style={{ paddingInlineStart: `calc(${row.depth} * 1rem + 0.25rem)` }}
            onClick={() => {
              setFocus(row.id);
              activate(row.id);
            }}
          >
            {row.more ? (
              <span className="drive-tree-more">{t.moreFolders}</span>
            ) : (
              <>
                <span
                  className="drive-tree-toggle"
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!leaf) setTree((state) => toggle(state, row.id));
                  }}
                >
                  {leaf ? null : row.expanded ? <ChevronDown /> : <ChevronRight />}
                </span>
                {selected ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                <span className="drive-tree-name">{row.name}</span>
              </>
            )}
          </li>
        );
      })}
      {failed && (
        <li role="none" className="field-hint">
          {t.foldersFailed}{" "}
          <button type="button" className="drive-crumb" onClick={() => load(failed, null)}>
            {t.retry}
          </button>
        </li>
      )}
    </ul>
  );
}
