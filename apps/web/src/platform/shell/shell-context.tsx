"use client";
import { createContext, useContext, type ComponentType } from "react";
import type { Route, RouteTable } from "./routes";
import type {
  AttentionRenderer,
  ConnectorProvider,
  Label,
  SettingsSection,
} from "./types";
import type { AttentionResponse } from "@/lib/api";
import type {
  ActionRequestRenderer,
  ChatExtension,
} from "@/platform/assistant/extensions";

/** A module as the shell shows it in the open project. */
export type ShellModule = {
  id: string;
  displayName: Label;
  description: Label;
  /** Position of the module's group in the sidebar (WebModule.groupOrder). */
  groupOrder?: number;
  /** From GET /api/projects/:id/modules; true while unknown (fallback). */
  enabled: boolean;
  /** The module's pages with a navigation entry, in sidebar order. */
  nav: readonly Route[];
  /** Key of the module's first settings section; its sidebar group links there. */
  settingsSection?: string;
};

/** The project's attention items as the shell loaded them (§4.4). */
export type AttentionState = {
  data?: AttentionResponse;
  error?: unknown;
  loading: boolean;
};

export type ShellContextValue = {
  features?: Record<string, boolean>;
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
  /** The attention items, shared by the sidebar and the home (useAttention). */
  attention: AttentionState;
  /** Texts of attention items by kind: the platform's and every module's. */
  attentionRenderers: Readonly<Record<string, AttentionRenderer>>;
  /**
   * Settings sections of the modules, in registry order (WP2.3b), each with
   * its group set (the module's id unless the section names one).
   */
  settings: readonly SettingsSection[];
  /** Setup links of the modules for the settings overview (WP2.3b). */
  setupLinks: readonly ComponentType[];
  /** Connector providers and extra cards of the modules (WP2.3b). */
  connectors: {
    providers: readonly ConnectorProvider[];
    extras: readonly ComponentType[];
  };
};

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("Shell required");
  return value;
}
