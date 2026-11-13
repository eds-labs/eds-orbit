"use client";
// The project's mailboxes (WP4.7): owners connect existing mailboxes over
// SMTP (sending) and IMAP (receiving), one per address. The password goes in
// once and is never shown again; the check logs in to both sides and sends
// nothing. A mailbox a live support inbox answers from cannot be removed.
import { useState } from "react";
import { Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  when,
} from "@/lib/api";
import { Alert, Badge, Button, Modal, Status } from "./ui/primitives";
import { DataForm, type FormField } from "@/platform/ui/form";
import type { Locale } from "@/lib/i18n";
import { useWorkspace } from "./workspace-context";

type Inbound = { checkedAt: string | null; lastError: string | null } | null;
type Connection = { id: string; data: Record<string, any> };
type EmailStatus = {
  enabled: boolean;
  live: boolean;
  connection: Connection | null;
  inbound: Inbound;
  mailboxes?: Array<{
    connection: Connection;
    default: boolean;
    inUse: number;
    inbound: Inbound;
  }>;
};

/** The action body from the form: ports as numbers, empty fields left out. */
export function emailConnectBody(v: Record<string, unknown>) {
  const text = (key: string) => String(v[key] ?? "").trim();
  return {
    smtpHost: text("smtpHost"),
    smtpPort: Number(text("smtpPort") || 465),
    smtpTls: text("smtpTls") || "implicit",
    imapHost: text("imapHost"),
    imapPort: Number(text("imapPort") || 993),
    imapTls: text("imapTls") || "implicit",
    username: text("username"),
    fromAddress: text("fromAddress"),
    ...(text("fromName") ? { fromName: text("fromName") } : {}),
    password: String(v.password ?? ""),
  };
}

type ServerTls = "implicit" | "starttls";
export type MailServerPreset = {
  smtpHost: string;
  smtpPort: number;
  smtpTls: ServerTls;
  imapHost: string;
  imapPort: number;
  imapTls: ServerTls;
};

/** The SMTP host as a grouping key: trimmed, case-insensitive. */
const hostKey = (data: Record<string, unknown>) =>
  String(data.smtpHost ?? "")
    .trim()
    .toLowerCase();

/**
 * Mailboxes by SMTP host, hosts in first-connected order, mailboxes in the
 * order received. A group shows the spelling of its first mailbox. A mailbox
 * without an SMTP host lands in a last group with an empty host, never lost.
 * The preset of a group is the server settings of its first mailbox and
 * nothing else: no user name, address or password.
 */
export function serverGroups<
  T extends { connection: { data: Record<string, unknown> } },
>(
  mailboxes: readonly T[],
): Array<{ host: string; preset: MailServerPreset; mailboxes: T[] }> {
  const groups = new Map<
    string,
    { host: string; preset: MailServerPreset; mailboxes: T[] }
  >();
  for (const m of mailboxes) {
    const data = m.connection.data;
    const key = hostKey(data);
    let group = groups.get(key);
    if (!group) {
      const tls = (value: unknown): ServerTls =>
        value === "starttls" ? "starttls" : "implicit";
      group = {
        host: String(data.smtpHost ?? "").trim(),
        preset: {
          smtpHost: String(data.smtpHost ?? "").trim(),
          smtpPort: Number(data.smtpPort) || 465,
          smtpTls: tls(data.smtpTls),
          imapHost: String(data.imapHost ?? "").trim(),
          imapPort: Number(data.imapPort) || 993,
          imapTls: tls(data.imapTls),
        },
        mailboxes: [],
      };
      groups.set(key, group);
    }
    group.mailboxes.push(m);
  }
  // The group without a host goes last, under the card's general heading.
  const all = [...groups.values()];
  return [...all.filter((g) => g.host), ...all.filter((g) => !g.host)];
}

/** The form fields of a mailbox; a preset fills host, port and TLS of a new one. */
export function mailboxFields(
  current: Record<string, any> | null,
  locale: Locale,
  preset?: MailServerPreset,
): FormField[] {
  const de = locale === "de";
  const c = current ?? undefined;
  const p = c ? undefined : preset;
  const tls = [
    { value: "implicit", label: "TLS (implicit)" },
    { value: "starttls", label: "STARTTLS" },
  ];
  return [
    {
      name: "fromAddress",
      label: de ? "Adresse" : "Address",
      type: "email",
      required: true,
      value: c?.fromAddress ?? "",
    },
    {
      name: "fromName",
      label: de ? "Absendername" : "Sender name",
      value: c?.fromName ?? "",
    },
    {
      name: "username",
      label: de ? "Benutzername" : "User name",
      required: true,
      value: c?.username ?? "",
    },
    {
      name: "password",
      label: de ? "Passwort" : "Password",
      type: "password",
      required: true,
    },
    {
      name: "smtpHost",
      label: de ? "SMTP-Server" : "SMTP server",
      required: true,
      value: c?.smtpHost ?? p?.smtpHost ?? "",
      heading: "SMTP",
    },
    {
      name: "smtpPort",
      label: de ? "SMTP-Port" : "SMTP port",
      type: "number",
      value: c?.smtpPort ?? p?.smtpPort ?? 465,
    },
    {
      name: "smtpTls",
      label: de ? "SMTP-Sicherheit" : "SMTP security",
      type: "select",
      value: c?.smtpTls ?? p?.smtpTls ?? "implicit",
      options: tls,
    },
    {
      name: "imapHost",
      label: de ? "IMAP-Server" : "IMAP server",
      required: true,
      value: c?.imapHost ?? p?.imapHost ?? "",
      heading: "IMAP",
    },
    {
      name: "imapPort",
      label: de ? "IMAP-Port" : "IMAP port",
      type: "number",
      value: c?.imapPort ?? p?.imapPort ?? 993,
    },
    {
      name: "imapTls",
      label: de ? "IMAP-Sicherheit" : "IMAP security",
      type: "select",
      value: c?.imapTls ?? p?.imapTls ?? "implicit",
      options: tls,
    },
  ];
}

type MailboxEntry = NonNullable<EmailStatus["mailboxes"]>[number];

/** One mailbox row; the same markup in the flat and the grouped list. */
function MailboxRow({
  m,
  de,
  locale,
  timezone,
  pending,
  onCheck,
  onEdit,
  onRemove,
}: {
  m: MailboxEntry;
  de: boolean;
  locale: Locale;
  timezone: string;
  pending: boolean;
  onCheck: (m: MailboxEntry) => void;
  onEdit: (m: MailboxEntry) => void;
  onRemove: (m: MailboxEntry) => void;
}) {
  return (
    <li>
      <div className="detail-summary">
        <Status value={m.connection.data.status || "not_configured"} />
        <strong>{m.connection.data.fromAddress}</strong>
        {m.default && <Badge tone="blue">{de ? "Standard" : "Default"}</Badge>}
        {m.inUse > 0 && (
          <span>
            {de
              ? `Von ${m.inUse} Posteingang genutzt`
              : `Used by ${m.inUse} inbox${m.inUse > 1 ? "es" : ""}`}
          </span>
        )}
      </div>
      {m.inbound && (
        <small>
          {de ? "Zuletzt abgerufen: " : "Last fetched: "}
          {when(m.inbound.checkedAt, locale, timezone)}
          {m.inbound.lastError ? ` · ${m.inbound.lastError}` : ""}
        </small>
      )}
      <span className="mailbox-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onCheck(m)}
        >
          <RefreshCw data-icon="inline-start" />
          {de ? "Anmeldung prüfen" : "Check login"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onEdit(m)}>
          {de ? "Ändern" : "Update"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || m.inUse > 0}
          title={
            m.inUse > 0
              ? de
                ? "Erst den Posteingang auf ein anderes Postfach umstellen oder archivieren."
                : "Move its inbox to another mailbox or archive it first."
              : undefined
          }
          onClick={() => onRemove(m)}
        >
          <Trash2 data-icon="inline-start" />
          {de ? "Entfernen" : "Remove"}
        </Button>
      </span>
    </li>
  );
}

/**
 * The mailbox rows. Flat by default; the settings center passes `groupByServer`, which gives one
 * h3 per mail server, each group ending in a button for a new mailbox on that
 * server. The h3 sits under the card's h2 in both forms.
 */
export function MailboxList({
  mailboxes,
  groupByServer = false,
  de,
  locale,
  timezone,
  pending,
  onCheck,
  onEdit,
  onRemove,
  onAddOnServer,
}: {
  mailboxes: readonly MailboxEntry[];
  groupByServer?: boolean;
  de: boolean;
  locale: Locale;
  timezone: string;
  pending: boolean;
  onCheck: (m: MailboxEntry) => void;
  onEdit: (m: MailboxEntry) => void;
  onRemove: (m: MailboxEntry) => void;
  onAddOnServer: (preset: MailServerPreset) => void;
}) {
  const rows = (list: readonly MailboxEntry[]) => (
    <ul className="mailbox-rows">
      {list.map((m) => (
        <MailboxRow
          key={m.connection.id}
          m={m}
          de={de}
          locale={locale}
          timezone={timezone}
          pending={pending}
          onCheck={onCheck}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
  if (!groupByServer) return rows(mailboxes);
  return (
    <>
      {serverGroups(mailboxes).map((group) => (
        <div className="mailbox-group" key={group.host || "no-host"}>
          {group.host ? (
            <h3>
              {de ? "Mailserver " : "Mail server "}
              {group.host}
            </h3>
          ) : null}
          {rows(group.mailboxes)}
          {group.host ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={`${de ? "Postfach auf diesem Server hinzufügen" : "Add mailbox on this server"} ${group.host}`}
              onClick={() => onAddOnServer(group.preset)}
            >
              <Plus data-icon="inline-start" />
              {de
                ? "Postfach auf diesem Server hinzufügen"
                : "Add mailbox on this server"}
            </Button>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function EmailConnection({
  groupByServer = false,
}: {
  /** The settings center groups the mailboxes by mail server; the old page does not. */
  groupByServer?: boolean;
} = {}) {
  const { project, isOwner, locale, t } = useWorkspace();
  const de = locale === "de";
  const status = useResource<EmailStatus>(
    isOwner ? collectionPath(project.id, "email") : null,
  );
  // The mailbox being edited ("new" adds one), or none.
  const [open, setOpen] = useState<
    Connection | "new" | { preset: MailServerPreset } | null
  >(null);
  const mutation = useMutation(() => {
    setOpen(null);
    status.refresh();
  });
  // Off for this installation (404) or not an owner: nothing to show.
  if (!isOwner || status.loading || status.error?.status === 404) return null;
  const mailboxes =
    status.data?.mailboxes ??
    (status.data?.connection
      ? [
          {
            connection: status.data.connection,
            default: true,
            inUse: 0,
            inbound: status.data.inbound,
          },
        ]
      : []);
  // A new mailbox on a known server carries that server's preset; an edit
  // carries the mailbox itself.
  const object = open !== null && open !== "new" ? open : null;
  const preset = object && "preset" in object ? object.preset : undefined;
  const c = object && "data" in object ? object.data : undefined;
  return (
    <section className="connector">
      <div className="connector-mark">
        <Mail />
      </div>
      <div className="connector-body">
        <h2>{de ? "E-Mail-Postfächer" : "E-mail mailboxes"}</h2>
        <p>
          {de
            ? "Bestehende Postfächer über SMTP und IMAP, eines pro Adresse. Orbit sendet nur als deren eigene Adresse. Benachrichtigungen an Mitglieder gehen über das Standard-Postfach: das zuerst verbundene geprüfte."
            : "Existing mailboxes over SMTP and IMAP, one per address. Orbit sends only as their own address. Member notifications go through the default mailbox: the verified one connected first."}
        </p>
        {status.data && !status.data.live && (
          <div className="detail-summary">
            <span>
              {de
                ? "Testmodus: nichts wird zugestellt"
                : "Test mode: nothing is delivered"}
            </span>
          </div>
        )}
        {!mailboxes.length && (
          <div className="detail-summary">
            <Status value="not_configured" />
          </div>
        )}
        <MailboxList
          mailboxes={mailboxes}
          groupByServer={groupByServer}
          de={de}
          locale={locale}
          timezone={project.timezone}
          pending={mutation.pending}
          onCheck={(m) =>
            mutation.run(() =>
              action(project.id, "connector-health", {
                connectorId: m.connection.id,
              }),
            )
          }
          onEdit={(m) => setOpen(m.connection)}
          onRemove={(m) => {
            if (
              window.confirm(
                de
                  ? `Postfach ${m.connection.data.fromAddress} entfernen? Orbit ruft es dann nicht mehr ab und sendet nicht mehr darüber.`
                  : `Remove the mailbox ${m.connection.data.fromAddress}? Orbit stops fetching and sending through it.`,
              )
            )
              mutation.run(() =>
                action(project.id, "email-disconnect", {
                  connectorId: m.connection.id,
                }),
              );
          }}
          onAddOnServer={(preset) => setOpen({ preset })}
        />
      </div>
      <div className="connector-actions">
        <Button variant="outline" onClick={() => setOpen("new")}>
          <Plus data-icon="inline-start" />
          {mailboxes.length
            ? de
              ? "Postfach hinzufügen"
              : "Add mailbox"
            : de
              ? "Einrichten"
              : "Configure"}
        </Button>
      </div>
      {mutation.error && !open && <Alert kind="error">{mutation.error}</Alert>}
      {open && (
        <Modal
          title={
            open === "new" || preset
              ? de
                ? "Postfach verbinden"
                : "Connect mailbox"
              : String(c?.fromAddress ?? "")
          }
          description={
            de
              ? "Das Passwort wird auf deinem eigenen Server verschlüsselt und nie wieder angezeigt."
              : "The password is encrypted on your own server and never shown again."
          }
          onClose={() => setOpen(null)}
        >
          <DataForm
            fields={mailboxFields(c ?? null, locale, preset)}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel={de ? "Verbindung speichern" : "Save connection"}
            onCancel={() => setOpen(null)}
            onSubmit={(v) =>
              mutation.run(() =>
                action(project.id, "email-connect", emailConnectBody(v)),
              )
            }
          />
          <p className="panel-note">
            {de
              ? "Dieselbe Adresse erneut speichern ändert dieses Postfach, eine neue Adresse fügt ein weiteres hinzu. Danach „Anmeldung prüfen“: Orbit meldet sich bei SMTP und IMAP an und sendet dabei nichts; bis dahin ruft das Postfach nichts ab und sendet nichts."
              : "Saving the same address again updates this mailbox; a new address adds another one. Then use “Check login”: Orbit logs in to SMTP and IMAP and sends nothing; until then the mailbox neither fetches nor sends."}
          </p>
        </Modal>
      )}
    </section>
  );
}
