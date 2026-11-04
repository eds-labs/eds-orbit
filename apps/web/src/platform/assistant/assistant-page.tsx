"use client";
import Link from "next/link";
import { BookUser } from "lucide-react";
import { Loading } from "@/components/ui/primitives";
import { NotFound } from "@/platform/shell/not-found";
import { PageHead } from "@/platform/ui/collection";
import { useStandalone } from "@/platform/shell/standalone-context";
import { PAGE_INPUT_ID, useAssistantPanel } from "./assistant-context";
import { assistantText, DisabledNotice, FocusSwitch } from "./assistant-panel";
import { ConversationHistory, ConversationView } from "./conversation-view";
import { useAssistantVoice, voiceViewProps } from "./voice";

/**
 * The personal assistant as a full page (/assistant, WP3.8). It shares the
 * conversation with the panel; `?conversation=` opens one. The project chat
 * stays at /p/:id/assistant.
 */
export function AssistantPage() {
  const { t: shellText, locale } = useStandalone();
  const assistant = useAssistantPanel();
  const voice = useAssistantVoice(assistant);
  const de = locale === "de";
  const t = assistantText(de);
  if (!assistant) return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!assistant.available) return <NotFound t={shellText} project={false} />;
  const { conversation } = assistant;
  return (
    <div className="assistant-page">
      <PageHead
        title={t.title}
        description={
          de
            ? "Dein persönlicher Assistent über alle Projekte. Der Verlauf ist privat."
            : "Your personal assistant across projects. The history is private."
        }
      >
        <Link className="button button-outline" href="/account/assistant">
          <BookUser aria-hidden="true" />
          {t.myContext}
        </Link>
      </PageHead>
      {!assistant.enabled ? (
        <DisabledNotice assistant={assistant} />
      ) : (
        <>
          <FocusSwitch assistant={assistant} id="assistant-page-focus" />
          <div className="chat-shell">
            <ConversationHistory
              conversation={conversation}
              de={de}
              onNew={() => assistant.setInput("")}
            />
            <ConversationView
              conversation={conversation}
              de={de}
              personal
              canEdit={false}
              input={assistant.input}
              setInput={assistant.setInput}
              inputId={PAGE_INPUT_ID}
              {...voiceViewProps(voice, { conversation, input: assistant.input, setInput: assistant.setInput, inputId: PAGE_INPUT_ID, de })}
              inputLabel={t.inputLabel}
              placeholder={t.placeholder}
              label={t.title}
              emptyTitle={t.emptyTitle}
              emptyDescription={t.emptyDescription}
            />
          </div>
        </>
      )}
    </div>
  );
}
