import type { ReactElement, ReactNode } from "react";

/**
 * What the shell renders for a redirect decision (settings center phase 5):
 * nothing of its own for "none" (the address is no old settings address and
 * its page renders), the loading screen while it waits or goes, and the
 * refusal (OldAddressScreen) when the area is closed or the capabilities
 * failed. Each inside `wrap`, the wrapper every page has at the root (the
 * assistant provider). The root element keeps its type and position across
 * these renders, so React keeps the wrapper and its state: an open
 * assistant panel, an unsent draft and a running reply survive them.
 */
export function redirectScreen(
  kind: "none" | "wait" | "go" | "closed" | "failed",
  wrap: (tree: ReactNode) => ReactElement,
  loading: ReactNode,
  refusal: (kind: "closed" | "failed") => ReactNode,
): ReactElement | null {
  if (kind === "none") return null;
  return wrap(kind === "closed" || kind === "failed" ? refusal(kind) : loading);
}
