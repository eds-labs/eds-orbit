"use client";
import { useEffect, useRef } from "react";

// The shell stays mounted across navigations (app/(shell)/layout.tsx), so the
// sidebar keeps its scroll position, and so does the window. A new page starts
// at the top; back/forward keeps what the browser restores, and a change of
// the search only (a settings section) stays where it is.

/** Whether a change of path should scroll the window to the top. */
export function shouldScrollToTop(
  previous: string | null,
  next: string,
  traversal: boolean,
): boolean {
  return previous !== null && previous !== next && !traversal;
}

/** Scrolls the window to the top when the path changes by a link or redirect. */
export function useScrollTopOnNavigate(pathname: string): void {
  const previous = useRef<string | null>(null);
  const traversal = useRef(false);
  useEffect(() => {
    const onPop = () => {
      traversal.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (shouldScrollToTop(previous.current, pathname, traversal.current))
      window.scrollTo(0, 0);
    previous.current = pathname;
    traversal.current = false;
  }, [pathname]);
}
