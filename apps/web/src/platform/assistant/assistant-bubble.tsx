"use client";
import type { Ref } from "react";
import { Sparkles } from "lucide-react";
import { useAssistantPanel } from "./assistant-context";

// The floating button that opens the personal assistant (WP3.8). It sits
// bottom right, above the phone bottom bar where there is one, and shows a
// dot while a reply runs or when one finished with the panel closed.

/** The shortcut as shown to the user on this platform. */
export function shortcutLabel(platform: string) {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl+K";
}

export function AssistantBubble({
  ref,
  aboveNav,
}: {
  ref?: Ref<HTMLButtonElement>;
  aboveNav: boolean;
}) {
  const assistant = useAssistantPanel();
  if (!assistant) return null;
  const de = assistant.locale === "de";
  const working = Boolean(assistant.conversation.activeRunId);
  const dot = assistant.unseen || working;
  const shortcut = shortcutLabel(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const name = de ? "Orbit Assistant öffnen" : "Open Orbit Assistant";
  return (
    <button
      ref={ref}
      type="button"
      className="assistant-bubble"
      data-above-nav={aboveNav ? "true" : undefined}
      data-open={assistant.isOpen ? "true" : undefined}
      aria-label={
        assistant.unseen
          ? `${name} (${de ? "neue Antwort" : "new reply"})`
          : working
            ? `${name} (${de ? "antwortet" : "answering"})`
            : name
      }
      aria-expanded={assistant.isOpen}
      aria-keyshortcuts="Control+K Meta+K"
      title={`${name} (${shortcut})`}
      onClick={() =>
        assistant.isOpen ? assistant.closePanel() : assistant.openPanel()
      }
    >
      <Sparkles aria-hidden="true" />
      {dot && (
        <span
          className="assistant-bubble-dot"
          data-working={working ? "true" : undefined}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
