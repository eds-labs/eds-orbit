"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import type { SettingsSection } from "@/platform/shell/types";
import { ResourceError } from "@/platform/ui/collection";
import {
  settingsApi,
  webmailPath,
  type SettingsConnection,
  type WebmailSettings,
} from "./api";
import { GrantEditor } from "./grants";
import { webmailText, type WebmailText } from "./labels";
import styles from "./webmail.module.css";

// Which of the project's mailboxes webmail may open, and who gets what
// (ADR 0026, E5). Owners only; the API stays the authority.

const FINANCE_OWNER = "finance";

/** The text for a failed change. */
export function settingsError(error: unknown, t: WebmailText) {
  if (error instanceof ApiError && error.status === 409) return t.settings.conflict;
  if (error instanceof ApiError && error.status === 403) return t.settings.forbidden;
  return t.settings.failed;
}

export const isConflict = (error: unknown) =>
  error instanceof ApiError && error.status === 409;

/** A Finance mailbox is always sensitive: the server enforces it, this shows it. */
export const sensitiveLocked = (connection: SettingsConnection) =>
  connection.owner === FINANCE_OWNER;

export function ConnectionRowView({
  t,
  connection,
  busy,
  confirming,
  showingAccess,
  access,
  onOpen,
  onToggleEnabled,
  onToggleSensitive,
  onAskClose,
  onCancelClose,
  onConfirmClose,
  onToggleAccess,
}: {
  t: WebmailText;
  connection: SettingsConnection;
  busy: boolean;
  confirming: boolean;
  showingAccess: boolean;
  /** The grant editor, while it is open. */
  access: ReactNode;
  onOpen: () => void;
  onToggleEnabled: (on: boolean) => void;
  onToggleSensitive: (on: boolean) => void;
  onAskClose: () => void;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onToggleAccess: () => void;
}) {
  const s = t.settings;
  const { opened, owner } = connection;
  const finance = owner === FINANCE_OWNER;
  const locked = sensitiveLocked(connection);
  return (
    <li className="settings-row">
      <div className={styles.connectionHead}>
        <strong>{connection.address}</strong>{" "}
        {finance && <Badge tone="warning">{s.ownedByFinance}</Badge>}
        {owner && !finance && <Badge>{s.ownedBy(owner)}</Badge>}
        {!opened && <Badge>{s.notOpened}</Badge>}
      </div>
      {finance && <p className="field-hint">{s.financeNote}</p>}
      {!opened ? (
        <Button size="sm" disabled={busy} onClick={onOpen}>
          {s.open}
        </Button>
      ) : (
        <>
          <div className={styles.rights}>
            <label className={styles.option}>
              <input
                type="checkbox"
                role="switch"
                checked={opened.enabled}
                disabled={busy}
                onChange={(e) => onToggleEnabled(e.target.checked)}
              />
              <span>{s.enabled}</span>
            </label>
            <label className={styles.option}>
              <input
                type="checkbox"
                role="switch"
                checked={locked || opened.sensitive}
                disabled={busy || locked}
                aria-describedby={locked ? `locked-${opened.id}` : undefined}
                onChange={(e) => onToggleSensitive(e.target.checked)}
              />
              <span>{s.sensitive}</span>
            </label>
          </div>
          {locked && (
            <p className="field-hint" id={`locked-${opened.id}`}>
              {s.sensitiveLocked}
            </p>
          )}
          <div className={styles.connectionActions}>
            <Button size="sm" variant="outline" onClick={onToggleAccess}>
              {showingAccess ? s.hideAccess : s.showAccess}
            </Button>
            {confirming ? (
              <span className={styles.confirm} role="group" aria-label={s.close}>
                <span>{s.closeConfirm}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={onConfirmClose}
                >
                  {s.close}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelClose}>
                  {s.cancel}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onAskClose}
              >
                {s.close}
              </Button>
            )}
          </div>
          {showingAccess && access}
        </>
      )}
    </li>
  );
}

function WebmailSettingsPanel() {
  const { project, locale } = useWorkspace();
  const t = webmailText(locale);
  const s = t.settings;
  const resource = useResource<WebmailSettings>(
    webmailPath(project.id, "/settings"),
  );
  // Stays on screen during a reload, so an open grant editor is not lost.
  const [data, setData] = useState<WebmailSettings | null>(null);
  useEffect(() => {
    if (resource.data) setData(resource.data);
  }, [resource.data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [access, setAccess] = useState<string | null>(null);
  const lock = useRef(false);

  if (resource.error?.code === "WEBMAIL_DISABLED") return null;
  if (resource.error?.status === 403 || resource.error?.status === 404)
    return null;

  async function run(key: string, task: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    setError(null);
    try {
      await task();
      resource.refresh();
    } catch (e) {
      setError(settingsError(e, t));
      // The version the row holds is stale: load the current one.
      if (isConflict(e)) resource.refresh();
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{s.heading}</h2>
          <p>{s.hint}</p>
        </div>
      </div>
      <p className="panel-note">{s.noAccessDefault}</p>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && resource.loading && <Loading label={t.loading} />}
      {!data && <ResourceError error={resource.error} retry={resource.refresh} />}
      {data && data.connections.length === 0 && (
        <p className="panel-note">{s.none}</p>
      )}
      {data && data.connections.length > 0 && (
        <ul className="settings-rows">
          {data.connections.map((connection) => {
            const { opened, connectionId } = connection;
            const mailboxId = opened?.id ?? "";
            return (
              <ConnectionRowView
                key={connectionId}
                t={t}
                connection={connection}
                busy={busy !== null || resource.loading}
                confirming={confirming === connectionId}
                showingAccess={access === connectionId}
                access={
                  opened ? (
                    <GrantEditor
                      t={t}
                      projectId={project.id}
                      mailboxId={mailboxId}
                      defaultNote={false}
                    />
                  ) : null
                }
                onOpen={() =>
                  run(connectionId, () =>
                    settingsApi.open(project.id, connectionId),
                  )
                }
                onToggleEnabled={(enabled) =>
                  opened &&
                  run(connectionId, () =>
                    settingsApi.update(project.id, mailboxId, {
                      version: opened.version,
                      enabled,
                    }),
                  )
                }
                onToggleSensitive={(sensitive) =>
                  opened &&
                  run(connectionId, () =>
                    settingsApi.update(project.id, mailboxId, {
                      version: opened.version,
                      sensitive,
                    }),
                  )
                }
                onAskClose={() => setConfirming(connectionId)}
                onCancelClose={() => setConfirming(null)}
                onConfirmClose={() => {
                  setConfirming(null);
                  setAccess(null);
                  void run(connectionId, () =>
                    settingsApi.close(project.id, mailboxId),
                  );
                }}
                onToggleAccess={() =>
                  setAccess((current) =>
                    current === connectionId ? null : connectionId,
                  )
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Joins the platform's Integrations section of the project settings. */
export const webmailSettings: readonly SettingsSection[] = [
  {
    tab: {
      key: "integrations",
      label: { en: "Integrations", de: "Integrationen" },
      order: 40,
    },
    description: {
      en: "Which mailboxes open in Webmail.",
      de: "Welche Postfächer in Webmail geöffnet werden.",
    },
    order: 30,
    useSection() {
      const { isOwner } = useWorkspace();
      const module = useShell().modules.find((m) => m.id === "webmail");
      if (!module?.enabled) return null;
      // webmail.settings belongs to the owner; the module role wins if advertised.
      const owner = module.access ? module.access === "owner" : isOwner;
      return owner ? { content: <WebmailSettingsPanel /> } : null;
    },
  },
];
