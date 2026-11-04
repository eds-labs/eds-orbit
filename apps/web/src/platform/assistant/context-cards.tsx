"use client";
import { useId, useState } from "react";
import { BookmarkCheck, CircleAlert, CircleCheck, Undo2 } from "lucide-react";
import { Alert, Badge, Button, Textarea } from "@/components/ui/primitives";
import { chatErrorOf } from "@/components/chat-errors";
import {
  CONTEXT_MAX_CHARS,
  contextApiFor,
  type ChatCard,
  type ChatNotice,
} from "./api";
import { ProjectBadge } from "./project-cards";
import { useAssistantPanel } from "./assistant-context";

// Personal context in the conversation (D-17, WP3.7): the "Remembered: …"
// notice of an automatic save with Undo, and the proposal card of the
// fallback mode, which only the user's click saves.

export const categoryLabel = (category: string, de: boolean) =>
  (
    ({
      preference: ["Preference", "Vorliebe"],
      project_note: ["Project note", "Projektnotiz"],
      decision: ["Decision", "Entscheidung"],
      workflow: ["Workflow", "Arbeitsweise"],
    }) as Record<string, [string, string]>
  )[category]?.[de ? 1 : 0] ?? category;

/** Undoes an automatic save: the entry is deleted. */
export function undoContextSave(entryId: string, workspaceId?: string) {
  return contextApiFor(workspaceId).remove(entryId);
}

/** The organization of the conversation: the provider's resolved status. */
export function useConversationWorkspace() {
  return useAssistantPanel()?.status?.workspaceId;
}

/** The text of a notice message without its cards. */
export function noticeText(notice: ChatNotice, fallback: string, de: boolean) {
  const text = notice.text || fallback;
  switch (notice.kind) {
    case "context_saved":
      return de ? `Gemerkt: ${text}` : `Remembered: ${text}`;
    case "work_order_finished":
      return text || (de ? "Auftrag abgeschlossen." : "Work order finished.");
    case "work_order_failed":
      return text || (de ? "Auftrag fehlgeschlagen." : "Work order failed.");
  }
}

export function NoticeBody({
  notice,
  text,
  de,
}: {
  notice: ChatNotice;
  text: string;
  de: boolean;
}) {
  const workspaceId = useConversationWorkspace();
  const [undone, setUndone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const Icon =
    notice.kind === "context_saved"
      ? BookmarkCheck
      : notice.kind === "work_order_failed"
        ? CircleAlert
        : CircleCheck;
  return (
    <div className="chat-notice-body">
      <p>
        <Icon aria-hidden="true" />
        <span>
          {undone
            ? de
              ? "Nicht mehr gemerkt."
              : "No longer remembered."
            : noticeText(notice, text, de)}
        </span>
      </p>
      {notice.kind === "context_saved" && notice.entryId && !undone && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              await undoContextSave(notice.entryId!, workspaceId);
              setUndone(true);
            } catch (cause) {
              setError(chatErrorOf(cause, de, true));
            } finally {
              setPending(false);
            }
          }}
        >
          <Undo2 aria-hidden="true" />
          {de ? "Rückgängig" : "Undo"}
        </Button>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

/** "Remember: …?" with Save, Edit and Dismiss (fallback mode, D-17). */
export function ContextProposalCard({
  card,
  de,
  initial = "open",
}: {
  card: ChatCard;
  de: boolean;
  /** For tests: the state the card starts in. */
  initial?: "open" | "editing" | "saved" | "dismissed";
}) {
  const proposal = card.contextProposal;
  const workspaceId = useConversationWorkspace();
  const [state, setState] = useState(initial);
  const [text, setText] = useState(proposal?.text ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  if (!proposal || state === "dismissed") return null;
  async function save() {
    if (!proposal || !text.trim()) return;
    setPending(true);
    setError("");
    try {
      await contextApiFor(workspaceId).create({
        category: proposal.category,
        text: text.trim(),
        projectId: proposal.projectId,
      });
      setState("saved");
    } catch (cause) {
      setError(chatErrorOf(cause, de, true));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="chat-card chat-context-proposal">
      <div className="chat-card-head">
        <Badge tone="blue">{categoryLabel(proposal.category, de)}</Badge>
        <ProjectBadge projectId={proposal.projectId ?? card.projectId} />
      </div>
      {state === "saved" ? (
        <p>
          {de ? "Gemerkt: " : "Remembered: "}
          {text.trim()}
        </p>
      ) : state === "editing" ? (
        <>
          <label htmlFor={inputId} className="sr-only">
            {de ? "Text zum Merken" : "Text to remember"}
          </label>
          <Textarea
            id={inputId}
            value={text}
            maxLength={CONTEXT_MAX_CHARS}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
        </>
      ) : (
        <p>
          {de ? "Merken: " : "Remember: "}
          {proposal.text}?
        </p>
      )}
      {state !== "saved" && (
        <div className="chat-card-actions">
          <Button
            size="sm"
            disabled={pending || !text.trim()}
            onClick={() => void save()}
          >
            {de ? "Speichern" : "Save"}
          </Button>
          {state !== "editing" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setState("editing")}
            >
              {de ? "Bearbeiten" : "Edit"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setState("dismissed")}
          >
            {de ? "Verwerfen" : "Dismiss"}
          </Button>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}
