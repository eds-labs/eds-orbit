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
import { DataForm } from "@/platform/ui/form";
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

export function EmailConnection() {
  const { project, isOwner, locale, t } = useWorkspace();
  const de = locale === "de";
  const status = useResource<EmailStatus>(
    isOwner ? collectionPath(project.id, "email") : null,
  );
  // The mailbox being edited ("new" adds one), or none.
  const [open, setOpen] = useState<Connection | "new" | null>(null);
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
  const c = open && open !== "new" ? open.data : undefined;
  const tls = [
    { value: "implicit", label: "TLS (implicit)" },
    { value: "starttls", label: "STARTTLS" },
  ];
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
        <ul className="mailbox-rows">
          {mailboxes.map((m) => (
            <li key={m.connection.id}>
              <div className="detail-summary">
                <Status value={m.connection.data.status || "not_configured"} />
                <strong>{m.connection.data.fromAddress}</strong>
                {m.default && (
                  <Badge tone="blue">{de ? "Standard" : "Default"}</Badge>
                )}
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
                  {when(m.inbound.checkedAt, locale, project.timezone)}
                  {m.inbound.lastError ? ` · ${m.inbound.lastError}` : ""}
                </small>
              )}
              <span className="mailbox-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.pending}
                  onClick={() =>
                    mutation.run(() =>
                      action(project.id, "connector-health", {
                        connectorId: m.connection.id,
                      }),
                    )
                  }
                >
                  <RefreshCw data-icon="inline-start" />
                  {de ? "Anmeldung prüfen" : "Check login"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(m.connection)}
                >
                  {de ? "Ändern" : "Update"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.pending || m.inUse > 0}
                  title={
                    m.inUse > 0
                      ? de
                        ? "Erst den Posteingang auf ein anderes Postfach umstellen oder archivieren."
                        : "Move its inbox to another mailbox or archive it first."
                      : undefined
                  }
                  onClick={() => {
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
                >
                  <Trash2 data-icon="inline-start" />
                  {de ? "Entfernen" : "Remove"}
                </Button>
              </span>
            </li>
          ))}
        </ul>
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
            open === "new"
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
            fields={[
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
                value: c?.smtpHost ?? "",
                heading: "SMTP",
              },
              {
                name: "smtpPort",
                label: de ? "SMTP-Port" : "SMTP port",
                type: "number",
                value: c?.smtpPort ?? 465,
              },
              {
                name: "smtpTls",
                label: de ? "SMTP-Sicherheit" : "SMTP security",
                type: "select",
                value: c?.smtpTls ?? "implicit",
                options: tls,
              },
              {
                name: "imapHost",
                label: de ? "IMAP-Server" : "IMAP server",
                required: true,
                value: c?.imapHost ?? "",
                heading: "IMAP",
              },
              {
                name: "imapPort",
                label: de ? "IMAP-Port" : "IMAP port",
                type: "number",
                value: c?.imapPort ?? 993,
              },
              {
                name: "imapTls",
                label: de ? "IMAP-Sicherheit" : "IMAP security",
                type: "select",
                value: c?.imapTls ?? "implicit",
                options: tls,
              },
            ]}
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
