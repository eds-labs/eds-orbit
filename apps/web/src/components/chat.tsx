"use client";
import { takeAssistantDraft } from "@/platform/shell/assistant-draft";
import { useContext, useEffect, useState } from "react";
import { Badge } from "./ui/primitives";
import { PageHead } from "@/platform/ui/collection";
import { ShellContext } from "@/platform/shell/shell-context";
import type { ChatHost } from "@/platform/assistant/extensions";
import { useAssistantConversation } from "@/platform/assistant/use-assistant-conversation";
import {
  ConversationHistory,
  ConversationView,
} from "@/platform/assistant/conversation-view";
import { useWorkspace } from "./workspace-context";

/**
 * Orbit Chat in one project (project mode, /p/:id/assistant): a thin page
 * over the shared conversation hook and view (WP3.8). Its URL, deep links
 * (`?conversation=`), tools and limits are unchanged (D-10).
 */
export function OrbitChat() {
  const { project, identity, locale, canEdit } = useWorkspace();
  const de = locale === "de";
  const conversation = useAssistantConversation({
    projectId: project.id,
    storageKey: `orbit.chat.${identity.user.id}.${project.id}`,
    readLink: true,
    de,
  });
  const [input, setInput] = useState("");
  // A message typed on the project home opens here for review; never sent
  // automatically.
  useEffect(() => {
    const draft = takeAssistantDraft(project.id);
    if (draft) setInput(draft);
  }, [project.id]);
  // Module chat parts (WP2.3): message cards, sections below the messages.
  const shell = useContext(ShellContext);
  const extensions = shell?.chat ?? [];
  const templates = extensions.flatMap(
    (extension) =>
      extension.templates?.({
        projectName: project.name,
        de,
        canEdit: extension.access
          ? ["owner", "editor"].includes(extension.access)
          : canEdit,
        features: shell?.features ?? {},
      }) ?? [],
  );
  const moduleCards = Object.assign(
    {},
    ...extensions.map((extension) => extension.messageCards ?? {}),
  );
  const host: ChatHost = {
    conversation: conversation.detail.data,
    pending: conversation.pending,
    de,
    run: conversation.run,
  };
  const detail = conversation.detail.data;
  const { poll } = conversation;
  useEffect(() => {
    if (
      !extensions.some((extension) =>
        Boolean(detail && extension.busy?.(detail)),
      ) &&
      !detail?.proposals.some(
        (proposal) =>
          proposal.status === "confirmed" &&
          ["queued", "running", "retry_scheduled"].includes(
            proposal.action?.status ?? "",
          ),
      )
    )
      return;
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, poll]);
  return (
    <>
      <PageHead
        title="Orbit Chat"
        description={
          de
            ? "Projektbezogene Antworten, Quellen und prüfbare Aktionen."
            : "Project answers, sources, and reviewable actions."
        }
      />
      {extensions.map((extension, index) =>
        extension.navigation ? <extension.navigation key={index} /> : null,
      )}
      <div className="chat-context">
        <Badge tone="blue">{project.name}</Badge>
        <span>
          {de ? "Privater Verlauf · Projekt" : "Private history · Project"}
        </span>
      </div>
      <div className="chat-shell">
        <ConversationHistory
          conversation={conversation}
          de={de}
          onNew={() => setInput("")}
        />
        <ConversationView
          conversation={conversation}
          de={de}
          canEdit={canEdit}
          input={input}
          setInput={setInput}
          inputId="orbit-chat-input"
          inputLabel={de ? "Nachricht an Orbit" : "Message Orbit"}
          placeholder={
            de
              ? "Zum Beispiel: Was blockiert die nächsten Beiträge?"
              : "For example: What blocks the next posts?"
          }
          label="Orbit Chat"
          emptyTitle={de ? "Wie kann Orbit helfen?" : "How can Orbit help?"}
          emptyDescription={
            de
              ? "Frage nach dem Projektstand oder plane einen prüfbaren Entwurf."
              : "Ask about project status or plan a reviewable draft."
          }
          templates={templates}
          moduleCards={moduleCards}
          afterMessages={extensions.flatMap((extension) =>
            extension.afterMessages ? [extension.afterMessages] : [],
          )}
          host={host}
        />
      </div>
    </>
  );
}
