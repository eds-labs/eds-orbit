"use client";
import { useState, type RefObject } from "react";
import Link from "next/link";
import {
  BookUser,
  EyeOff,
  History,
  Maximize2,
  MessageCircle,
  Plus,
  X,
} from "lucide-react";
import { Alert, Button } from "@/components/ui/primitives";
import { chatErrorText } from "@/components/chat-errors";
import { Sheet } from "@/platform/ui/sheet";
import {
  ASSISTANT_PAGE,
  PANEL_INPUT_ID,
  useAssistantPanel,
  type AssistantContextValue,
} from "./assistant-context";
import { ConversationHistory, ConversationView } from "./conversation-view";
import { useAssistantVoice, voiceViewProps } from "./voice";

// The personal assistant's panel (WP3.8): a header with the focus project,
// "new conversation", history, the full page and "My context", and the
// conversation below. A non-modal right panel on desktop, a sheet above the
// phone bottom bar.

export const assistantText = (de: boolean) => ({
  title: "Orbit Assistant",
  close: de ? "Assistent schließen" : "Close assistant",
  newConversation: de ? "Neue Unterhaltung" : "New conversation",
  history: de ? "Verlauf" : "History",
  back: de ? "Zur Unterhaltung" : "Back to the conversation",
  fullPage: de ? "Als ganze Seite öffnen" : "Open as full page",
  myContext: de ? "Mein Kontext" : "My context",
  hideBubble: de ? "Schaltfläche ausblenden" : "Hide button",
  hideHint: de
    ? "Mit Strg+K bzw. ⌘K öffnest du den Assistenten weiterhin; unter „Mein Kontext“ blendest du die Schaltfläche wieder ein."
    : "Ctrl+K or ⌘K still opens the assistant; show the button again under “My context”.",
  focus: de ? "Fokus" : "Focus",
  noFocus: de ? "Kein Projekt" : "No project",
  inputLabel: de ? "Nachricht an den Assistenten" : "Message the assistant",
  placeholder: de
    ? "Zum Beispiel: Was ist in meinen Projekten offen?"
    : "For example: What is open in my projects?",
  emptyTitle: de ? "Wie kann ich helfen?" : "How can I help?",
  emptyDescription: de
    ? "Frage projektübergreifend, entscheide Freigaben oder gib Aufträge. Dein Verlauf ist privat."
    : "Ask across your projects, decide approvals or hand out work. Your history is private.",
});

/** The focus project switch, shared by the panel and the full page. */
export function FocusSwitch({
  assistant,
  id,
}: {
  assistant: AssistantContextValue;
  id: string;
}) {
  const t = assistantText(assistant.locale === "de");
  if (!assistant.projects.length) return null;
  return (
    <div className="assistant-focus">
      <label htmlFor={id}>{t.focus}</label>
      <select
        id={id}
        className="input input-compact"
        value={assistant.focusProjectId}
        onChange={(event) => assistant.setFocusProjectId(event.target.value)}
      >
        <option value="">{t.noFocus}</option>
        {assistant.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Why a member without the assistant cannot use it. */
export function DisabledNotice({
  assistant,
}: {
  assistant: AssistantContextValue;
}) {
  const de = assistant.locale === "de";
  const reason =
    assistant.status && !assistant.status.enabled
      ? assistant.status.reason
      : "ASSISTANT_DISABLED";
  return <Alert kind="warning">{chatErrorText(reason, de, true)}</Alert>;
}

export function AssistantPanel({
  aboveNav,
  returnFocus,
}: {
  aboveNav: boolean;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const assistant = useAssistantPanel();
  const [view, setView] = useState<"chat" | "history">("chat");
  const voice = useAssistantVoice(assistant);
  if (!assistant) return null;
  const de = assistant.locale === "de";
  const t = assistantText(de);
  const { conversation } = assistant;
  return (
    <Sheet
      id="assistant-panel"
      open={assistant.isOpen}
      onClose={assistant.closePanel}
      title={t.title}
      className={
        aboveNav ? "assistant-panel sheet-above-nav" : "assistant-panel"
      }
      initialFocus={PANEL_INPUT_ID}
      returnFocus={returnFocus}
      header={
        <div className="sheet-actions">
          {assistant.enabled && (
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t.newConversation}
                title={t.newConversation}
                onClick={() => {
                  conversation.startNew();
                  assistant.setInput("");
                  setView("chat");
                }}
              >
                <Plus aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={view === "history" ? t.back : t.history}
                aria-pressed={view === "history"}
                title={view === "history" ? t.back : t.history}
                onClick={() => setView(view === "history" ? "chat" : "history")}
              >
                {view === "history" ? (
                  <MessageCircle aria-hidden="true" />
                ) : (
                  <History aria-hidden="true" />
                )}
              </Button>
              <Link
                className="button button-ghost button-icon"
                href={
                  conversation.conversationId
                    ? `${ASSISTANT_PAGE}?conversation=${encodeURIComponent(conversation.conversationId)}`
                    : ASSISTANT_PAGE
                }
                aria-label={t.fullPage}
                title={t.fullPage}
              >
                <Maximize2 aria-hidden="true" />
              </Link>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={t.close}
            title={t.close}
            onClick={assistant.closePanel}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      }
    >
      {!assistant.enabled ? (
        <DisabledNotice assistant={assistant} />
      ) : view === "history" ? (
        <ConversationHistory
          conversation={conversation}
          de={de}
          onNew={() => assistant.setInput("")}
          onOpened={() => setView("chat")}
        />
      ) : (
        <>
          <FocusSwitch assistant={assistant} id="assistant-panel-focus" />
          <ConversationView
            conversation={conversation}
            de={de}
            personal
            canEdit={false}
            input={assistant.input}
            setInput={assistant.setInput}
            inputId={PANEL_INPUT_ID}
            {...voiceViewProps(voice, { conversation, input: assistant.input, setInput: assistant.setInput, inputId: PANEL_INPUT_ID, de })}
            inputLabel={t.inputLabel}
            placeholder={t.placeholder}
            label={t.title}
            emptyTitle={t.emptyTitle}
            emptyDescription={t.emptyDescription}
            className="assistant-conversation"
          />
        </>
      )}
      <div className="sheet-foot">
        <Link href="/account/assistant" onClick={assistant.closePanel}>
          <BookUser aria-hidden="true" />
          {t.myContext}
        </Link>
        {!assistant.bubbleHidden && (
          <button
            type="button"
            className="text-button"
            title={t.hideHint}
            onClick={() => {
              assistant.setBubbleHidden(true);
              assistant.closePanel();
            }}
          >
            <EyeOff aria-hidden="true" />
            {t.hideBubble}
          </button>
        )}
      </div>
    </Sheet>
  );
}
