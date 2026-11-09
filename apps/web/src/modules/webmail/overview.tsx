"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Inbox } from "lucide-react";
import { useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  webmailPath,
  type ConvertReference,
  type MailboxesResponse,
  type WebmailMailbox,
} from "./api";
import { CONVERT_LINK_PARAMS, parseConvertLink } from "./bridge";
import { ConvertDialog } from "./convert-dialog";
import { WebmailEmbed } from "./embed";
import { GrantEditor } from "./grants";
import { webmailText, type WebmailText } from "./labels";
import styles from "./webmail.module.css";

// The webmail page (ADR 0026): the mailboxes the member was granted, and the
// open one in the embedded client. ?mailbox=<id> is the deep link.

export type MailboxTone = "ok" | "warning" | "error" | "off";

/** Connection and sync as one state, always with words beside the colour. */
export function mailboxStatus(
  mailbox: Pick<WebmailMailbox, "status" | "sync">,
  t: WebmailText,
): { tone: MailboxTone; label: string } {
  if (mailbox.status === "disabled")
    return { tone: "off", label: t.status.disabled };
  if (mailbox.status === "error")
    return { tone: "error", label: t.status.connectionError };
  if (mailbox.sync === "error")
    return { tone: "error", label: t.status.syncError };
  if (mailbox.sync === "backlog")
    return { tone: "warning", label: t.status.backlog };
  return { tone: "ok", label: t.status.ok };
}

/** The server's error code in plain words; a code never reaches the member. */
export const lastErrorText = (code: string | null, t: WebmailText) =>
  code === null ? null : (t.lastError[code] ?? t.lastError.unknown!);

/**
 * The open mailbox: the requested one, else the first. An id the server did
 * not list opens nothing, whether it does not exist or is not granted.
 */
export function selectMailbox(
  mailboxes: readonly WebmailMailbox[],
  requested: string | null,
) {
  if (requested === null) return { mailbox: mailboxes[0] ?? null, missing: false };
  const mailbox = mailboxes.find((m) => m.id === requested) ?? null;
  return { mailbox, missing: mailbox === null };
}

/** Without the right the page does not act on the client's takeover request. */
export const convertHandlerFor = <T,>(
  mailbox: Pick<WebmailMailbox, "capabilities"> | null,
  handler: T,
): T | null => (mailbox?.capabilities.convert ? handler : null);

export function MailboxListView({
  t,
  mailboxes,
  selectedId,
  hrefOf,
}: {
  t: WebmailText;
  mailboxes: readonly WebmailMailbox[];
  selectedId: string | null;
  hrefOf: (id: string) => string;
}) {
  return (
    <nav aria-label={t.list} className={styles.list}>
      <ul>
        {mailboxes.map((mailbox) => {
          const status = mailboxStatus(mailbox, t);
          const problem = lastErrorText(mailbox.lastError, t);
          return (
            <li key={mailbox.id}>
              <Link
                href={hrefOf(mailbox.id)}
                scroll={false}
                className={styles.mailbox}
                aria-current={mailbox.id === selectedId ? "page" : undefined}
              >
                <strong>{mailbox.displayName || mailbox.address}</strong>
                {mailbox.displayName && <span>{mailbox.address}</span>}
                <span className={styles.status}>
                  <span
                    className={`${styles.dot} ${styles[status.tone]}`}
                    aria-hidden="true"
                  />
                  {status.label}
                </span>
                {problem && <small>{problem}</small>}
                {mailbox.sensitive && <Badge tone="warning">{t.sensitive}</Badge>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The page below its heading for each state the mailbox list can be in. */
export function EmptyMailboxes({ t }: { t: WebmailText }) {
  return <Empty icon={Inbox} title={t.empty.title} description={t.empty.body} />;
}

/** Access is gone: words only, since reopening could not work. */
export function WithdrawnNotice({ t, address }: { t: WebmailText; address: string }) {
  return <Alert kind="warning">{t.embed.withdrawn(address)}</Alert>;
}

export function WebmailOverview() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = webmailText(locale);
  const params = useSearchParams();
  const resource = useResource<MailboxesResponse>(
    webmailPath(project.id, "/mailboxes"),
  );
  const data = resource.data;
  const requested = params?.get("mailbox") ?? null;
  const { mailbox, missing } = selectMailbox(data?.mailboxes ?? [], requested);
  const selectedId = mailbox?.id ?? null;
  const canConvert = mailbox?.capabilities.convert ?? false;

  const [convert, setConvert] = useState<{
    mailboxId: string;
    reference: ConvertReference;
  } | null>(null);
  const [managing, setManaging] = useState(false);
  const [withdrawn, setWithdrawn] = useState<{
    id: string;
    address: string;
  } | null>(null);

  const refreshMailboxes = resource.refresh;
  const onWithdrawn = useCallback(
    (lost: { id: string; address: string }) => {
      setWithdrawn(lost);
      refreshMailboxes();
    },
    [refreshMailboxes],
  );
  // Choosing a mailbox is the member's own step, so it may open one again.
  useEffect(() => setWithdrawn(null), [requested]);

  // While a dialog is open a further request is ignored, not queued.
  const onConvert = useCallback(
    (reference: ConvertReference) => {
      if (selectedId)
        setConvert((open) => open ?? { mailboxId: selectedId, reference });
    },
    [selectedId],
  );

  // The fallback link opens the dialog once and leaves the address clean.
  useEffect(() => {
    if (!data || !params?.get("convert")) return;
    const reference = parseConvertLink(params);
    if (reference && canConvert) onConvert(reference);
    const url = new URL(window.location.href);
    for (const name of CONVERT_LINK_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(null, "", url);
  }, [data, params, canConvert, onConvert]);

  const closeConvert = useCallback(() => setConvert(null), []);
  const open =
    convert && convert.mailboxId === selectedId ? convert : null;
  const base = shell.hrefOf("webmail");

  // A mailbox the refetched list still shows does not reopen by itself: the
  // client would refuse again and this would loop.
  const blocked = withdrawn !== null && withdrawn.id === selectedId;
  const withdrawnNotice = withdrawn && (
    <WithdrawnNotice t={t} address={withdrawn.address} />
  );
  const head = (
    <PageHead eyebrow={t.eyebrow} title={t.title} description={t.intro} />
  );
  if (resource.loading && !data)
    return (
      <>
        {head}
        <Loading label={t.loading} />
      </>
    );
  if (!data) {
    if (resource.error?.code === "WEBMAIL_DISABLED")
      return (
        <>
          {head}
          <Empty
            icon={Inbox}
            title={t.moduleOff.title}
            description={t.moduleOff.body}
          />
        </>
      );
    return (
      <>
        {head}
        <ResourceError error={resource.error} retry={resource.refresh} />
      </>
    );
  }
  if (data.mailboxes.length === 0)
    return (
      <>
        {head}
        {withdrawnNotice}
        <EmptyMailboxes t={t} />
      </>
    );

  return (
    <>
      {head}
      <div className={styles.layout}>
        <MailboxListView
          t={t}
          mailboxes={data.mailboxes}
          selectedId={selectedId}
          hrefOf={(id) => `${base}?mailbox=${encodeURIComponent(id)}`}
        />
        <div className={styles.main}>
          {withdrawnNotice}
          {missing && !withdrawn && (
            <Alert kind="warning">{t.notAvailable}</Alert>
          )}
          {mailbox?.capabilities.manage && (
            <div className={styles.mainActions}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManaging(true)}
              >
                {t.manageAccess}
              </Button>
            </div>
          )}
          {mailbox && mailbox.status === "disabled" && (
            <Alert kind="info">{t.mailboxOff}</Alert>
          )}
          {mailbox && mailbox.status !== "disabled" && !mailbox.capabilities.read && (
            <Alert kind="info">{t.noRead}</Alert>
          )}
          {mailbox && !blocked && mailbox.status !== "disabled" && mailbox.capabilities.read && (
            <WebmailEmbed
              t={t}
              projectId={project.id}
              mailboxId={mailbox.id}
              address={mailbox.address}
              origin={data.origin}
              onConvert={convertHandlerFor(mailbox, onConvert)}
              onWithdrawn={onWithdrawn}
            />
          )}
        </div>
      </div>
      {open && (
        <ConvertDialog
          t={t}
          projectId={project.id}
          mailboxId={open.mailboxId}
          reference={open.reference}
          onClose={closeConvert}
        />
      )}
      {managing && mailbox && (
        <Modal
          wide
          title={t.accessOf(mailbox.address)}
          onClose={() => setManaging(false)}
        >
          <GrantEditor t={t} projectId={project.id} mailboxId={mailbox.id} />
        </Modal>
      )}
    </>
  );
}
