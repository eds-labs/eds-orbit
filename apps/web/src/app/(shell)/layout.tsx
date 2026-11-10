"use client";
// The shell lives in a layout, not in the catch-all page: a layout keeps its
// state across navigations, while the page under [[...route]] remounts for
// every path. Remounting showed the boot screen on each click, refetched
// setup and identity and reset the sidebar's scroll position.
// A client layout: the registry holds components, which a server component
// could not pass to the shell. Next.js still never reads the database (ADR 0001).
import type { ReactNode } from "react";
import { Orbit } from "@/components/orbit";
import { webRegistry } from "@/modules/registry";
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Orbit registry={webRegistry} />
      {children}
    </>
  );
}
