"use client";
// Customer context integrations (ADR 0011): owners add provider endpoints
// (an n8n webhook or a product's own endpoint) with a bearer token and a
// signing secret, both encrypted on the server and never shown again. The
// check sends one signed lookup of a reserved test subject; only checked
// integrations are read. Support inboxes choose one in their settings.
import { useState } from "react";
import { Plus, RefreshCw, Trash2, UserRoundSearch } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  type Entity,
} from "@/lib/api";
import { Alert, Button, Modal, Status } from "./ui/primitives";
import { DataForm } from "@/platform/ui/form";
import { useShell } from "@/platform/shell/shell-context";
import { useWorkspace } from "./workspace-context";

/** The action body from the form: timeout as a number, a rotation keeps the id. */
export function customerContextConnectBody(
  v: Record<string, unknown>,
  connectorId?: string,
) {
  const text = (key: string) => String(v[key] ?? "").trim();
  return {
    ...(connectorId ? { connectorId } : {}),
    label: text("label"),
    baseUrl: text("baseUrl"),
    sourceSystem: text("sourceSystem"),
    timeoutMs: Number(text("timeoutMs") || 4000),
    token: String(v.token ?? ""),
    signingSecret: String(v.signingSecret ?? ""),
  };
}

export function CustomerContextConnection() {
  const { project, isOwner, locale, t } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const enabled = isOwner && shell.features?.customerContext === true;
  const list = useResource<{ items: Entity[] }>(
    enabled ? collectionPath(project.id, "connectors") : null,
  );
  const [open, setOpen] = useState<Entity | "new" | null>(null);
  const mutation = useMutation(() => {
    setOpen(null);
    list.refresh();
  });
  if (!enabled || list.loading) return null;
  const items = (list.data?.items ?? []).filter(
    (row) => row.data.provider === "customer_context",
  );
  const c = open && open !== "new" ? open.data : undefined;
  return (
    <section className="connector">
      <div className="connector-mark">
        <UserRoundSearch />
      </div>
      <div className="connector-body">
        <h2>{de ? "Kundenkontext" : "Customer context"}</h2>
        <p>
          {de
            ? "Liest Abo, Funktionen und Limits verifizierter Support-Kunden live aus einem Produkt, z. B. über n8n. Nur lesend, nichts wird gespeichert."
            : "Reads the plan, features and limits of verified Support customers live from a product, for example through n8n. Read-only; nothing is stored."}
        </p>
        {!items.length && (
          <div className="detail-summary">
            <Status value="not_configured" />
          </div>
        )}
        <ul className="mailbox-rows">
          {items.map((row) => (
            <li key={row.id}>
              <div className="detail-summary">
                <Status value={String(row.data.status || "not_configured")} />
                <strong>{String(row.data.label ?? "")}</strong>
                <span>
                  {String(row.data.sourceSystem)} · {String(row.data.baseUrl)}
                </span>
              </div>
              <span className="mailbox-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.pending}
                  onClick={() =>
                    mutation.run(() =>
                      action(project.id, "connector-health", {
                        connectorId: row.id,
                      }),
                    )
                  }
                >
                  <RefreshCw data-icon="inline-start" />
                  {de ? "Verbindung prüfen" : "Check connection"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(row)}
                >
                  {de ? "Ändern" : "Update"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        de
                          ? `Integration ${String(row.data.label)} entfernen? Posteingänge, die sie nutzen, zeigen dann kein Kundenkonto mehr.`
                          : `Remove the integration ${String(row.data.label)}? Inboxes using it then show no customer account.`,
                      )
                    )
                      mutation.run(() =>
                        action(project.id, "customer-context-disconnect", {
                          connectorId: row.id,
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
          {de ? "Integration hinzufügen" : "Add integration"}
        </Button>
      </div>
      {mutation.error && !open && <Alert kind="error">{mutation.error}</Alert>}
      {open && (
        <Modal
          title={
            open === "new"
              ? de
                ? "Kundenkontext verbinden"
                : "Connect customer context"
              : String(c?.label ?? "")
          }
          description={
            de
              ? "Token und Signaturschlüssel werden auf deinem Server verschlüsselt und nie wieder angezeigt. Beim Ändern beide neu eingeben."
              : "The token and signing secret are encrypted on your server and never shown again. Enter both again when updating."
          }
          onClose={() => setOpen(null)}
        >
          <DataForm
            fields={[
              {
                name: "label",
                label: de ? "Name" : "Name",
                required: true,
                value: String(c?.label ?? ""),
              },
              {
                name: "baseUrl",
                label: de ? "Basis-URL (HTTPS)" : "Base URL (HTTPS)",
                type: "url",
                required: true,
                value: String(c?.baseUrl ?? ""),
              },
              {
                name: "sourceSystem",
                label: de ? "Quellsystem (Kürzel)" : "Source system (slug)",
                required: true,
                value: String(c?.sourceSystem ?? ""),
              },
              {
                name: "timeoutMs",
                label: de
                  ? "Timeout (ms, 1000–8000)"
                  : "Timeout (ms, 1000–8000)",
                type: "number",
                value: Number(c?.timeoutMs ?? 4000),
              },
              {
                name: "token",
                label: de ? "Bearer-Token" : "Bearer token",
                type: "password",
                required: true,
              },
              {
                name: "signingSecret",
                label: de ? "Signaturschlüssel" : "Signing secret",
                type: "password",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel={de ? "Integration speichern" : "Save integration"}
            onCancel={() => setOpen(null)}
            onSubmit={(v) =>
              mutation.run(() =>
                action(
                  project.id,
                  "customer-context-connect",
                  customerContextConnectBody(
                    v,
                    open === "new" ? undefined : open.id,
                  ),
                ),
              )
            }
          />
          <p className="panel-note">
            {de
              ? "Danach „Verbindung prüfen“: Orbit sendet eine signierte Testabfrage ohne Kundendaten. Erst eine geprüfte Integration wird gelesen. Anleitung: docs/CUSTOMER_CONTEXT.md."
              : "Then use “Check connection”: Orbit sends one signed test lookup without customer data. Only a checked integration is read. Guide: docs/CUSTOMER_CONTEXT.md."}
          </p>
        </Modal>
      )}
    </section>
  );
}
