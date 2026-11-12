import type { ReactElement, ReactNode } from "react";

/**
 * What the shell renders for a redirect decision (settings center phase 5):
 * nothing of its own for "stay" (the page renders), otherwise the loading
 * screen inside `wrap`, the wrapper every page has at the root (the
 * assistant provider). The root element keeps its type and position across
 * the loading render, so React keeps the wrapper and its state: an open
 * assistant panel, an unsent draft and a running reply survive it.
 */
export function redirectScreen(
  kind: "go" | "wait" | "stay",
  wrap: (tree: ReactNode) => ReactElement,
  loading: ReactNode,
): ReactElement | null {
  return kind === "stay" ? null : wrap(loading);
}
