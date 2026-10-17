"use client";
// The member's notifications (WP4.7): a bell with the unread count, polled
// every minute, a list with mark-as-read, and the member's choice per kind.
// Hidden while notifications are off for this installation (404).
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { api, collectionPath, useMutation, useResource, when } from "@/lib/api";
import { Alert, Button, Loading, Modal } from "./ui/primitives";

type Notice = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};
type Notices = { unread: number; items: Notice[] };
type Preferences = {
  email: boolean;
  kinds: Array<{
    kind: string;
    label: { en: string; de: string };
    inApp: boolean;
    email: boolean;
  }>;
};

const POLL_MS = 60_000;

/** "9+" above nine, nothing at zero. */
export function unreadLabel(count: number) {
  return count <= 0 ? "" : count > 9 ? "9+" : String(count);
}

/**
 * Only Orbit paths are followed: a notice never sends a member elsewhere.
 * No backslash, space or control character, since browsers read "/\\x" and
 * "/<tab>/x" as "//x" (the API's ORBIT_PATH rule).
 */
export function safeLink(link: string | null) {
  return link && /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(link)
    ? link
    : null;
}

type BellProps = {
  project: { id: string; timezone: string };
  locale: "en" | "de";
};

/** Rendered in the top bar, outside the workspace context: props only. */
export function NotificationBell({ project, locale }: BellProps) {
  const notices = useResource<Notices>(
    collectionPath(project.id, "notifications"),
  );
  const [open, setOpen] = useState<"list" | "settings" | null>(null);
  const mutation = useMutation(notices.refresh);
  const { refresh } = notices;
  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  if (notices.error?.status === 404 || (!notices.data && !notices.loading))
    return null;
  const de = locale === "de";
  const unread = notices.data?.unread ?? 0;
  const base = `/projects/${encodeURIComponent(project.id)}/notifications`;
  return (
    <>
      <Button
        className="notification-bell"
        variant="ghost"
        size="icon"
        aria-label={
          de
            ? `Benachrichtigungen, ${unread} ungelesen`
            : `Notifications, ${unread} unread`
        }
        onClick={() => setOpen("list")}
      >
        <Bell />
        {unreadLabel(unread) && (
          <span className="notification-count" aria-hidden="true">
            {unreadLabel(unread)}
          </span>
        )}
      </Button>
      {open === "list" && (
        <Modal
          title={de ? "Benachrichtigungen" : "Notifications"}
          onClose={() => setOpen(null)}
        >
          {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
          {notices.data?.items.length ? (
            <div className="member-list">
              {notices.data.items.map((n) => {
                const link = safeLink(n.link);
                return (
                  <div className="member-row" key={n.id}>
                    <div>
                      <strong>{n.readAt ? n.title : `● ${n.title}`}</strong>
                      {n.body && <small>{n.body}</small>}
                      <small>
                        {when(n.createdAt, locale, project.timezone)}
                      </small>
                    </div>
                    <div className="page-actions">
                      {link && (
                        <Button variant="ghost" size="sm" asChild>
                          <a href={link}>{de ? "Öffnen" : "Open"}</a>
                        </Button>
                      )}
                      {!n.readAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutation.pending}
                          onClick={() =>
                            mutation.run(() =>
                              api(`${base}/${encodeURIComponent(n.id)}/read`, {
                                method: "POST",
                                body: "{}",
                              }),
                            )
                          }
                        >
                          {de ? "Gelesen" : "Mark read"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="panel-note">
              {de ? "Keine Benachrichtigungen." : "No notifications."}
            </p>
          )}
          <div className="page-actions">
            {unread > 0 && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    api(`${base}/read-all`, { method: "POST", body: "{}" }),
                  )
                }
              >
                {de ? "Alle gelesen" : "Mark all read"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen("settings")}>
              {de ? "Einstellungen" : "Settings"}
            </Button>
          </div>
        </Modal>
      )}
      {open === "settings" && (
        <NotificationSettings
          project={project}
          locale={locale}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** The PUT body: one choice per kind. */
export function preferencesBody(kinds: Preferences["kinds"]): {
  kinds: Record<string, { inApp: boolean; email: boolean }>;
} {
  return {
    kinds: Object.fromEntries(
      kinds.map((k) => [k.kind, { inApp: k.inApp, email: k.email }]),
    ),
  };
}

function NotificationSettings({
  project,
  locale,
  onClose,
}: BellProps & { onClose(): void }) {
  const de = locale === "de";
  const prefs = useResource<Preferences>(
    collectionPath(project.id, "notification-preferences"),
  );
  const [kinds, setKinds] = useState<Preferences["kinds"] | null>(null);
  const mutation = useMutation(onClose);
  const current = kinds ?? prefs.data?.kinds ?? [];
  const toggle = (kind: string, field: "inApp" | "email") =>
    setKinds(
      current.map((k) => (k.kind === kind ? { ...k, [field]: !k[field] } : k)),
    );
  return (
    <Modal
      title={de ? "Benachrichtigungen einstellen" : "Notification settings"}
      onClose={onClose}
    >
      {prefs.loading ? (
        <Loading />
      ) : !current.length ? (
        <p className="panel-note">
          {de ? "Noch keine Arten." : "No kinds yet."}
        </p>
      ) : (
        <div className="member-list">
          {current.map((k) => (
            <div className="member-row" key={k.kind}>
              <strong>{k.label[locale]}</strong>
              <div className="page-actions">
                <label className="field-check">
                  <input
                    type="checkbox"
                    checked={k.inApp}
                    onChange={() => toggle(k.kind, "inApp")}
                  />
                  In Orbit
                </label>
                <label className="field-check">
                  <input
                    type="checkbox"
                    checked={k.email}
                    disabled={!prefs.data?.email}
                    onChange={() => toggle(k.kind, "email")}
                  />
                  {de ? "E-Mail" : "E-mail"}
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <div className="page-actions">
        <Button variant="ghost" onClick={onClose}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
        <Button
          disabled={mutation.pending || !kinds}
          onClick={() =>
            mutation.run(() =>
              api(
                `/projects/${encodeURIComponent(project.id)}/notification-preferences`,
                {
                  method: "PUT",
                  body: JSON.stringify(preferencesBody(current)),
                },
              ),
            )
          }
        >
          {de ? "Speichern" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
