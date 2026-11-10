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
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str, type FormField, type FormValues } from "@/platform/ui/form";
import { at, errorText } from "./texts";

// Central connections (ADR 0014): the same list, forms and grants for the
// system administration (system connections, granted to organizations
// with a budget) and the organization settings (own connections and
// granted system ones, granted to projects). Secrets are write-only.

type SecretField = {
  key: string;
  label: { en: string; de: string };
  secret?: boolean;
  pattern?: string;
  hint?: { en: string; de: string };
};
type Provider = {
  id: string;
  label: { en: string; de: string };
  scopes: string[];
  purposes: string[];
  checkable: boolean;
  /** Its channels are assigned to projects, one project each. */
  channels?: boolean;
  /** The parts of its JSON secret, asked for one by one. */
  secretFields?: SecretField[];
  /** Path on this Orbit the provider calls back (OAuth apps). */
  callbackPath?: string;
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
  workspaceId: string;
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

const fieldName = (provider: string, key: string) => `secret:${provider}:${key}`;
const browserOrigin = () => (typeof window === "undefined" ? "" : window.location.origin);

/**
 * The secret a form sends: for a provider with separate fields (developer
 * apps), the JSON of those fields; otherwise the single secret field.
 */
export function secretOf(provider: Provider | undefined, values: FormValues) {
  if (!provider?.secretFields?.length) return String(values.secret ?? "");
  return JSON.stringify(
    Object.fromEntries(
      provider.secretFields.map((f) => [f.key, String(values[fieldName(provider.id, f.key)] ?? "").trim()]),
    ),
  );
}

/** One field per part of the provider's secret, plus its callback URL. */
function appFields(
  provider: Provider,
  locale: Locale,
  origin: string,
  showWhen?: FormField["showWhen"],
): FormField[] {
  const de = locale === "de";
  const when = showWhen ? { showWhen } : {};
  return [
    ...(provider.callbackPath
      ? [
          {
            name: `callback:${provider.id}`,
            label: de ? "Callback-URL für die App" : "Callback URL for the app",
            readOnly: true,
            value: `${origin}${provider.callbackPath}`,
            copyLabel: de ? "Kopieren" : "Copy",
            hint: de
              ? "In der App des Anbieters als Callback- bzw. Redirect-URL eintragen."
              : "Enter it in the provider's app as the callback or redirect URL.",
            ...when,
          },
        ]
      : []),
    ...(provider.secretFields ?? []).map((f) => ({
      name: fieldName(provider.id, f.key),
      label: f.label[locale],
      type: f.secret ? ("password" as const) : ("text" as const),
      required: true,
      ...(f.pattern ? { pattern: f.pattern } : {}),
      ...(f.hint ? { hint: f.hint[locale] } : {}),
      ...when,
    })),
  ];
}

/**
 * The fields of "Add connection": developer apps ask for each key on its
 * own and show their callback URL; other providers keep one secret field.
 */
export function createFields(
  providers: Provider[],
  mode: "admin" | "owner",
  locale: Locale,
  origin: string,
): FormField[] {
  const de = locale === "de";
  const offered = providers.filter((p) => p.scopes.includes(mode === "admin" ? "system" : "workspace"));
  const plain = {
    name: "provider",
    values: ["", ...offered.filter((p) => !p.secretFields?.length).map((p) => p.id)],
  };
  return [
    {
      name: "provider",
      label: de ? "Anbieter" : "Provider",
      type: "select",
      required: true,
      options: offered.map((p) => ({ value: p.id, label: p.label[locale] })),
    },
    { name: "label", label: de ? "Bezeichnung" : "Label", required: true },
    {
      name: "baseUrl",
      label: de ? "Basis-URL (optional)" : "Base URL (optional)",
      type: "url",
      showWhen: plain,
    },
    {
      name: "secret",
      label: de ? "API-Schlüssel oder Token" : "API key or token",
      type: "password",
      required: true,
      hint: de
        ? "n8n und Kundenkontext: JSON mit apiKey/token und signingSecret. GitHub-App: JSON mit appId, appSlug, installationId und privateKey."
        : "n8n and customer context: JSON with apiKey/token and signingSecret. GitHub App: JSON with appId, appSlug, installationId and privateKey.",
      showWhen: plain,
    },
    ...offered
      .filter((p) => p.secretFields?.length)
      .flatMap((p) => appFields(p, locale, origin, { name: "provider", values: [p.id] })),
    {
      name: "budget",
      label: de ? "Monatsbudget in USD (optional)" : "Monthly budget in USD (optional)",
      type: "number",
      min: 0,
      step: "0.01",
      showWhen: plain,
    },
  ];
}

/**
 * The grant requests for an organization and the projects chosen with it.
 * An existing organization grant stays (a new one would end its project
 * grants); projects already granted are skipped; project purposes stay
 * within the organization's.
 */
export function grantRequests(input: {
  grants: Grant[];
  workspaceId: string;
  projectIds: string[];
  purposes: string[];
  budgetMicros: number | undefined;
}): Array<Record<string, unknown>> {
  const { grants, workspaceId, projectIds, purposes, budgetMicros } = input;
  const organization = grants.find((g) => g.workspaceId === workspaceId && !g.projectId);
  const out: Array<Record<string, unknown>> = [];
  if (!organization)
    out.push({
      workspaceId,
      purposes,
      ...(budgetMicros !== undefined ? { monthlyBudgetMicros: budgetMicros } : {}),
    });
  const allowed = organization?.purposes.length
    ? purposes.filter((p) => organization.purposes.includes(p))
    : purposes;
  for (const projectId of projectIds)
    if (!grants.some((g) => g.workspaceId === workspaceId && g.projectId === projectId))
      out.push({ workspaceId, projectId, purposes: allowed });
  return out;
}

/** The administration's grant: an organization and, in the same step, its projects. */
export function OrganizationGrantForm({
  targets,
  grants,
  purposes,
  budgetRequired,
  locale,
  pending,
  initialOrganization = "",
  onSubmit,
}: {
  targets: Array<{ id: string; name: string }>;
  grants: Grant[];
  purposes: string[];
  budgetRequired: boolean;
  locale: Locale;
  pending: boolean;
  initialOrganization?: string;
  onSubmit: (requests: Array<Record<string, unknown>>) => void;
}) {
  const de = locale === "de";
  const [organization, setOrganization] = useState(initialOrganization);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const projects = useResource<{ items: Array<{ id: string; name: string }> }>(
    organization ? `/admin/projects?workspaceId=${encodeURIComponent(organization)}` : null,
  );
  const organizationGranted = grants.some((g) => g.workspaceId === organization && !g.projectId);
  const granted = (projectId: string) =>
    grants.some((g) => g.workspaceId === organization && g.projectId === projectId);
  const requests = organization
    ? grantRequests({ grants, workspaceId: organization, projectIds, purposes, budgetMicros: microsOf(budget) })
    : [];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (requests.length) onSubmit(requests);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="grant-organization">{de ? "Organisation" : "Organization"}</FieldLabel>
          <select
            id="grant-organization"
            className="input"
            required
            value={organization}
            onChange={(event) => {
              setOrganization(event.target.value);
              setProjectIds([]);
            }}
          >
            <option value="">{de ? "Auswählen…" : "Select…"}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {organizationGranted && (
            <p className="field-hint">
              {de
                ? "Die Organisation ist schon freigegeben; es kommen nur die gewählten Projekte dazu."
                : "The organization is already granted; only the chosen projects are added."}
            </p>
          )}
        </Field>
        {!organizationGranted && (
          <Field>
            <FieldLabel htmlFor="grant-budget">
              {de ? "Monatsbudget in USD" : "Monthly budget in USD"}
              {budgetRequired ? <span aria-hidden="true"> *</span> : de ? " (optional)" : " (optional)"}
            </FieldLabel>
            <Input
              id="grant-budget"
              type="number"
              min={0}
              step="0.01"
              required={budgetRequired}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </Field>
        )}
        {organization && projects.data && (
          <fieldset className="grant-list">
            <legend>{de ? "Gleich auch für diese Projekte freigeben" : "Also grant to these projects"}</legend>
            {projects.data.items.length ? (
              projects.data.items.map((p) => (
                <label key={p.id} className="module-role-row">
                  <span>
                    {p.name}
                    {granted(p.id) && <small> · {de ? "bereits freigegeben" : "already granted"}</small>}
                  </span>
                  <input
                    type="checkbox"
                    checked={granted(p.id) || projectIds.includes(p.id)}
                    disabled={granted(p.id)}
                    onChange={(event) =>
                      setProjectIds(
                        event.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id),
                      )
                    }
                  />
                </label>
              ))
            ) : (
              <p className="field-hint">
                {de ? "Diese Organisation hat noch keine Projekte." : "This organization has no projects yet."}
              </p>
            )}
          </fieldset>
        )}
      </FieldGroup>
      <Button type="submit" disabled={pending || !requests.length}>
        {de ? "Freigeben" : "Grant"}
      </Button>
    </form>
  );
}

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
  // Some providers can only be checked in use (the X app needs an account).
  const checkable = (c: Connection) => providers.find((p) => p.id === c.provider)?.checkable ?? true;
  const rotatingProvider = rotating ? providers.find((p) => p.id === rotating.provider) : undefined;
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
                      {c.health.code ??
                        (c.health.at
                          ? at(c.health.at, locale)
                          : checkable(c)
                            ? ""
                            : de
                              ? "Wird bei der ersten Nutzung geprüft"
                              : "Checked when first used")}
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
                        {checkable(c) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={action.pending}
                            onClick={() => void action.run(() => post(`${base}/${c.id}/check`, {}))}
                          >
                            {de ? "Prüfen" : "Check"}
                          </Button>
                        )}
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
            fields={createFields(providers, mode, locale, browserOrigin())}
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Anlegen" : "Add"}
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              const chosen = providers.find((p) => p.id === str(v, "provider"));
              const done = await action.run(() =>
                post(base, {
                  provider: str(v, "provider"),
                  label: str(v, "label"),
                  config: str(v, "baseUrl") ? { baseUrl: str(v, "baseUrl") } : {},
                  secret: secretOf(chosen, v),
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
            fields={
              rotatingProvider?.secretFields?.length
                ? appFields(rotatingProvider, locale, browserOrigin())
                : [
                    {
                      name: "secret",
                      label: de ? "Neuer Schlüssel" : "New secret",
                      type: "password",
                      required: true,
                    },
                  ]
            }
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Ersetzen" : "Replace"}
            onCancel={() => setRotating(null)}
            onSubmit={async (v) => {
              const done = await action.run(() =>
                post(`${base}/${rotating.id}/secret`, { secret: secretOf(rotatingProvider, v) }),
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
            ? "Freigabe an eine Organisation und auf Wunsch gleich an ihre Projekte. Weitere Projekte geben Owner in den Organisationseinstellungen frei."
            : "Grant to an organization and, if you like, to its projects in the same step. Owners grant further projects in the organization settings."
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
      {canGrant && toOrganization && (
        <OrganizationGrantForm
          targets={targets}
          grants={usage.data?.grants ?? []}
          purposes={chosen}
          budgetRequired={purposes.some((p) => p === "text" || p === "image")}
          locale={locale}
          pending={action.pending}
          onSubmit={(requests) =>
            void action.run(async () => {
              try {
                // The organization first: its project grants hang below it.
                for (const body of requests) await post(`${base}/${connection.id}/grants`, body);
              } finally {
                usage.refresh();
              }
            })
          }
        />
      )}
      {canGrant && !toOrganization && (
        <DataForm
          fields={[
            {
              name: "target",
              label: de ? "Projekt" : "Project",
              type: "select",
              required: true,
              options: targets.map((t) => ({ value: t.id, label: t.name })),
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
          error={null}
          submitLabel={de ? "Freigeben" : "Grant"}
          onSubmit={(v) =>
            void action.run(() =>
              post(`${base}/${connection.id}/grants`, {
                projectId: str(v, "target"),
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
