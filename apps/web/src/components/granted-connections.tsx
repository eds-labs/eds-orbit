"use client";
import { Share2 } from "lucide-react";
import { action, useMutation, useResource, type Entity } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";
import { errorText } from "@/platform/administration/texts";

type Granted = {
  grantId: string;
  connectionId: string;
  provider: string;
  scope: "system" | "workspace" | "project";
  label: string;
  status: string;
  purposes: string[];
};

/**
 * Connections the organization or the system granted to this project (ADR
 * 0013). An owner binds one instead of entering a key; the project keeps
 * its own settings (channels, site, verification) and runs the usual check.
 * Shown only while central connections are on.
 */
export function GrantedConnections({
  connectors,
}: {
  connectors: Entity[];
}) {
  const { project, isOwner, identity, locale, refresh } = useWorkspace();
  const de = locale === "de";
  const granted = useResource<{ items: Granted[] }>(
    identity.connections
      ? `/projects/${encodeURIComponent(project.id)}/connections`
      : null,
  );
  const bind = useMutation(refresh);
  const items = (granted.data?.items ?? []).filter(
    (g) => !["openai", "anthropic"].includes(g.provider),
  );
  if (!identity.connections || !items.length) return null;
  return (
    <section className="connector">
      <div className="connector-mark">
        <Share2 />
      </div>
      <div className="connector-body">
        <h2>{de ? "Freigegebene Verbindungen" : "Granted connections"}</h2>
        <p>
          {de
            ? "Von der Organisation oder dem System freigegeben. Einbinden statt eigenen Schlüssel eintragen; danach wie gewohnt prüfen."
            : "Granted by the organization or the system. Bind one instead of entering a key of your own, then check it as usual."}
        </p>
        {bind.error && <Alert kind="error">{errorText(bind.error, locale)}</Alert>}
        <div className="data-list">
          {items.map((g) => {
            const bound = connectors.some(
              (c) => c.data.centralConnectionId === g.connectionId,
            );
            return (
              <div className="data-row" key={g.grantId}>
                <div>
                  <strong>{g.label}</strong>
                  <p>
                    {g.provider} ·{" "}
                    {g.scope === "system" ? "System" : de ? "Organisation" : "Organization"}
                  </p>
                </div>
                {bound ? (
                  <Badge tone="success">{de ? "eingebunden" : "bound"}</Badge>
                ) : (
                  isOwner && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bind.pending}
                      onClick={() =>
                        void bind.run(() =>
                          action(project.id, "connector-attach", {
                            connectionId: g.connectionId,
                          }),
                        )
                      }
                    >
                      {de ? "Einbinden" : "Bind"}
                    </Button>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
