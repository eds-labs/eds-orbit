"use client";
import { useRef, useState } from "react";
import { useResource } from "@/lib/api";
import { Alert, Badge, Loading } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import {
  mailboxPath,
  settingsApi,
  type GrantMember,
  type WebmailRights,
} from "./api";
import type { WebmailText } from "./labels";
import {
  changeRight,
  hasAnyRight,
  rightLocked,
  RIGHTS,
  rightsOf,
  type Right,
} from "./rights";
import styles from "./webmail.module.css";

// Who may do what in one mailbox. Shown to whoever may change it: the project
// settings and members holding the mailbox's manage right.

export type GrantRow = { member: GrantMember; rights: WebmailRights };

export function GrantEditorView({
  t,
  rows,
  busy,
  error,
  defaultNote = true,
  onChange,
}: {
  t: WebmailText;
  rows: readonly GrantRow[];
  /** The member being saved; every row waits for it. */
  busy: string | null;
  error: string | null;
  /** False where the surrounding page already says nobody has access. */
  defaultNote?: boolean;
  onChange: (userId: string, right: Right, on: boolean) => void;
}) {
  const g = t.grants;
  return (
    <div className={styles.grants}>
      {defaultNote && <p className="field-hint">{t.settings.noAccessDefault}</p>}
      <p className="field-hint">
        <strong>{g.readRequired}</strong>
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {rows.length === 0 ? (
        <p className="field-hint">{g.noMembers}</p>
      ) : (
        <ul className={styles.grantRows}>
          {rows.map(({ member, rights }) => (
            <li key={member.userId}>
              <div className={styles.grantMember}>
                <strong>{member.name}</strong> <span>{member.email}</span>{" "}
                {!hasAnyRight(rights) && <Badge>{g.noAccess}</Badge>}
              </div>
              <div
                className={styles.rights}
                role="group"
                aria-label={member.name}
              >
                {RIGHTS.map((right) => (
                  <label key={right} className={styles.option}>
                    <input
                      type="checkbox"
                      checked={rights[right]}
                      disabled={busy !== null || rightLocked(rights, right)}
                      onChange={(e) =>
                        onChange(member.userId, right, e.target.checked)
                      }
                    />
                    <span>{g.rights[right]}</span>
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GrantEditor({
  t,
  projectId,
  mailboxId,
  defaultNote,
}: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  defaultNote?: boolean;
}) {
  const members = useResource<{ members: GrantMember[] }>(
    mailboxPath(projectId, mailboxId, "/grants"),
  );
  // Saved changes, kept here so that a save does not reload the whole list.
  const [saved, setSaved] = useState<Record<string, WebmailRights>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  if (members.loading && !members.data) return <Loading label={t.loading} />;
  if (!members.data)
    return <ResourceError error={members.error} retry={members.refresh} />;

  const rows = members.data.members.map((member) => ({
    member,
    rights: saved[member.userId] ?? rightsOf(member.grant),
  }));

  async function change(userId: string, right: Right, on: boolean) {
    const row = rows.find((r) => r.member.userId === userId);
    if (!row || lock.current) return;
    const next = changeRight(row.rights, right, on);
    lock.current = true;
    setBusy(userId);
    setError(null);
    try {
      await settingsApi.setGrant(projectId, mailboxId, userId, next);
      setSaved((current) => ({ ...current, [userId]: next }));
    } catch {
      setError(t.grants.failed);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <GrantEditorView
      t={t}
      rows={rows}
      busy={busy}
      error={error}
      defaultNote={defaultNote}
      onChange={change}
    />
  );
}
