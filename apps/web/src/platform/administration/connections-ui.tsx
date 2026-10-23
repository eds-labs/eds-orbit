"use client";
import { useState } from "react";
import { KeyRound, Plug, ShieldOff, Trash2 } from "lucide-react";
import { post, put, remove, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str } from "@/platform/ui/form";
import { at, errorText } from "./texts";

// Central connections (ADR 0014): the same list, forms and grants for the
// system administration (system connections, granted to organizations
// with a budget) and the organization settings (own connections and
// granted system ones, granted to projects). Secrets are write-only.

type Provider = {
  id: string;
  label: { en: string; de: string };
  scopes: string[];
  purposes: string[];
  checkable: boolean;
  /** Its channels are assigned to projects, one project each. */
  channels?: boolean;
};
type Connection = {
  id: string;
  provider: string;
  scope: "system" | "workspace";
  label: string;
  config: Record<string, unknown>;
  status: string;
  health: { at?: string; ok?: boolean; code?: string; models?: number };
  monthlyBudgetMicros: number | null;
  secretVersion: number | null;
  activeGrants: number;
  disabled: boolean;
};
type Grant = {
  id: string;
  workspaceName: string;
  projectName: string | null;
  projectId: string | null;
  purposes: string[];
  monthlyBudgetMicros: number | null;
  reservedMicros: number;
  settledMicros: number;
};

/** USD from micros, for budgets and spend. */
export const usdOf = (micros: number | null | undefined) =>
  micros === null || micros === undefined
    ? "—"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(micros / 1_000_000);
const microsOf = (usd: string) =>
  usd.trim() ? Math.round(Number(usd.replace(",", ".")) * 1_000_000) : undefined;

export function ConnectionsPanel({
  base,
  mode,
  locale,
  targets,
}: {
  /** "/admin/connections" or "/organizations/:id/connections". */
  base: string;
  mode: "admin" | "owner";
  locale: Locale;
  /** Organizations (admin) or projects (owner) a grant can go to. */
  targets: Array<{ id: string; name: string }>;
}) {
  const de = locale === "de";
  const list = useResource<{ items: Connection[]; providers: Provider[] }>(base);
  const action = useMutation(list.refresh);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Connection | null>(null);
  const [granting, setGranting] = useState<Connection | null>(null);
  const [workflows, setWorkflows] = useState<Connection | null>(null);
  const [channels, setChannels] = useState<Connection | null>(null);
  if (list.loading && !list.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!list.data) return <ResourceError error={list.error} retry={list.refresh} />;
  const { items, providers } = list.data;
  const providerName = (id: string) =>
    providers.find((p) => p.id === id)?.label[locale] ?? id;
  const own = (c: Connection) => (mode === "admin" ? c.scope === "system" : c.scope === "workspace");
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{de ? "Verbindungen" : "Connections"}</h2>
          <p>
            {mode === "admin"
              ? de
                ? "Systemweite Verbindungen. Organisationen nutzen sie erst nach ausdrücklicher Freigabe mit Budget."
                : "System-wide connections. Organizations use them only after an explicit grant with a budget."
              : de
                ? "Eigene Verbindungen der Organisation und freigegebene Systemverbindungen. Projekte nutzen sie erst nach Freigabe."
                : "The organization's own connections and system connections granted to it. Projects use them only after a grant."}
          </p>
        </div>
        <div className="panel-actions">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plug />
            {de ? "Verbindung anlegen" : "Add connection"}
          </Button>
        </div>
      </div>
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{de ? "Verbindung" : "Connection"}</th>
                <th>{de ? "Status" : "Status"}</th>
                <th>{de ? "Schlüssel" : "Secret"}</th>
                <th>{de ? "Freigaben" : "Grants"}</th>
                <th>
                  <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.label}
                    <small>
                      {providerName(c.provider)} ·{" "}
                      {c.scope === "system" ? "System" : de ? "Organisation" : "Organization"}
                    </small>
                  </td>
                  <td>
                    <Badge
                      tone={
                        c.disabled
                          ? "neutral"
                          : c.status === "failed"
                            ? "danger"
                            : /verified/.test(c.status)
                              ? "success"
                              : "warning"
                      }
                    >
                      {c.disabled ? (de ? "deaktiviert" : "disabled") : c.status.replaceAll("_", " ")}
                    </Badge>
                    <small>
                      {c.health.code ?? (c.health.at ? at(c.health.at, locale) : "")}
                    </small>
                  </td>
                  <td>{c.secretVersion ? `v${c.secretVersion}` : "—"}</td>
                  <td>
                    {c.activeGrants}
                    {c.monthlyBudgetMicros !== null && (
                      <small>
                        {de ? "Budget" : "Budget"} {usdOf(c.monthlyBudgetMicros)}
                        {de ? "/Monat" : "/month"}
                      </small>
                    )}
                  </td>
                  <td className="row-actions">
                    <Button variant="outline" size="sm" onClick={() => setGranting(c)}>
                      {de ? "Freigaben" : "Grants"}
                    </Button>
                    {providers.find((p) => p.id === c.provider)?.channels &&
                      (mode === "owner" || c.scope === "system") && (
                        <Button variant="outline" size="sm" onClick={() => setChannels(c)}>
                          {de ? "Kanäle" : "Channels"}
                        </Button>
                      )}
                    {own(c) &&
                      providers
                        .find((p) => p.id === c.provider)
                        ?.purposes.includes("automation") && (
                        <Button variant="ghost" size="sm" onClick={() => setWorkflows(c)}>
                          Workflows
                        </Button>
                      )}
                    {own(c) && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={action.pending}
                          onClick={() => void action.run(() => post(`${base}/${c.id}/check`, {}))}
                        >
                          {de ? "Prüfen" : "Check"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRotating(c)}>
                          <KeyRound />
                          {de ? "Schlüssel" : "Secret"}
                        </Button>
                      </>
                    )}
                    {(own(c) || mode === "admin") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={action.pending}
                        onClick={() =>
                          void action.run(() =>
                            post(`${base}/${c.id}/${c.disabled ? "enable" : "disable"}`, {}),
                          )
                        }
                      >
                        <ShieldOff />
                        {c.disabled ? (de ? "Aktivieren" : "Enable") : de ? "Deaktivieren" : "Disable"}
                      </Button>
                    )}
                    {own(c) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${de ? "Entfernen:" : "Remove:"} ${c.label}`}
                        disabled={action.pending}
                        onClick={() => {
                          if (window.confirm(de ? `${c.label} entfernen?` : `Remove ${c.label}?`))
                            void action.run(() => remove(`${base}/${c.id}`));
                        }}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={de ? "Noch keine Verbindungen." : "No connections yet."} />
      )}
      {creating && (
        <Modal
          title={de ? "Verbindung anlegen" : "Add connection"}
          description={
            de
              ? "Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt."
              : "The secret is stored encrypted and never shown again."
          }
          onClose={() => setCreating(false)}
        >
          <DataForm
            fields={[
              {
                name: "provider",
                label: de ? "Anbieter" : "Provider",
                type: "select",
                required: true,
                options: providers
                  .filter((p) => p.scopes.includes(mode === "admin" ? "system" : "workspace"))
                  .map((p) => ({ value: p.id, label: p.label[locale] })),
              },
              { name: "label", label: de ? "Bezeichnung" : "Label", required: true },
              {
                name: "baseUrl",
                label: de ? "Basis-URL (optional)" : "Base URL (optional)",
                type: "url",
              },
              {
                name: "secret",
                label: de ? "API-Schlüssel oder Token" : "API key or token",
                type: "password",
                required: true,
                hint: de
                  ? "n8n und Kundenkontext: JSON mit apiKey/token und signingSecret."
                  : "n8n and customer context: JSON with apiKey/token and signingSecret.",
              },
              {
                name: "budget",
                label: de ? "Monatsbudget in USD (optional)" : "Monthly budget in USD (optional)",
                type: "number",
                min: 0,
                step: "0.01",
              },
            ]}
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Anlegen" : "Add"}
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              const done = await action.run(() =>
                post(base, {
                  provider: str(v, "provider"),
                  label: str(v, "label"),
                  config: str(v, "baseUrl") ? { baseUrl: str(v, "baseUrl") } : {},
                  secret: String(v.secret),
                  ...(microsOf(str(v, "budget")) !== undefined
                    ? { monthlyBudgetMicros: microsOf(str(v, "budget")) }
                    : {}),
                }),
              );
              if (done) setCreating(false);
            }}
          />
        </Modal>
      )}
      {rotating && (
        <Modal
          title={de ? "Schlüssel ersetzen" : "Replace secret"}
          description={
            de
              ? "Prüfbare Anbieter müssen den neuen Schlüssel erst akzeptieren; danach gilt er sofort für alle Freigaben."
              : "A checkable provider must accept the new secret first; then it applies at once to every grant."
          }
          onClose={() => setRotating(null)}
        >
          <DataForm
            fields={[
              {
                name: "secret",
                label: de ? "Neuer Schlüssel" : "New secret",
                type: "password",
                required: true,
              },
            ]}
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Ersetzen" : "Replace"}
            onCancel={() => setRotating(null)}
            onSubmit={async (v) => {
              const done = await action.run(() =>
                post(`${base}/${rotating.id}/secret`, { secret: String(v.secret) }),
              );
              if (done) setRotating(null);
            }}
          />
        </Modal>
      )}
      {workflows && (
        <WorkflowsDialog
          base={base}
          connection={workflows}
          locale={locale}
          onClose={() => setWorkflows(null)}
        />
      )}
      {channels && (
        <ChannelsDialog
          base={base}
          connection={channels}
          mode={mode}
          organizations={targets}
          locale={locale}
          onChecked={() => void action.run(() => post(`${base}/${channels.id}/check`, {}))}
          onClose={() => {
            setChannels(null);
            list.refresh();
          }}
        />
      )}
      {granting && (
        <GrantsDialog
          base={base}
          connection={granting}
          provider={providers.find((p) => p.id === granting.provider)}
          mode={mode}
          targets={targets}
          locale={locale}
          onClose={() => {
            setGranting(null);
            list.refresh();
          }}
        />
      )}
    </section>
  );
}

function GrantsDialog({
  base,
  connection,
  provider,
  mode,
  targets,
  locale,
  onClose,
}: {
  base: string;
  connection: Connection;
  provider?: Provider;
  mode: "admin" | "owner";
  targets: Array<{ id: string; name: string }>;
  locale: Locale;
  onClose: () => void;
}) {
  const de = locale === "de";
  const usage = useResource<{ grants: Grant[] }>(`${base}/${connection.id}/usage`);
  const action = useMutation(usage.refresh);
  const grantsBase = base.replace(/\/connections$/, "/connection-grants");
  const purposes = provider?.purposes ?? [];
  const [chosen, setChosen] = useState<string[]>(purposes);
  const toOrganization = mode === "admin";
  // Administrators never hand out an organization's own connection.
  const canGrant = mode === "owner" || connection.scope === "system";
  return (
    <Modal
      title={`${de ? "Freigaben" : "Grants"} · ${connection.label}`}
      description={
        toOrganization
          ? de
            ? "Freigabe an eine Organisation mit Monatsbudget; deren Owner verteilen sie auf Projekte."
            : "Grant to an organization with a monthly budget; its owners hand it on to projects."
          : de
            ? "Freigabe an ein Projekt dieser Organisation."
            : "Grant to a project of this organization."
      }
      onClose={onClose}
      wide
    >
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {usage.data ? (
        usage.data.grants.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{de ? "Freigegeben an" : "Granted to"}</th>
                  <th>{de ? "Zwecke" : "Purposes"}</th>
                  <th>{de ? "Budget" : "Budget"}</th>
                  <th>{de ? "Dieser Monat" : "This month"}</th>
                  <th>
                    <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.data.grants.map((g) => (
                  <tr key={g.id}>
                    <td>
                      {g.projectName ?? g.workspaceName}
                      <small>{g.projectId ? (de ? "Projekt" : "Project") : de ? "Organisation" : "Organization"}</small>
                    </td>
                    <td>{g.purposes.join(", ") || (de ? "alle" : "all")}</td>
                    <td>{usdOf(g.monthlyBudgetMicros)}</td>
                    <td>
                      {usdOf(g.settledMicros)}
                      {g.reservedMicros > 0 && (
                        <small>
                          + {usdOf(g.reservedMicros)} {de ? "reserviert" : "reserved"}
                        </small>
                      )}
                    </td>
                    <td>
                      {(mode === "admin" ? !g.projectId : Boolean(g.projectId)) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={action.pending}
                          onClick={() => void action.run(() => remove(`${grantsBase}/${g.id}`))}
                        >
                          {de ? "Widerrufen" : "Revoke"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={de ? "Noch keine Freigaben." : "No grants yet."} />
        )
      ) : (
        <ResourceError error={usage.error} retry={usage.refresh} />
      )}
      {canGrant && purposes.length > 0 && (
        <fieldset className="grant-list">
          <legend>{de ? "Zwecke der neuen Freigabe" : "Purposes of the new grant"}</legend>
          {purposes.map((p) => (
            <label key={p} className="module-role-row">
              <span>{p}</span>
              <input
                type="checkbox"
                checked={chosen.includes(p)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...chosen, p] : chosen.filter((x) => x !== p))
                }
              />
            </label>
          ))}
        </fieldset>
      )}
      {canGrant && (
      <DataForm
        fields={[
          {
            name: "target",
            label: toOrganization ? (de ? "Organisation" : "Organization") : de ? "Projekt" : "Project",
            type: "select",
            required: true,
            options: targets.map((t) => ({ value: t.id, label: t.name })),
          },
          {
            name: "budget",
            label: toOrganization
              ? de
                ? "Monatsbudget in USD"
                : "Monthly budget in USD"
              : de
                ? "Monatsbudget in USD (optional)"
                : "Monthly budget in USD (optional)",
            type: "number",
            min: 0,
            step: "0.01",
            required: toOrganization && purposes.some((p) => p === "text" || p === "image"),
          },
        ]}
        pending={action.pending}
        error={null}
        submitLabel={de ? "Freigeben" : "Grant"}
        onSubmit={(v) =>
          void action.run(() =>
            post(`${base}/${connection.id}/grants`, {
              ...(toOrganization
                ? { workspaceId: str(v, "target") }
                : { projectId: str(v, "target") }),
              purposes: chosen,
              ...(microsOf(str(v, "budget")) !== undefined
                ? { monthlyBudgetMicros: microsOf(str(v, "budget")) }
                : {}),
            }),
          )
        }
      />
      )}
    </Modal>
  );
}

type Binding = { id: string; contract: string; workflowRef: string; label: string };

/** Workflows of an automation connection bound to Orbit contracts (WP3.7). */
function WorkflowsDialog({
  base,
  connection,
  locale,
  onClose,
}: {
  base: string;
  connection: Connection;
  locale: Locale;
  onClose: () => void;
}) {
  const de = locale === "de";
  const list = useResource<{ items: Binding[] }>(`${base}/${connection.id}/workflows`);
  const action = useMutation(list.refresh);
  const unbindBase = base.replace(/\/connections$/, "/connection-workflows");
  return (
    <Modal
      title={`Workflows · ${connection.label}`}
      description={
        de
          ? "Ein Workflow bedient einen neutralen Orbit-Vertrag; produktspezifische Logik bleibt im Workflow."
          : "A workflow serves a neutral Orbit contract; product-specific logic stays in the workflow."
      }
      onClose={onClose}
      wide
    >
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {list.data?.items.length ? (
        <div className="data-list">
          {list.data.items.map((b) => (
            <div className="data-row" key={b.id}>
              <div>
                <strong>{b.label}</strong>
                <p>
                  {b.contract} · {b.workflowRef}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={action.pending}
                onClick={() => void action.run(() => remove(`${unbindBase}/${b.id}`))}
              >
                {de ? "Entfernen" : "Remove"}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty title={de ? "Noch keine Workflows." : "No workflows yet."} />
      )}
      <DataForm
        fields={[
          { name: "label", label: de ? "Bezeichnung" : "Label", required: true },
          {
            name: "contract",
            label: de ? "Vertrag" : "Contract",
            type: "select",
            value: "automation.v1",
            options: [
              { value: "automation.v1", label: "automation.v1" },
              { value: "customer_context.v1", label: "customer_context.v1" },
            ],
          },
          {
            name: "workflowRef",
            label: de ? "Webhook-Pfad" : "Webhook path",
            required: true,
            placeholder: "orbit/ticket-closed",
          },
        ]}
        pending={action.pending}
        error={null}
        submitLabel={de ? "Hinzufügen" : "Add"}
        onSubmit={(v) =>
          void action.run(() =>
            post(`${base}/${connection.id}/workflows`, {
              label: str(v, "label"),
              contract: str(v, "contract"),
              workflowRef: str(v, "workflowRef"),
            }),
          )
        }
      />
    </Modal>
  );
}

type ChannelState = {
  cutover: boolean;
  checkedAt: string | null;
  channels: Array<{ id: string; name: string; identifier: string; disabled: boolean }>;
  projects: Array<{ id: string; name: string }>;
  assignments: Record<string, string>;
  unavailable: string[];
};

/**
 * Hands the channels of a connection (Postiz accounts) to the
 * organization's projects, each channel to exactly one project. A project
 * with channels is bound automatically; without channels it loses access.
 */
function ChannelsDialog({
  base,
  connection,
  mode,
  organizations,
  locale,
  onChecked,
  onClose,
}: {
  base: string;
  connection: Connection;
  mode: "admin" | "owner";
  /** Organizations to choose from (administrators only). */
  organizations: Array<{ id: string; name: string }>;
  locale: Locale;
  onChecked: () => void;
  onClose: () => void;
}) {
  const de = locale === "de";
  const [org, setOrg] = useState(mode === "admin" ? (organizations[0]?.id ?? "") : "");
  const path = `${base}/${connection.id}/channels${
    mode === "admin" && org ? `?workspaceId=${encodeURIComponent(org)}` : ""
  }`;
  const state = useResource<ChannelState>(mode === "admin" && !org ? null : path);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const action = useMutation(() => {
    setDraft(null);
    state.refresh();
  });
  const data = state.data;
  const current = draft ?? data?.assignments ?? {};
  return (
    <Modal
      title={`${de ? "Kanäle" : "Channels"} · ${connection.label}`}
      description={
        de
          ? "Jeder Kanal gehört genau einem Projekt. Projekte mit Kanälen werden automatisch angebunden; ohne Kanal verlieren sie den Zugriff."
          : "Each channel belongs to exactly one project. Projects with channels are connected automatically; without a channel they lose access."
      }
      onClose={onClose}
      wide
    >
      {mode === "admin" && (
        <select
          className="input"
          aria-label={de ? "Organisation" : "Organization"}
          value={org}
          onChange={(e) => {
            setDraft(null);
            setOrg(e.target.value);
          }}
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {state.error && <ResourceError error={state.error} retry={state.refresh} />}
      {!data ? (
        !state.error && <Loading label={de ? "Wird geladen…" : "Loading…"} />
      ) : (
        <>
          {!data.cutover && (
            <Alert kind="warning">
              {de
                ? "Die Umstellung für diesen Anbieter ist noch nicht freigeschaltet; Zuweisungen sind erst danach möglich."
                : "The cutover for this provider is not enabled yet; assignments are possible only after it."}
            </Alert>
          )}
          <p>
            <small>
              {data.checkedAt
                ? `${de ? "Kanäle abgerufen" : "Channels fetched"} ${at(data.checkedAt, locale)}`
                : de
                  ? "Noch keine Kanäle abgerufen."
                  : "No channels fetched yet."}
            </small>{" "}
            {(mode === "owner" ? connection.scope === "workspace" : connection.scope === "system") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChecked();
                  window.setTimeout(state.refresh, 1500);
                }}
              >
                {de ? "Kanäle abrufen" : "Fetch channels"}
              </Button>
            )}
          </p>
          {data.channels.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{de ? "Kanal" : "Channel"}</th>
                    <th>{de ? "Projekt" : "Project"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((ch) => {
                    const elsewhere = data.unavailable.includes(ch.id);
                    return (
                      <tr key={ch.id}>
                        <td>
                          {ch.name}
                          <small>
                            {ch.identifier}
                            {ch.disabled ? (de ? " · in Postiz deaktiviert" : " · disabled in Postiz") : ""}
                          </small>
                        </td>
                        <td>
                          {elsewhere ? (
                            <Badge tone="neutral">
                              {de ? "andere Organisation" : "another organization"}
                            </Badge>
                          ) : (
                            <select
                              className="input"
                              aria-label={`${de ? "Projekt für" : "Project for"} ${ch.name}`}
                              value={current[ch.id] ?? ""}
                              disabled={ch.disabled || !data.cutover}
                              onChange={(e) => {
                                const next = { ...current };
                                if (e.target.value) next[ch.id] = e.target.value;
                                else delete next[ch.id];
                                setDraft(next);
                              }}
                            >
                              <option value="">{de ? "— nicht zugewiesen —" : "— not assigned —"}</option>
                              {data.projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={
                de
                  ? "Keine Kanäle bekannt. Rufe sie zuerst über die Verbindung ab."
                  : "No channels known. Fetch them from the connection first."
              }
            />
          )}
          <div className="form-actions">
            <Button variant="ghost" onClick={onClose}>
              {de ? "Schließen" : "Close"}
            </Button>
            <Button
              disabled={!draft || action.pending || !data.cutover}
              onClick={() =>
                void action.run(() =>
                  put(`${base}/${connection.id}/channels`, {
                    ...(mode === "admin" ? { workspaceId: org } : {}),
                    assignments: Object.fromEntries(
                      Object.entries(current).filter(
                        ([id]) =>
                          !data.unavailable.includes(id) &&
                          data.channels.some((c) => c.id === id && !c.disabled),
                      ),
                    ),
                  }),
                )
              }
            >
              {de ? "Zuweisung speichern" : "Save assignment"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
