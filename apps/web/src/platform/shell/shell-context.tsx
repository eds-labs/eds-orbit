"use client";
import { createContext, useContext, type ComponentType } from "react";
import type { Route, RouteTable } from "./routes";
import type { Label } from "./types";
import type {
  ActionRequestRenderer,
  ChatExtension,
} from "@/platform/assistant/extensions";

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
  /** Chat parts of the modules, in registry order (WP2.3). */
  chat: readonly ChatExtension[];
  /** Inbox views of action request types, by type (WP2.3). */
  actionRequests: Readonly<Record<string, ActionRequestRenderer>>;
};

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("Shell required");
  return value;
}
