"use client";
import { createContext, useContext, type ComponentType } from "react";
import type { Route, RouteTable } from "./routes";
import type { Label } from "./types";

/** A module as the shell shows it in the open project. */
export type ShellModule = {
  id: string;
  displayName: Label;
  description: Label;
  /** From GET /api/projects/:id/modules; true while unknown (fallback). */
  enabled: boolean;
  /** The module's pages with a navigation entry, in sidebar order. */
  nav: readonly Route[];
};

export type ShellContextValue = {
  table: RouteTable;
  /** Platform pages with a navigation entry, in sidebar order. */
  platformNav: readonly Route[];
  modules: readonly ShellModule[];
  /** Sections of the project home contributed by enabled modules. */
  homeSections: ReadonlyArray<{ moduleId: string; component: ComponentType }>;
  /** The URL of a page in the open project. */
  hrefOf: (key: string) => string;
};

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("Shell required");
  return value;
}
