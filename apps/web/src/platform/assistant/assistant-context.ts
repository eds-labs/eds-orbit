"use client";
import { createContext, useContext } from "react";
import type { Project } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type { AssistantStatus } from "./api";
import type { AssistantConversation } from "./use-assistant-conversation";

// What the shell's assistant provider lends the bubble, the panel, the full
// page, "My context" and the home prompt (WP3.8), and its pure rules.

export const ASSISTANT_PAGE = "/assistant";

/** The panel input's id; the sheet focuses it on open. */
export const PANEL_INPUT_ID = "assistant-panel-input";
export const PAGE_INPUT_ID = "assistant-page-input";

export type AssistantContextValue = {
  /** The feature answers (flag on); false hides every entry. */
  available: boolean;
  /** The member may use it; with `available`, false shows `reason`. */
  enabled: boolean;
  status: AssistantStatus | null;
  conversation: AssistantConversation;
  locale: Locale;
  isOpen: boolean;
  openPanel(options?: { draft?: string }): void;
  closePanel(): void;
  /** The business project the assistant looks at first; "" for none. */
  focusProjectId: string;
  setFocusProjectId(id: string): void;
  /** Projects offered as focus: the member's in this organization. */
  projects: Project[];
  input: string;
  setInput(value: string): void;
  bubbleHidden: boolean;
  setBubbleHidden(hidden: boolean): void;
  /** A reply finished while the panel was closed. */
  unseen: boolean;
};

export const AssistantContext = createContext<AssistantContextValue | null>(
  null,
);

/** The assistant around the page, or null outside the shell or without it. */
export function useAssistantPanel() {
  return useContext(AssistantContext);
}

/**
 * The focus project after a navigation: a new route project becomes the
 * focus (none outside projects); the same route keeps the member's choice.
 */
export function followFocus(
  previousRoute: string | undefined,
  nextRoute: string | undefined,
  focus: string,
) {
  return previousRoute === nextRoute ? focus : (nextRoute ?? "");
}

/** Ctrl+K (Windows, Linux) or Cmd+K (macOS) opens the assistant. */
export function isAssistantShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    event.key.toLowerCase() === "k"
  );
}

export const bubbleHiddenKey = (userId: string) =>
  `orbit.assistant.bubbleHidden.${userId}`;

export function readBubbleHidden(userId: string): boolean {
  try {
    return localStorage.getItem(bubbleHiddenKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function writeBubbleHidden(userId: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(bubbleHiddenKey(userId), "1");
    else localStorage.removeItem(bubbleHiddenKey(userId));
  } catch {
    /* Without storage the choice lasts until the page reloads. */
  }
}

/** The session the personal chat belongs to: one per personal space. */
export function assistantSession(status: AssistantStatus | null) {
  return status?.enabled ? status.personalSpaceId : "";
}
