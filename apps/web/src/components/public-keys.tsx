"use client";
// A project's public client keys (WP4.2b follow-up): owners issue a key for
// a module with a public API, limited to exact origins, and revoke it. A key
// is a public identifier, not a secret; browsers on its origins open a
// session with it.
import { useState } from "react";
import { api, collectionPath, useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal } from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";

type PublicKey = {
  id: string;
  moduleId: string;
  publicKey: string;
  allowedOrigins: string[];
  createdAt: string;
  revokedAt: string | null;
};
type KeyList = { items: PublicKey[]; modules: string[] };

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

export function PublicKeys({ onClose }: { onClose(): void }) {
  const { project, locale, t } = useWorkspace();
  const keys = useResource<KeyList>(collectionPath(project.id, "public-keys"));
  const [creating, setCreating] = useState(false);
  const mutation = useMutation(() => {
    setCreating(false);
    keys.refresh();
  });
  const base = `/projects/${encodeURIComponent(project.id)}/public-keys`;
  const modules = keys.data?.modules ?? [];
  const date = (value: string) =>
    new Date(value).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB");
  return (
    <Modal
      title="Public keys"
      description="A key lets a website on its origins call one module's public API. Revoking it stops that at once."
      onClose={onClose}
    >
      {keys.loading ? (
        <Loading />
      ) : keys.error?.status === 404 ? (
        <Alert>Public ingress is switched off for this installation.</Alert>
      ) : (
        <>
          <ResourceError error={keys.error} retry={keys.refresh} />
          {keys.data?.items.length ? (
            <div className="member-list">
              {keys.data.items.map((key) => (
                <div className="member-row" key={key.id}>
                  <div>
                    <strong>{key.moduleId}</strong>
                    <small>
                      <code>{key.publicKey}</code>
                    </small>
                    <small>{key.allowedOrigins.join(", ")}</small>
                  </div>
                  <div className="page-actions">
                    {key.revokedAt ? (
                      <Badge tone="danger">Revoked {date(key.revokedAt)}</Badge>
                    ) : (
                      <>
                        <Badge tone="success">Active</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutation.pending}
                          onClick={() =>
                            mutation.run(() =>
                              api(
                                `${base}/${encodeURIComponent(key.id)}/revoke`,
                                { method: "POST", body: "{}" },
                              ),
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-note">No public keys yet.</p>
          )}
          {!modules.length ? (
            <p className="panel-note">
              No module of this installation has a public API yet.
            </p>
          ) : creating ? (
            <DataForm
              fields={[
                {
                  name: "moduleId",
                  label: "Module",
                  type: "select",
                  value: modules[0],
                  options: modules.map((id) => ({ value: id, label: id })),
                },
                {
                  name: "allowedOrigins",
                  label: "Allowed origins",
                  type: "textarea",
                  required: true,
                  placeholder: "https://www.example.com",
                  hint: "One per line, exactly as the browser sends it: https, host and port, no path. At most 10.",
                },
              ]}
              pending={mutation.pending}
              error={mutation.error}
              t={t}
              onCancel={() => setCreating(false)}
              submitLabel="Create key"
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
                New key
              </Button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
