"use client";
// A project's public client keys (WP4.2b follow-up): owners issue a key for
// a module with a public API, limited to exact origins, and revoke it. A key
// is a public identifier, not a secret; browsers on its origins open a
// session with it.
import { type ReactNode, useState } from "react";
import { api, collectionPath, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Loading, Modal } from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";

export type PublicKeyItem = {
  id: string;
  moduleId: string;
  publicKey: string;
  allowedOrigins: string[];
  createdAt: string;
  revokedAt: string | null;
  /** What uses the key (for Support, the inbox); null for an unused or revoked key. */
  usedBy: { moduleId: string; label: string } | null;
};
type KeyList = { items: PublicKeyItem[]; modules: string[] };

/** One origin per line or comma; blanks dropped, duplicates kept once. */
export function parseOrigins(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

// The copy this file adds on top of its English-only modal; German is typed
// against the English keys. "{label}" is replaced by what uses the key.
const en = {
  usedBy: "Used by: {label}",
  revokeAsk: "Revoke this key? Whatever uses it stops working at once.",
  revokeUsed:
    "\"{label}\" loses its key and its widget stops. A new key means a new embed code.",
  ownerOnly: "Only owners of the project manage public keys.",
  active: "Active",
  revoked: "Revoked {date}",
  revoke: "Revoke",
  none: "No public keys yet.",
  noModules: "No module of this installation has a public API yet.",
  module: "Module",
  origins: "Allowed origins",
  originsHint:
    "One per line, exactly as the browser sends it: https, host and port, no path. At most 10.",
  create: "Create key",
  newKey: "New key",
  ingressOff: "Public ingress is switched off for this installation.",
  title: "Public keys",
  description:
    "A key lets a website on its origins call one module's public API. Revoking it stops that at once.",
};
export type PublicKeyTextKey = keyof typeof en;
const de: Record<PublicKeyTextKey, string> = {
  usedBy: "Genutzt von: {label}",
  revokeAsk:
    "Diesen Schlüssel widerrufen? Was ihn nutzt, funktioniert sofort nicht mehr.",
  revokeUsed:
    "\u201E{label}\u201C verliert seinen Schlüssel, und sein Widget funktioniert nicht mehr. Ein neuer Schlüssel bedeutet einen neuen Einbettungscode.",
  ownerOnly: "Öffentliche Schlüssel verwalten nur Owner des Projekts.",
  active: "Aktiv",
  revoked: "Widerrufen {date}",
  revoke: "Widerrufen",
  none: "Noch keine öffentlichen Schlüssel.",
  noModules:
    "Noch kein Modul dieser Installation hat eine öffentliche Schnittstelle.",
  module: "Modul",
  origins: "Erlaubte Ursprünge",
  originsHint:
    "Einer pro Zeile, genau so, wie der Browser ihn sendet: https, Host und Port, kein Pfad. Höchstens 10.",
  create: "Schlüssel anlegen",
  newKey: "Neuer Schlüssel",
  ingressOff: "Der öffentliche Zugang ist für diese Installation abgeschaltet.",
  title: "Öffentliche Schlüssel",
  description:
    "Mit einem Schlüssel kann eine Website von ihren Ursprüngen aus die öffentliche Schnittstelle eines Moduls aufrufen. Ein Widerruf beendet das sofort.",
};

export function publicKeyText(
  locale: Locale,
  key: PublicKeyTextKey,
  label = "",
  date = "",
): string {
  return (locale === "de" ? de[key] : en[key])
    .replaceAll("{label}", label)
    .replaceAll("{date}", date);
}

/** The question asked before a key is revoked: the key's user is named when it has one. */
export function revokeQuestion(key: PublicKeyItem, locale: Locale): string {
  const ask = publicKeyText(locale, "revokeAsk");
  return key.usedBy
    ? `${ask}\n\n${publicKeyText(locale, "revokeUsed", key.usedBy.label)}`
    : ask;
}

/** The keys' list with the module, key, origins, state and revoke; `children` follow it (create form or button). */
export function PublicKeysView({
  items,
  modules,
  locale,
  pending = false,
  onRevoke,
  children,
}: {
  items: PublicKeyItem[];
  modules: string[];
  locale: Locale;
  pending?: boolean;
  onRevoke(id: string): void;
  children?: ReactNode;
}) {
  const date = (value: string) =>
    new Date(value).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB");
  return (
    <>
      {items.length ? (
        <div className="member-list">
          {items.map((key) => (
            <div className="member-row" key={key.id}>
              <div>
                <strong>{key.moduleId}</strong>
                <small>
                  <code>{key.publicKey}</code>
                </small>
                <small>{key.allowedOrigins.join(", ")}</small>
                {key.usedBy && (
                  <small>
                    {publicKeyText(locale, "usedBy", key.usedBy.label)}
                  </small>
                )}
              </div>
              <div className="page-actions">
                {key.revokedAt ? (
                  <Badge tone="danger">
                    {publicKeyText(locale, "revoked", "", date(key.revokedAt))}
                  </Badge>
                ) : (
                  <>
                    <Badge tone="success">{publicKeyText(locale, "active")}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(revokeQuestion(key, locale)))
                          onRevoke(key.id);
                      }}
                    >
                      {publicKeyText(locale, "revoke")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="panel-note">{publicKeyText(locale, "none")}</p>
      )}
      {!modules.length ? (
        <p className="panel-note">
          {publicKeyText(locale, "noModules")}
        </p>
      ) : (
        children
      )}
    </>
  );
}

/** The list, the create form and revoke; no frame. */
export function PublicKeysPanel() {
  const { project, locale, t } = useWorkspace();
  const keys = useResource<KeyList>(collectionPath(project.id, "public-keys"));
  const [creating, setCreating] = useState(false);
  const mutation = useMutation(() => {
    setCreating(false);
    keys.refresh();
  });
  const base = `/projects/${encodeURIComponent(project.id)}/public-keys`;
  const modules = keys.data?.modules ?? [];
  if (keys.loading) return <Loading />;
  if (keys.error?.status === 404)
    return <Alert>{publicKeyText(locale, "ingressOff")}</Alert>;
  return (
    <>
      <ResourceError error={keys.error} retry={keys.refresh} />
      <PublicKeysView
        items={keys.data?.items ?? []}
        modules={modules}
        locale={locale}
        pending={mutation.pending}
        onRevoke={(id) =>
          void mutation.run(() =>
            api(`${base}/${encodeURIComponent(id)}/revoke`, {
              method: "POST",
              body: "{}",
            }),
          )
        }
      >
        {creating ? (
          <DataForm
            fields={[
              {
                name: "moduleId",
                label: publicKeyText(locale, "module"),
                type: "select",
                value: modules[0],
                options: modules.map((id) => ({ value: id, label: id })),
              },
              {
                name: "allowedOrigins",
                label: publicKeyText(locale, "origins"),
                type: "textarea",
                required: true,
                placeholder: "https://www.example.com",
                hint: publicKeyText(locale, "originsHint"),
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            onCancel={() => setCreating(false)}
            submitLabel={publicKeyText(locale, "create")}
            onSubmit={(v) =>
              mutation.run(() =>
                api(base, {
                  method: "POST",
                  body: JSON.stringify({
                    moduleId: str(v, "moduleId"),
                    allowedOrigins: parseOrigins(str(v, "allowedOrigins")),
                  }),
                }),
              )
            }
          />
        ) : (
          <>
            {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
            <Button variant="outline" onClick={() => setCreating(true)}>
              {publicKeyText(locale, "newKey")}
            </Button>
          </>
        )}
      </PublicKeysView>
    </>
  );
}

export function PublicKeys({ onClose }: { onClose(): void }) {
  const { locale } = useWorkspace();
  return (
    <Modal
      title={publicKeyText(locale, "title")}
      description={publicKeyText(locale, "description")}
      onClose={onClose}
    >
      <PublicKeysPanel />
    </Modal>
  );
}
