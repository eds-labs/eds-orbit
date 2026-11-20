"use client";
import { useState, type FormEvent } from "react";
import { patch, post, useMutation, useResource, when } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { IntegrationContribution } from "@/platform/shell/types";
import { cmsPath, type SiteList } from "./api";
import { cmsText, type IntegrationsText } from "./labels";
import { settingsError } from "./settings-sections";

// Project API keys and outbound webhooks in the settings center's
// Integrations area (ADR 0029, CH1.14f). Both are platform capabilities
// (CH1.1, CH1.3); today only the content module registers scopes and
// events, so its manifest contributes these sections. Owners only; a key
// or signing secret is shown once.

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  resourceFilter: { siteIds?: string[] };
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: "active" | "revoked" | "expired";
};
type Text = string | { en: string; de: string };
type Scope = {
  key: string;
  module: string;
  access: "read" | "write";
  description: Text;
};

/** A registered description in the interface language (the server sends both). */
export const textIn = (value: Text | undefined, locale: "en" | "de") =>
  !value ? "" : typeof value === "string" ? value : (value[locale] ?? value.en);
type Endpoint = {
  id: string;
  ownerModule: string;
  name: string;
  url: string;
  eventTypes: string[];
  status: "active" | "disabled";
  consecutiveFailures: number;
  disabledReason: string | null;
  version: number;
};
type Delivery = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatus: number | null;
  createdAt: string;
};

const projectPath = (projectId: string, rest: string) =>
  `/projects/${encodeURIComponent(projectId)}${rest}`;

/** A once-shown secret with its warning. */
function Secret({ value, note }: { value: string; note: string }) {
  return (
    <Alert kind="warning">
      {note}
      <code className="cms-secret">{value}</code>
    </Alert>
  );
}

/** Whether a 404 means the feature flag is off rather than a missing project. */
const flagOff = (error: { code?: string; status?: number } | null) =>
  error?.status === 404;

export function ApiKeysSection() {
  const { project, locale, isOwner } = useWorkspace();
  const t = cmsText(locale).integrations;
  const keys = useResource<{ items: ApiKey[]; scopes: Scope[] }>(
    isOwner ? projectPath(project.id, "/api-keys") : null,
  );
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [days, setDays] = useState("365");
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const act = useMutation();
  if (!isOwner)
    return <p className="field-hint">{cmsText(locale).settings.ownerOnly}</p>;
  if (flagOff(keys.error as never))
    return <p className="field-hint">{t.off("ORBIT_API_V1")}</p>;
  const writes = (keys.data?.scopes ?? []).filter(
    (s) => scopes.includes(s.key) && s.access === "write",
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setToken(null);
    const created = await act.run(() =>
      post<{ token: string }>(projectPath(project.id, "/api-keys"), {
        name: name.trim(),
        scopes,
        resourceFilter: siteIds.length ? { siteIds } : {},
        expiresInDays: days.trim() ? Number(days) : null,
        confirmWrite,
      }),
    );
    if (created) {
      setToken(created.token);
      setName("");
      setScopes([]);
      setSiteIds([]);
      setConfirmWrite(false);
      keys.refresh();
    }
  };
  const revoke = async (key: ApiKey) => {
    if (!window.confirm(t.revokeConfirm)) return;
    if (
      await act.run(() =>
        post(projectPath(project.id, `/api-keys/${key.id}/revoke`), {}),
      )
    )
      keys.refresh();
  };
  return (
    <div className="cms-panel">
      {token && <Secret value={token} note={t.tokenOnce} />}
      {act.error && (
        <Alert kind="error">
          {settingsError(cmsText(locale).settings, act.error)}
        </Alert>
      )}
      {keys.data &&
        (keys.data.items.length ? (
          <ul className="cms-revisions">
            {keys.data.items.map((key) => (
              <li key={key.id} className="cms-revision">
                <div>
                  <strong>{key.name}</strong>{" "}
                  <code className="field-hint">{key.prefix}…</code>{" "}
                  <Badge tone={key.status === "active" ? "success" : "neutral"}>
                    {t.statuses[key.status]}
                  </Badge>
                  <p className="field-hint">
                    {key.scopes.join(", ")} · {t.lastUsed}:{" "}
                    {key.lastUsedAt
                      ? when(key.lastUsedAt, locale, project.timezone)
                      : t.never}
                    {key.expiresAt
                      ? ` · ${when(key.expiresAt, locale, project.timezone)}`
                      : ""}
                  </p>
                </div>
                {key.status === "active" && (
                  <div className="cms-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={act.pending}
                      onClick={() => void revoke(key)}
                    >
                      {t.revoke}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-hint">{t.noKeys}</p>
        ))}
      {keys.data && (
        <form onSubmit={submit} className="cms-revision">
          <h3 className="cms-panel-title">{t.newKey}</h3>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cms-key-name">{t.keyName}</FieldLabel>
              <Input
                id="cms-key-name"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <fieldset className="cms-fieldset">
              <legend>{t.scopes}</legend>
              {keys.data.scopes.map((scope) => (
                <label key={scope.key} className="cms-check">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.key)}
                    onChange={(e) =>
                      setScopes(
                        e.target.checked
                          ? [...scopes, scope.key]
                          : scopes.filter((s) => s !== scope.key),
                      )
                    }
                  />
                  <span>
                    <code>{scope.key}</code>{" "}
                    <span className="field-hint">
                      {textIn(scope.description, locale)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {(sites.data?.items.length ?? 0) > 0 && (
              <fieldset className="cms-fieldset">
                <legend>{t.siteFilter}</legend>
                {sites.data!.items.map((site) => (
                  <label key={site.id} className="cms-check">
                    <input
                      type="checkbox"
                      checked={siteIds.includes(site.id)}
                      onChange={(e) =>
                        setSiteIds(
                          e.target.checked
                            ? [...siteIds, site.id]
                            : siteIds.filter((id) => id !== site.id),
                        )
                      }
                    />
                    <span>{site.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <Field>
              <FieldLabel htmlFor="cms-key-days">{t.expires}</FieldLabel>
              <Input
                id="cms-key-days"
                type="number"
                min={1}
                max={730}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
            {writes.length > 0 && (
              <label className="cms-check">
                <input
                  type="checkbox"
                  checked={confirmWrite}
                  onChange={(e) => setConfirmWrite(e.target.checked)}
                />
                <span>{t.confirmWrite}</span>
              </label>
            )}
          </FieldGroup>
          <Button
            type="submit"
            disabled={
              act.pending ||
              !name.trim() ||
              !scopes.length ||
              (writes.length > 0 && !confirmWrite)
            }
          >
            {t.create}
          </Button>
        </form>
      )}
    </div>
  );
}

function Deliveries({
  endpointId,
  t,
}: {
  endpointId: string;
  t: IntegrationsText;
}) {
  const { project, locale } = useWorkspace();
  const list = useResource<{ items: Delivery[] }>(
    projectPath(project.id, `/webhooks/${endpointId}/deliveries`),
  );
  const replay = useMutation(list.refresh);
  if (!list.data?.items.length) return null;
  return (
    <details>
      <summary className="field-hint">{t.deliveries}</summary>
      <ul className="cms-revisions">
        {list.data.items.slice(0, 10).map((d) => (
          <li key={d.id} className="field-hint">
            {when(d.createdAt, locale, project.timezone)} · {d.eventType} ·{" "}
            {d.status}
            {d.lastStatus ? ` (${d.lastStatus})` : ""} ·{" "}
            <Button
              size="sm"
              variant="ghost"
              disabled={replay.pending}
              onClick={() =>
                void replay.run(() =>
                  post(
                    projectPath(
                      project.id,
                      `/webhooks/deliveries/${d.id}/replay`,
                    ),
                    {},
                  ),
                )
              }
            >
              {t.replay}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function WebhooksSection() {
  const { project, locale, isOwner } = useWorkspace();
  const t = cmsText(locale).integrations;
  const hooks = useResource<{
    items: Endpoint[];
    events: Array<{ type: string; module: string; description: Text }>;
  }>(isOwner ? projectPath(project.id, "/webhooks") : null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = useMutation();
  if (!isOwner)
    return <p className="field-hint">{cmsText(locale).settings.ownerOnly}</p>;
  if (flagOff(hooks.error as never))
    return <p className="field-hint">{t.off("ORBIT_WEBHOOKS")}</p>;
  const cmsEvents = (hooks.data?.events ?? []).filter(
    (e) => e.module === "cms",
  );
  const run = async <T,>(task: () => Promise<T>, after?: (r: T) => void) => {
    setNotice(null);
    setSecret(null);
    const result = await act.run(task);
    if (result !== undefined) {
      after?.(result);
      hooks.refresh();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        post<{ secret: string }>(projectPath(project.id, "/webhooks"), {
          ownerModule: "cms",
          name: name.trim(),
          url: url.trim(),
          eventTypes: events,
        }),
      (r) => {
        setSecret(r.secret);
        setName("");
        setUrl("https://");
        setEvents([]);
      },
    );
  };
  return (
    <div className="cms-panel">
      {secret && <Secret value={secret} note={t.secretOnce} />}
      {notice && <Alert kind="success">{notice}</Alert>}
      {act.error && (
        <Alert kind="error">
          {settingsError(cmsText(locale).settings, act.error)}
        </Alert>
      )}
      {hooks.data &&
        (hooks.data.items.length ? (
          <ul className="cms-revisions">
            {hooks.data.items.map((ep) => (
              <li key={ep.id} className="cms-revision">
                <div>
                  <strong>{ep.name}</strong>{" "}
                  <span className="field-hint">{ep.url}</span>{" "}
                  <Badge tone={ep.status === "active" ? "success" : "warning"}>
                    {t.endpointStatus[ep.status]}
                  </Badge>
                  <p className="field-hint">
                    {ep.eventTypes.join(", ")}
                    {ep.disabledReason ? ` · ${ep.disabledReason}` : ""}
                  </p>
                </div>
                <div className="cms-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.pending || ep.status !== "active"}
                    onClick={() =>
                      void run(
                        () =>
                          post(
                            projectPath(project.id, `/webhooks/${ep.id}/ping`),
                            {},
                          ),
                        () => setNotice(t.pinged),
                      )
                    }
                  >
                    {t.ping}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.pending}
                    onClick={() =>
                      void run(
                        () =>
                          post<{ secret: string }>(
                            projectPath(
                              project.id,
                              `/webhooks/${ep.id}/rotate-secret`,
                            ),
                            {},
                          ),
                        (r) => setSecret(r.secret),
                      )
                    }
                  >
                    {t.rotate}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={act.pending}
                    onClick={() =>
                      void run(() =>
                        patch(projectPath(project.id, `/webhooks/${ep.id}`), {
                          version: ep.version,
                          status:
                            ep.status === "active" ? "disabled" : "active",
                        }),
                      )
                    }
                  >
                    {ep.status === "active" ? t.disable : t.enable}
                  </Button>
                </div>
                <Deliveries endpointId={ep.id} t={t} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-hint">{t.noEndpoints}</p>
        ))}
      {hooks.data && (
        <form onSubmit={submit} className="cms-revision">
          <h3 className="cms-panel-title">{t.newEndpoint}</h3>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cms-hook-name">{t.endpointName}</FieldLabel>
              <Input
                id="cms-hook-name"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cms-hook-url">{t.endpointUrl}</FieldLabel>
              <Input
                id="cms-hook-url"
                required
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <fieldset className="cms-fieldset">
              <legend>{t.events}</legend>
              {cmsEvents.map((ev) => (
                <label key={ev.type} className="cms-check">
                  <input
                    type="checkbox"
                    checked={events.includes(ev.type)}
                    onChange={(e) =>
                      setEvents(
                        e.target.checked
                          ? [...events, ev.type]
                          : events.filter((x) => x !== ev.type),
                      )
                    }
                  />
                  <span>
                    <code>{ev.type}</code>{" "}
                    <span className="field-hint">
                      {textIn(ev.description, locale)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </FieldGroup>
          <Button
            type="submit"
            disabled={act.pending || !name.trim() || !events.length}
          >
            {t.createEndpoint}
          </Button>
        </form>
      )}
    </div>
  );
}

const both = (
  key:
    "keysLabel" | "keysDescription" | "webhooksLabel" | "webhooksDescription",
) => ({
  en: cmsText("en").integrations[key],
  de: cmsText("de").integrations[key],
});

/** Integrations sections: /manage/p/:id/integrations/cms/api-keys and …/webhooks. */
export const cmsIntegrations: readonly IntegrationContribution[] = [
  {
    id: "api-keys",
    label: both("keysLabel"),
    description: both("keysDescription"),
    order: 60,
    component: ApiKeysSection,
  },
  {
    id: "webhooks",
    label: both("webhooksLabel"),
    description: both("webhooksDescription"),
    order: 61,
    component: WebhooksSection,
  },
];
