"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

/** A mailbox in the menu: its name and address, and its state unless it is fine. */
export function mailboxOptionLabel(mailbox: WebmailMailbox, t: WebmailText) {
  const name = mailbox.displayName
    ? `${mailbox.displayName} (${mailbox.address})`
    : mailbox.address;
  const status = mailboxStatus(mailbox, t);
  const notes = [
    ...(status.tone === "ok" ? [] : [status.label]),
    ...(mailbox.sensitive ? [t.sensitive] : []),
  ];
  return notes.length ? `${name} · ${notes.join(" · ")}` : name;
}

/**
 * The open mailbox with its state, and a menu to switch to another one. A
 * single mailbox needs no menu. Choosing one changes ?mailbox=, the deep link.
 */
export function MailboxPicker({
  t,
  mailboxes,
  selected,
  onSelect,
}: {
  t: WebmailText;
  mailboxes: readonly WebmailMailbox[];
  selected: WebmailMailbox | null;
  onSelect: (id: string) => void;
}) {
  const status = selected ? mailboxStatus(selected, t) : null;
  const problem = selected ? lastErrorText(selected.lastError, t) : null;
  return (
    <div className={styles.picker}>
      {mailboxes.length > 1 || selected === null ? (
        <label className={styles.pickerField}>
          <span>{t.picker}</span>
          <select
            className="input"
            value={selected?.id ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            {selected === null && (
              <option value="" disabled>
                {t.pickerPlaceholder}
              </option>
            )}
            {mailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailboxOptionLabel(mailbox, t)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className={styles.pickerField}>
          <span>{t.picker}</span>
          <strong>
            {selected.displayName
              ? `${selected.displayName} (${selected.address})`
              : selected.address}
          </strong>
        </div>
      )}
      {/* div, not p: the page head styles every paragraph as its intro. */}
      {selected && status && (
        <div className={styles.status}>
          <span
            className={`${styles.dot} ${styles[status.tone]}`}
            aria-hidden="true"
          />
          {status.label}
          {problem && <small>{problem}</small>}
          {selected.sensitive && <Badge tone="warning">{t.sensitive}</Badge>}
        </div>
      )}
    </div>
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
  const router = useRouter();
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
    const request = parseConvertLink(params);
    if (request && canConvert && request.mailboxId === selectedId)
      onConvert(request.reference);
    const url = new URL(window.location.href);
    for (const name of CONVERT_LINK_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(null, "", url);
  }, [data, params, canConvert, selectedId, onConvert]);

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

  // The client needs every pixel, so this page opts out of the shell's width
  // cap (globals.css, `data-page-width`) and keeps its controls in the head.
  return (
    <div className={styles.page} data-page-width="full">
      <PageHead eyebrow={t.eyebrow} title={t.title} description={t.intro}>
        <MailboxPicker
          t={t}
          mailboxes={data.mailboxes}
          selected={mailbox}
          onSelect={(id) =>
            router.push(`${base}?mailbox=${encodeURIComponent(id)}`, {
              scroll: false,
            })
          }
        />
        {mailbox?.capabilities.manage && (
          <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
            {t.manageAccess}
          </Button>
        )}
      </PageHead>
      <div className={styles.main}>
        {withdrawnNotice}
        {missing && !withdrawn && (
          <Alert kind="warning">{t.notAvailable}</Alert>
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
          <GrantEditor
            t={t}
            projectId={project.id}
            mailboxId={mailbox.id}
            restricted
          />
        </Modal>
      )}
    </div>
  );
}
