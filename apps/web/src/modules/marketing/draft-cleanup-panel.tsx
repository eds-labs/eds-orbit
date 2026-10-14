"use client";
import { useEffect, useState } from "react";
import { action, useMutation } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  cleanupConfirmText,
  cleanupDoneText,
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
import { Alert, Button, Modal } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

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
}: {
  role: Role;
  locale: Locale;
  state: CleanupState;
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
  return (
    <>
      <div className="form-actions">
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
    />
  );
}
