"use client";
import { useRef, useState } from "react";
import { Alert, Button, Modal, Textarea } from "@/components/ui/primitives";
import { errorCode, errorText } from "./lists";
import type { FinanceText } from "./labels";

// The confirm dialog of every correction (reverse an entry, void an invoice
// or a payment): a reason is required, one request runs at a time and a
// failure stays in the dialog with a readable message.

/** True when the reason may be sent. */
export const reasonValid = (reason: string) => reason.trim().length > 0;

/** The dialog's content, apart from the modal shell (also what tests render). */
export function ReasonForm({
  t,
  body,
  confirmLabel,
  reason,
  pending,
  error,
  onReason,
  onConfirm,
  onCancel,
}: {
  t: FinanceText;
  body: string;
  confirmLabel: string;
  reason: string;
  pending: boolean;
  error: string | null;
  onReason: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = t.manage;
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reasonValid(reason) && !pending) onConfirm();
      }}
    >
      <p>{body}</p>
      <label>
        <span>{m.reason}</span>
        <Textarea
          required
          rows={3}
          maxLength={1000}
          value={reason}
          aria-describedby="finance-reason-hint"
          onChange={(e) => onReason(e.target.value)}
        />
        <small className="field-hint" id="finance-reason-hint">
          {m.reasonHint}
        </small>
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="settings-row-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.cancel}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!reasonValid(reason) || pending}
        >
          {pending ? m.working : confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Asks for a reason, then runs `run(reason)`. The dialog closes (`onDone`)
 * when it succeeds; a 409 VERSION_CONFLICT asks for a reload instead.
 */
export function ReasonDialog({
  t,
  title,
  body,
  confirmLabel,
  run,
  onDone,
  onClose,
}: {
  t: FinanceText;
  title: string;
  body: string;
  confirmLabel: string;
  run: (reason: string) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function confirm() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await run(reason.trim());
      onDone();
    } catch (e) {
      setError(
        errorCode(e) === "VERSION_CONFLICT"
          ? t.manage.conflict
          : errorText(e, t),
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <ReasonForm
        t={t}
        body={body}
        confirmLabel={confirmLabel}
        reason={reason}
        pending={pending}
        error={error}
        onReason={setReason}
        onConfirm={confirm}
        onCancel={onClose}
      />
    </Modal>
  );
}
