"use client";
import { useEffect, useState } from "react";
import { action, useMutation } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  cleanupConfirmText,
  cleanupDoneText,
  cleanupItemText,
  cleanupRestoredText,
  confirmCleanup,
  initialCleanupState,
  loadCleanups,
  openCleanupPreview,
  saveCleanups,
  undoCleanup,
  type CleanupCall,
  type CleanupState,
} from "./draft-cleanup";
import { Alert, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import {
  ChannelLabel,
  channelInfo,
  useChannelDirectory,
  type ChannelEntry,
} from "./channel-names";
import { marketingText } from "./labels";

type Role = "owner" | "editor" | "viewer";

/** The cleanup button, its confirmation dialog and the undo notes; no state of its own. */
export function DraftCleanupView({
  role,
  locale,
  state,
  pending,
  error,
  onPreview,
  onConfirm,
  onClose,
  onUndo,
  channels = new Map(),
}: {
  role: Role;
  locale: Locale;
  state: CleanupState;
  /** Channel names for the drafts the preview lists. */
  channels?: ReadonlyMap<string, ChannelEntry>;
  pending: boolean;
  error: string | null;
  onPreview: () => void;
  onConfirm: () => void;
  onClose: () => void;
  onUndo: (cleanupId: string) => void;
}) {
  if (role !== "owner") return null;
  const de = locale === "de";
  const { preview } = state;
  const anything = Boolean(preview?.content.total || preview?.missions.total);
  const items = preview?.items ?? [];
  return (
    <>
      <p className="panel-note">{marketingText(locale).approvals.cleanupHint}</p>
      <div className="form-actions approval-actions">
        <Button variant="outline" disabled={pending} onClick={onPreview}>
          {de ? "Alte Entwürfe archivieren" : "Archive old drafts"}
        </Button>
      </div>
      {error && !preview && <Alert kind="error">{error}</Alert>}
      {state.done.map((c) => (
        <Alert key={c.cleanupId} kind="success">
          <p>{cleanupDoneText(c, locale)}</p>
          <div className="form-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onUndo(c.cleanupId)}
            >
              {de ? "Rückgängig" : "Undo"}
            </Button>
          </div>
        </Alert>
      ))}
      {state.restored && (
        <Alert kind="success">
          {cleanupRestoredText(state.restored, locale)}
        </Alert>
      )}
      {preview && (
        <Modal
          title={de ? "Alte Entwürfe archivieren" : "Archive old drafts"}
          onClose={onClose}
        >
          {state.changed && (
            <Alert kind="warning">
              {de
                ? "Die Zahlen haben sich inzwischen geändert. Bitte prüfe sie erneut."
                : "The counts changed in the meantime. Please check them again."}
            </Alert>
          )}
          {anything ? (
            cleanupConfirmText(preview, locale).map((line) => (
              <p key={line}>{line}</p>
            ))
          ) : (
            <p>
              {de
                ? "Es gibt keine alten Entwürfe zum Archivieren."
                : "There are no old drafts to archive."}
            </p>
          )}
          {items.length > 0 && (
            <details className="approval-history">
              <summary>
                {de
                  ? `Jeder Entwurf im Einzelnen (${items.length})`
                  : `Each draft (${items.length})`}
              </summary>
              <ul className="cleanup-items">
                {items.map((item) => (
                  <li key={item.contentId}>
                    <strong>
                      {item.title || (de ? "Ohne Titel" : "Untitled")}
                    </strong>
                    {item.channel && (
                      <ChannelLabel
                        info={channelInfo(item.channel, channels, locale)}
                      />
                    )}
                    <span className="field-hint">
                      {cleanupItemText(item, locale)}
                    </span>
                  </li>
                ))}
              </ul>
              {preview?.truncated && (
                <p className="panel-note">
                  {de
                    ? "Weitere Entwürfe sind nicht einzeln aufgeführt; die Zahlen oben zählen alle."
                    : "More drafts are not listed one by one; the counts above include all of them."}
                </p>
              )}
            </details>
          )}
          {error && <Alert kind="error">{error}</Alert>}
          <div className="form-actions">
            <Button variant="outline" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </Button>
            {anything && (
              <Button disabled={pending} onClick={onConfirm}>
                {de ? "Archivieren" : "Archive"}
              </Button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

const sessionStore = () => {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
};

/**
 * The owner's clean start on the approvals page: archives every old draft and
 * the ready missions left without work after a preview of the counts.
 * Archiving is reversible; the last cleanups of this tab keep their
 * "Rückgängig" across a reload.
 */
export function DraftCleanup() {
  const { locale, project, isOwner, canEdit, refresh } = useWorkspace();
  const mutation = useMutation(refresh);
  const channels = useChannelDirectory();
  const [state, setState] = useState<CleanupState>(initialCleanupState);
  // Saving starts only once this project's list was read, so the empty
  // first render never overwrites what a reload should bring back.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    setState((s) => ({ ...s, done: loadCleanups(sessionStore(), project.id) }));
    setLoadedFor(project.id);
  }, [project.id]);
  useEffect(() => {
    if (loadedFor === project.id)
      saveCleanups(sessionStore(), project.id, state.done);
  }, [loadedFor, project.id, state.done]);
  const call: CleanupCall = (name, input) => action(project.id, name, input);
  const step = (next: () => Promise<CleanupState>) =>
    mutation.run(next).then((result) => {
      if (result) setState(result);
    });
  return (
    <DraftCleanupView
      role={isOwner ? "owner" : canEdit ? "editor" : "viewer"}
      locale={locale}
      state={state}
      pending={mutation.pending}
      error={mutation.error}
      onPreview={() => step(() => openCleanupPreview(state, call))}
      onConfirm={() => step(() => confirmCleanup(state, call))}
      onClose={() => {
        mutation.clear();
        setState((s) => ({ ...s, preview: null, changed: false }));
      }}
      onUndo={(cleanupId) => step(() => undoCleanup(state, call, cleanupId))}
      channels={channels}
    />
  );
}
