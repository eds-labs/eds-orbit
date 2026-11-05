import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@/lib/api";
import { openAssistantPrompt } from "@/platform/shell/home";
import type { AssistantStatus } from "./api";
import {
  AssistantContext,
  assistantSession,
  followFocus,
  isAssistantShortcut,
  readBubbleHidden,
  writeBubbleHidden,
  type AssistantContextValue,
} from "./assistant-context";
import { AssistantBubble, shortcutLabel } from "./assistant-bubble";
import { AssistantPanel } from "./assistant-panel";
import type { AssistantConversation } from "./use-assistant-conversation";

const enabled: AssistantStatus = {
  enabled: true,
  workspaceId: "w1",
  personalSpaceId: "space-1",
  capMicros: 5_000_000,
  autoMemory: true,
};

const conversation = {
  base: "/projects/space-1/chat",
  projectId: "space-1",
  conversationId: "",
  activeRunId: "",
  stream: null,
  pending: false,
  error: "",
  busy: false,
  history: {
    items: [],
    loading: false,
    error: null,
    hasOlder: false,
    showArchived: false,
    setShowArchived: () => {},
    loadOlder: async () => {},
  },
  detail: { data: null, loading: false, error: null },
  open: () => {},
  startNew: () => {},
  send: async () => true,
  cancel: async () => {},
  archive: async () => {},
  refresh: () => {},
  poll: () => {},
  run: async () => {},
  setError: () => {},
} as unknown as AssistantConversation;

function context(
  over: Partial<AssistantContextValue> = {},
): AssistantContextValue {
  return {
    available: true,
    enabled: true,
    status: enabled,
    conversation,
    locale: "en",
    isOpen: false,
    openPanel: () => {},
    closePanel: () => {},
    focusProjectId: "p1",
    setFocusProjectId: () => {},
    projects: [
      { id: "p1", name: "Alpha", workspaceId: "w1" } as Project,
      { id: "p2", name: "Beta", workspaceId: "w1" } as Project,
    ],
    input: "",
    setInput: () => {},
    bubbleHidden: false,
    setBubbleHidden: () => {},
    unseen: false,
    ...over,
  };
}

describe("the assistant across navigation (WP3.8)", () => {
  it("keeps the session (the personal space) when the project changes", () => {
    // The provider sits outside the keyed workspace <div>; the chat it
    // holds is keyed by the personal space only, never by the open project.
    expect(assistantSession(enabled)).toBe("space-1");
    expect(assistantSession({ ...enabled })).toBe(assistantSession(enabled));
    expect(
      assistantSession({
        enabled: false,
        workspaceId: "w1",
        reason: "ASSISTANT_DISABLED_FOR_MEMBER",
      }),
    ).toBe("");
    expect(assistantSession(null)).toBe("");
  });

  it("moves the focus with the open project and keeps the member's choice otherwise", () => {
    expect(followFocus("p1", "p2", "p1")).toBe("p2");
    expect(followFocus("p1", undefined, "p1")).toBe("");
    expect(followFocus("p1", "p1", "p2")).toBe("p2");
  });

  it("opens with Ctrl+K or Cmd+K, not with other combinations", () => {
    const key = (over: Partial<KeyboardEvent>) => ({
      key: "k",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });
    expect(isAssistantShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isAssistantShortcut(key({ metaKey: true, key: "K" }))).toBe(true);
    expect(isAssistantShortcut(key({}))).toBe(false);
    expect(isAssistantShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isAssistantShortcut(key({ ctrlKey: true, altKey: true }))).toBe(
      false,
    );
    expect(isAssistantShortcut(key({ ctrlKey: true, repeat: true }))).toBe(
      false,
    );
    expect(shortcutLabel("MacIntel")).toBe("⌘K");
    expect(shortcutLabel("Win32")).toBe("Ctrl+K");
  });

  it("stores the hide preference per user and survives missing storage", () => {
    // No localStorage in the test runtime: reads are false, writes are no-ops.
    expect(() => writeBubbleHidden("u1", true)).not.toThrow();
    expect(readBubbleHidden("u1")).toBe(false);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    writeBubbleHidden("u1", true);
    expect(readBubbleHidden("u1")).toBe(true);
    expect(readBubbleHidden("u2")).toBe(false);
    writeBubbleHidden("u1", false);
    expect(readBubbleHidden("u1")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("renders the bubble above the phone bar with its state and shortcut", () => {
    const html = renderToStaticMarkup(
      <AssistantContext.Provider value={context({ unseen: true })}>
        <AssistantBubble aboveNav />
      </AssistantContext.Provider>,
    );
    expect(html).toContain('data-above-nav="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toContain("Open Orbit Assistant (new reply)");
    expect(html).toContain("assistant-bubble-dot");
    expect(
      renderToStaticMarkup(
        <AssistantContext.Provider value={context()}>
          <AssistantBubble aboveNav={false} />
        </AssistantContext.Provider>,
      ),
    ).not.toContain("data-above-nav");
  });

  it("renders the open panel with the focus switch, controls and composer", () => {
    const html = renderToStaticMarkup(
      <AssistantContext.Provider
        value={context({ isOpen: true, locale: "de" })}
      >
        <AssistantPanel aboveNav returnFocus={{ current: null }} />
      </AssistantContext.Provider>,
    );
    expect(html).toContain("sheet-above-nav");
    expect(html).toContain('aria-label="Neue Unterhaltung"');
    expect(html).toContain('aria-label="Verlauf"');
    expect(html).toContain('aria-label="Assistent schließen"');
    expect(html).toContain('href="/assistant"');
    expect(html).toContain('href="/account/assistant"');
    expect(html).toContain('<option value="p2">Beta</option>');
    expect(html).toContain('id="assistant-panel-input"');
    expect(html).toContain("Nachricht an den Assistenten");
  });

  it("explains a member without the assistant instead of offering the chat", () => {
    const html = renderToStaticMarkup(
      <AssistantContext.Provider
        value={context({
          isOpen: true,
          enabled: false,
          status: {
            enabled: false,
            workspaceId: "w1",
            reason: "ASSISTANT_DISABLED_FOR_MEMBER",
          },
        })}
      >
        <AssistantPanel aboveNav={false} returnFocus={{ current: null }} />
      </AssistantContext.Provider>,
    );
    expect(html).toContain(
      "Your organization has not enabled the assistant for you.",
    );
    expect(html).not.toContain("assistant-panel-input");
  });

  it("hands the home prompt to the panel, else to the project chat", () => {
    const openPanel = vi.fn();
    const fallback = vi.fn();
    expect(
      openAssistantPrompt(
        "  Draft a post ",
        { enabled: true, openPanel },
        fallback,
      ),
    ).toBe(true);
    expect(openPanel).toHaveBeenCalledWith({ draft: "Draft a post" });
    expect(fallback).not.toHaveBeenCalled();
    openAssistantPrompt("Hello", { enabled: false, openPanel }, fallback);
    openAssistantPrompt("Hello", null, fallback);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(
      openAssistantPrompt("   ", { enabled: true, openPanel }, fallback),
    ).toBe(false);
  });
});
