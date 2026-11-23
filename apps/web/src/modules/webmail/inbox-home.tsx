"use client";

import { useEffect, useRef, useState } from "react";
import type { paths } from "@orbit/api-client";
import { useWorkspace } from "@/components/workspace-context";
import { Alert, Button, Skeleton } from "@/components/ui/primitives";
import { useResource, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { useShell } from "@/platform/shell/shell-context";
import { WidgetResource } from "@/platform/ui/widget-resource";
import { webmailPath, type MailboxesResponse } from "./api";
import styles from "./inbox-home.module.css";
import { mailboxUnreadLabel, unreadTotalLabel } from "./unread-labels";

type InboxSummary =
  paths["/api/projects/{projectId}/webmail/mailboxes/{mailboxId}/inbox-summary"]["get"]["responses"][200]["content"]["application/json"];

const inboxWords = (locale: Locale) =>
  locale === "de"
    ? {
        title: "E-Mail-Posteingang",
        mailbox: "Postfach",
        noMailbox: "Für dich ist kein aktives Postfach zum Lesen freigegeben.",
        refresh: "Aktualisieren",
        unavailable: "Der Posteingang konnte gerade nicht geladen werden.",
        noUnread: "Keine ungelesenen E-Mails",
        unread: (count: number) =>
          count === 1 ? "1 ungelesene E-Mail" : `${count} ungelesene E-Mails`,
        empty: "Der Posteingang ist leer.",
        recent: "Neueste E-Mails",
        unreadMark: "Ungelesen",
        unknownSender: "Unbekannter Absender",
        noSubject: "(Kein Betreff)",
      }
    : {
        title: "Email inbox",
        mailbox: "Mailbox",
        noMailbox: "No active mailbox is shared with you for reading.",
        refresh: "Refresh",
        unavailable: "The inbox could not be loaded right now.",
        noUnread: "No unread emails",
        unread: (count: number) =>
          count === 1 ? "1 unread email" : `${count} unread emails`,
        empty: "The inbox is empty.",
        recent: "Latest emails",
        unreadMark: "Unread",
        unknownSender: "Unknown sender",
        noSubject: "(No subject)",
      };

function InboxMessages({ mailboxId }: { mailboxId: string }) {
  const { project, locale } = useWorkspace();
  const { refreshNavCounts } = useShell();
  const manualRefresh = useRef(false);
  const t = inboxWords(locale);
  const { data, error, loading, refresh } = useResource<InboxSummary>(
    webmailPath(
      project.id,
      `/mailboxes/${encodeURIComponent(mailboxId)}/inbox-summary`,
    ),
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!manualRefresh.current || (!data && !error)) return;
    manualRefresh.current = false;
    refreshNavCounts?.();
  }, [data, error, refreshNavCounts]);

  return (
    <>
      <div className={styles.status}>
        {data && (
          <strong role="status">
            {data.unread ? t.unread(data.unread) : t.noUnread}
          </strong>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            manualRefresh.current = true;
            refresh();
          }}
          disabled={loading}
        >
          {t.refresh}
        </Button>
      </div>
      {error ? (
        <Alert kind="error">{t.unavailable}</Alert>
      ) : !data ? (
        <Skeleton />
      ) : data.messages.length ? (
        <ul className={styles.messages} aria-label={t.recent}>
          {data.messages.map(({ uid, sender, subject, receivedAt, unread }) => (
            <li key={uid}>
              <div className={styles.messageHead}>
                <strong dir="auto">{sender ?? t.unknownSender}</strong>
                {receivedAt && (
                  <time dateTime={receivedAt}>
                    {when(receivedAt, locale, project.timezone)}
                  </time>
                )}
              </div>
              <div className={styles.subject}>
                <span dir="auto">{subject ?? t.noSubject}</span>
                {unread && (
                  <span className={styles.unread}>{t.unreadMark}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t.empty}</p>
      )}
    </>
  );
}

export function WebmailInboxHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const unread = shell.navCounts?.webmail;
  const t = inboxWords(locale);
  const [selectedId, setSelectedId] = useState<string>();
  return (
    <WidgetResource<MailboxesResponse>
      id="home-card-webmail-inbox"
      title={t.title}
      href={shell.hrefOf("webmail")}
      path={webmailPath(project.id, "/mailboxes")}
    >
      {({ mailboxes }) => {
        const readable = mailboxes.filter(
          ({ capabilities, status }) =>
            capabilities.read && status !== "disabled",
        );
        const selected =
          readable.find(({ id }) => id === selectedId) ??
          readable.find(({ status }) => status === "ok") ??
          readable[0];
        if (!selected) return <p>{t.noMailbox}</p>;
        return (
          <>
            {unread && (
              <strong>
                {unreadTotalLabel(unread.total, unread.complete, locale)}
              </strong>
            )}
            {readable.length > 1 ? (
              <label className={styles.mailbox}>
                <span>{t.mailbox}</span>
                <select
                  className="input"
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {readable.map(({ id, address, displayName }) => {
                    const name = displayName
                      ? `${displayName} (${address})`
                      : address;
                    const count = mailboxUnreadLabel(
                      unread?.counts[id],
                      locale,
                    );
                    return (
                      <option key={id} value={id}>
                        {count ? `${name} · ${count}` : name}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : (
              <p className={styles.singleMailbox}>
                {selected.displayName ?? selected.address}
              </p>
            )}
            {selected.status === "ok" ? (
              <InboxMessages key={selected.id} mailboxId={selected.id} />
            ) : (
              <Alert kind="error">{t.unavailable}</Alert>
            )}
          </>
        );
      }}
    </WidgetResource>
  );
}
