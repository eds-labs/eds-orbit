"use client";
// The project's mailbox (WP4.7): owners connect an existing mailbox over
// SMTP (sending) and IMAP (receiving). The password goes in once and is
// never shown again; the check logs in to both sides and sends nothing.
import { useState } from "react";
import { Mail, RefreshCw } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  when,
} from "@/lib/api";
import { Alert, Button, Modal, Status } from "./ui/primitives";
import { DataForm } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";

type EmailStatus = {
  enabled: boolean;
  live: boolean;
  connection: {
    id: string;
    data: Record<string, any>;
  } | null;
  inbound: { checkedAt: string | null; lastError: string | null } | null;
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
  const status = useResource<EmailStatus>(
    isOwner ? collectionPath(project.id, "email") : null,
  );
  const [open, setOpen] = useState(false);
  const mutation = useMutation(() => {
    setOpen(false);
    status.refresh();
  });
  // Off for this installation (404) or not an owner: nothing to show.
  if (!isOwner || status.loading || status.error?.status === 404) return null;
  const c = status.data?.connection?.data;
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
        <h2>{locale === "de" ? "E-Mail-Postfach" : "E-mail mailbox"}</h2>
        <p>
          {locale === "de"
            ? "Ein bestehendes Postfach über SMTP und IMAP. Orbit sendet nur als dessen Adresse."
            : "An existing mailbox over SMTP and IMAP. Orbit sends only as its own address."}
        </p>
        <div className="detail-summary">
          <Status value={c?.status || "not_configured"} />
          {c && <span>{c.fromAddress}</span>}
          {status.data && !status.data.live && (
            <span>
              {locale === "de"
                ? "Testmodus: nichts wird zugestellt"
                : "Test mode: nothing is delivered"}
            </span>
          )}
        </div>
        {status.data?.inbound && (
          <small>
            {locale === "de" ? "Zuletzt abgerufen: " : "Last fetched: "}
            {when(status.data.inbound.checkedAt, locale, project.timezone)}
            {status.data.inbound.lastError
              ? ` · ${status.data.inbound.lastError}`
              : ""}
          </small>
        )}
      </div>
      <div className="connector-actions">
        <Button variant="outline" onClick={() => setOpen(true)}>
          {c ? "Update connection" : "Configure"}
        </Button>
        {status.data?.connection && (
          <Button
            variant="ghost"
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(() =>
                action(project.id, "connector-health", {
                  connectorId: status.data!.connection!.id,
                }),
              )
            }
          >
            <RefreshCw data-icon="inline-start" />
            {locale === "de" ? "Anmeldung prüfen" : "Check login"}
          </Button>
        )}
      </div>
      {mutation.error && !open && <Alert kind="error">{mutation.error}</Alert>}
      {open && (
        <Modal
          title={locale === "de" ? "Postfach verbinden" : "Connect mailbox"}
          description="The password is encrypted on your own server and never shown again."
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "fromAddress",
                label: "Address",
                type: "email",
                required: true,
                value: c?.fromAddress ?? "",
              },
              {
                name: "fromName",
                label: "Sender name",
                value: c?.fromName ?? "",
              },
              {
                name: "username",
                label: "User name",
                required: true,
                value: c?.username ?? "",
              },
              {
                name: "password",
                label: "Password",
                type: "password",
                required: true,
              },
              {
                name: "smtpHost",
                label: "SMTP server",
                required: true,
                value: c?.smtpHost ?? "",
                heading: "SMTP",
              },
              {
                name: "smtpPort",
                label: "SMTP port",
                type: "number",
                value: c?.smtpPort ?? 465,
              },
              {
                name: "smtpTls",
                label: "SMTP security",
                type: "select",
                value: c?.smtpTls ?? "implicit",
                options: tls,
              },
              {
                name: "imapHost",
                label: "IMAP server",
                required: true,
                value: c?.imapHost ?? "",
                heading: "IMAP",
              },
              {
                name: "imapPort",
                label: "IMAP port",
                type: "number",
                value: c?.imapPort ?? 993,
              },
              {
                name: "imapTls",
                label: "IMAP security",
                type: "select",
                value: c?.imapTls ?? "implicit",
                options: tls,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel="Save connection"
            onCancel={() => setOpen(false)}
            onSubmit={(v) =>
              mutation.run(() =>
                action(project.id, "email-connect", emailConnectBody(v)),
              )
            }
          />
          <p className="panel-note">
            {locale === "de"
              ? "Danach „Anmeldung prüfen“: Orbit meldet sich bei SMTP und IMAP an und sendet dabei nichts."
              : "Then use “Check login”: Orbit logs in to SMTP and IMAP and sends nothing."}
          </p>
        </Modal>
      )}
    </section>
  );
}
