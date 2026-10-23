"use client";
import { post, remove, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Empty, Loading } from "@/components/ui/primitives";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { at, errorText } from "./texts";

// Orbit's MCP server for the system administration (ADR 0013, WP3.6):
// state, clients and every active grant. Organization owners keep their
// own view under Settings → Connected apps.

type Status = {
  oauth: boolean;
  gateway: boolean;
  proposals: boolean;
  tasks: boolean;
  dynamicRegistration: boolean;
  resource: string;
  metadataDocumentHosts: string[];
};
type Client = {
  clientId: string;
  name: string;
  uri: string | null;
  disabled: boolean;
  activeGrants: number;
  lastUsedAt: string | null;
};
type Grant = {
  id: string;
  clientName: string;
  userName: string;
  userEmail: string;
  workspaceName: string;
  projects: number | "all";
  scopes: string[];
  lastUsedAt: string | null;
};

export function McpAdmin({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const overview = useResource<{ status: Status; clients: Client[] }>("/admin/mcp");
  const grants = useResource<{ items: Grant[] }>("/admin/mcp/grants");
  const action = useMutation(() => {
    overview.refresh();
    grants.refresh();
  });
  const on = (value: boolean) => (
    <Badge tone={value ? "success" : "neutral"}>{value ? (de ? "an" : "on") : de ? "aus" : "off"}</Badge>
  );
  return (
    <>
      <PageHead
        title="MCP"
        description={
          de
            ? "Orbit als MCP-Server für externe Clients wie ChatGPT. Eine Freigabe erweitert nie die Rechte ihres Nutzers; die Bestätigung eines Clients ist keine Orbit-Freigabe."
            : "Orbit as an MCP server for external clients such as ChatGPT. A grant never widens its user's rights; a client's own confirmation is never an Orbit approval."
        }
      />
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {overview.loading && !overview.data ? (
        <Loading label={de ? "Wird geladen…" : "Loading…"} />
      ) : !overview.data ? (
        <ResourceError error={overview.error} retry={overview.refresh} />
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{de ? "Status" : "Status"}</h2>
                <p>{overview.data.status.resource}</p>
              </div>
            </div>
            <dl className="detail-grid">
              <dt>OAuth</dt>
              <dd>{on(overview.data.status.oauth)}</dd>
              <dt>Gateway</dt>
              <dd>{on(overview.data.status.gateway)}</dd>
              <dt>{de ? "Vorschläge" : "Proposals"}</dt>
              <dd>{on(overview.data.status.proposals)}</dd>
              <dt>{de ? "Aufträge" : "Work orders"}</dt>
              <dd>{on(overview.data.status.tasks)}</dd>
              <dt>{de ? "Client-Hosts" : "Client hosts"}</dt>
              <dd>{overview.data.status.metadataDocumentHosts.join(", ") || "—"}</dd>
            </dl>
          </section>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Clients</h2>
                <p>
                  {de
                    ? "Deaktivieren widerruft alle Freigaben des Clients samt Tokens."
                    : "Disabling revokes every grant of the client with its tokens."}
                </p>
              </div>
            </div>
            {overview.data.clients.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>{de ? "Freigaben" : "Grants"}</th>
                      <th>{de ? "Zuletzt genutzt" : "Last used"}</th>
                      <th>
                        <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.clients.map((c) => (
                      <tr key={c.clientId}>
                        <td>
                          {c.name}
                          <small>{c.uri ?? c.clientId}</small>
                          {c.disabled && <Badge tone="danger">{de ? "deaktiviert" : "disabled"}</Badge>}
                        </td>
                        <td>{c.activeGrants}</td>
                        <td>{at(c.lastUsedAt, locale)}</td>
                        <td>
                          <Button
                            variant={c.disabled ? "outline" : "ghost"}
                            size="sm"
                            disabled={action.pending}
                            onClick={() => {
                              if (
                                c.disabled ||
                                window.confirm(
                                  de
                                    ? `${c.name} deaktivieren und alle Freigaben widerrufen?`
                                    : `Disable ${c.name} and revoke all its grants?`,
                                )
                              )
                                void action.run(() =>
                                  post(
                                    `/admin/mcp/clients/${encodeURIComponent(c.clientId)}/${c.disabled ? "enable" : "disable"}`,
                                    {},
                                  ),
                                );
                            }}
                          >
                            {c.disabled ? (de ? "Aktivieren" : "Enable") : de ? "Deaktivieren" : "Disable"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title={de ? "Noch keine Clients." : "No clients yet."} />
            )}
          </section>
        </>
      )}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{de ? "Aktive Freigaben" : "Active grants"}</h2>
          </div>
        </div>
        {grants.data ? (
          grants.data.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{de ? "Person" : "Person"}</th>
                    <th>Client</th>
                    <th>{de ? "Organisation" : "Organization"}</th>
                    <th>{de ? "Bereiche" : "Scopes"}</th>
                    <th>
                      <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {grants.data.items.map((g) => (
                    <tr key={g.id}>
                      <td>
                        {g.userName}
                        <small>{g.userEmail}</small>
                      </td>
                      <td>{g.clientName}</td>
                      <td>
                        {g.workspaceName}
                        <small>
                          {g.projects === "all"
                            ? de
                              ? "alle aktuellen Projekte"
                              : "all current projects"
                            : `${g.projects} ${de ? "Projekte" : "projects"}`}
                        </small>
                      </td>
                      <td>{g.scopes.join(", ")}</td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={action.pending}
                          onClick={() => void action.run(() => remove(`/admin/mcp/grants/${g.id}`))}
                        >
                          {de ? "Widerrufen" : "Revoke"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={de ? "Keine aktiven Freigaben." : "No active grants."} />
          )
        ) : (
          <ResourceError error={grants.error} retry={grants.refresh} />
        )}
      </section>
    </>
  );
}
