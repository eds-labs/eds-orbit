"use client";
import { useState, type FormEvent } from "react";
import { patch, post, put, useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import type { SettingsSection } from "@/platform/shell/types";
import { cmsPath, type CmsSettings, type CmsStatus } from "./api";
import { cmsText, type SettingsText } from "./labels";

// The content module's sections of the settings center (ADR 0027, CH1.14f):
// websites (owner manages, members read) and the publishing rules.

export type SiteRules = {
  forbiddenPhrases: string[];
  plainText: boolean;
  titleMaxLength: number | null;
  excerptRequired: boolean;
  heroRequired: boolean;
};

export type ManagedSite = {
  id: string;
  name: string;
  baseUrl: string;
  locales: string[];
  defaultLocale: string;
  routes: Record<string, Record<string, string>>;
  trailingSlash: boolean;
  adapter: string;
  adapterConfig: { liveCheck?: boolean; previewPath?: string | null } & Record<
    string,
    unknown
  >;
  notifiers: Array<{ kind: string; endpointId?: string }>;
  contentRules: SiteRules;
  verification: "configured" | "read_verified" | "live_verified";
  archived: boolean;
  version: number;
};

type Endpoint = {
  id: string;
  name: string;
  url: string;
  ownerModule: string;
  status: string;
};

export const settingsError = (
  t: SettingsText,
  raw: string | null | undefined,
) => {
  if (!raw) return null;
  const code = raw.replaceAll(" ", "_");
  return t.errors[code] ?? `${t.errorOther} (${code})`;
};

/** Languages from a comma-separated input, unique, in order. */
export const parseLocales = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];

/** The site body the server accepts, from the form. */
export function siteBody(form: SiteForm) {
  const locales = parseLocales(form.locales);
  const routes = Object.fromEntries(
    locales.flatMap((l) =>
      form.routes[l]?.trim() ? [[l, form.routes[l]!.trim()]] : [],
    ),
  );
  return {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    locales,
    defaultLocale: locales.includes(form.defaultLocale)
      ? form.defaultLocale
      : (locales[0] ?? ""),
    // Routes of other content types and other notifier kinds are not edited
    // here; they are sent back unchanged.
    routes: {
      ...form.otherRoutes,
      ...(Object.keys(routes).length ? { article: routes } : {}),
    },
    trailingSlash: form.trailingSlash,
    adapterConfig: {
      ...form.adapterConfig,
      liveCheck: form.liveCheck,
      previewPath: form.previewPath.trim() || null,
    },
    notifiers: [
      ...form.otherNotifiers,
      ...form.endpointIds.map((endpointId) => ({
        kind: "webhook",
        endpointId,
      })),
    ],
    contentRules: {
      ...form.otherRules,
      forbiddenPhrases: form.forbidden
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 2)
        .slice(0, 100),
      plainText: form.plainText,
      titleMaxLength: form.titleMax.trim() ? Number(form.titleMax) : null,
      excerptRequired: form.excerptRequired,
      heroRequired: form.heroRequired,
    },
  };
}

type SiteForm = {
  name: string;
  baseUrl: string;
  locales: string;
  defaultLocale: string;
  routes: Record<string, string>;
  otherRoutes: Record<string, Record<string, string>>;
  otherNotifiers: ManagedSite["notifiers"];
  otherRules: Record<string, unknown>;
  trailingSlash: boolean;
  liveCheck: boolean;
  previewPath: string;
  adapterConfig: Record<string, unknown>;
  endpointIds: string[];
  forbidden: string;
  plainText: boolean;
  titleMax: string;
  excerptRequired: boolean;
  heroRequired: boolean;
};

export const formOfSite = (site: ManagedSite | null): SiteForm => ({
  name: site?.name ?? "",
  baseUrl: site?.baseUrl ?? "https://",
  locales: (site?.locales ?? ["de"]).join(", "),
  defaultLocale: site?.defaultLocale ?? "de",
  routes: site?.routes.article ?? {},
  otherRoutes: Object.fromEntries(
    Object.entries(site?.routes ?? {}).filter(([type]) => type !== "article"),
  ),
  otherNotifiers: (site?.notifiers ?? []).filter((n) => n.kind !== "webhook"),
  otherRules: { ...(site?.contentRules ?? {}) },
  trailingSlash: site?.trailingSlash ?? true,
  liveCheck: Boolean(site?.adapterConfig.liveCheck),
  previewPath: site?.adapterConfig.previewPath ?? "",
  adapterConfig: site?.adapterConfig ?? {},
  endpointIds: (site?.notifiers ?? []).flatMap((n) =>
    n.kind === "webhook" && n.endpointId ? [n.endpointId] : [],
  ),
  forbidden: (site?.contentRules.forbiddenPhrases ?? []).join("\n"),
  plainText: site?.contentRules.plainText ?? false,
  titleMax: site?.contentRules.titleMaxLength
    ? String(site.contentRules.titleMaxLength)
    : "",
  excerptRequired: site?.contentRules.excerptRequired ?? false,
  heroRequired: site?.contentRules.heroRequired ?? false,
});

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="cms-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function SiteEditor({
  site,
  endpoints,
  onDone,
  onCancel,
}: {
  site: ManagedSite | null;
  endpoints: Endpoint[] | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).settings;
  const [form, setForm] = useState<SiteForm>(() => formOfSite(site));
  const set = <K extends keyof SiteForm>(key: K, value: SiteForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const save = useMutation();
  const locales = parseLocales(form.locales);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = siteBody(form);
    const done = await save.run(() =>
      site
        ? patch(cmsPath(project.id, `/sites/${site.id}`), {
            version: site.version,
            ...body,
          })
        : post(cmsPath(project.id, "/sites"), body),
    );
    if (done) onDone();
  };
  return (
    <form onSubmit={submit} className="cms-site-editor">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cms-site-name">{t.name}</FieldLabel>
          <Input
            id="cms-site-name"
            required
            maxLength={80}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-site-url">{t.baseUrl}</FieldLabel>
          <Input
            id="cms-site-url"
            required
            type="url"
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-site-locales">{t.locales}</FieldLabel>
          <Input
            id="cms-site-locales"
            required
            value={form.locales}
            onChange={(e) => set("locales", e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-site-default">{t.defaultLocale}</FieldLabel>
          <select
            id="cms-site-default"
            className="input"
            value={
              locales.includes(form.defaultLocale)
                ? form.defaultLocale
                : (locales[0] ?? "")
            }
            onChange={(e) => set("defaultLocale", e.target.value)}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="cms-fieldset">
          <legend>{t.routes}</legend>
          {locales.map((l) => (
            <Field key={l}>
              <FieldLabel htmlFor={`cms-site-route-${l}`}>{l}</FieldLabel>
              <Input
                id={`cms-site-route-${l}`}
                placeholder={
                  l === form.defaultLocale
                    ? "/blog/{slug}/"
                    : `/${l}/blog/{slug}/`
                }
                value={form.routes[l] ?? ""}
                onChange={(e) =>
                  set("routes", { ...form.routes, [l]: e.target.value })
                }
              />
            </Field>
          ))}
          <span className="field-hint">{t.routeHint}</span>
        </fieldset>
        <Check
          label={t.trailingSlash}
          checked={form.trailingSlash}
          onChange={(v) => set("trailingSlash", v)}
        />
        <Check
          label={t.liveCheck}
          checked={form.liveCheck}
          onChange={(v) => set("liveCheck", v)}
        />
        <Field>
          <FieldLabel htmlFor="cms-site-preview">{t.previewPath}</FieldLabel>
          <Input
            id="cms-site-preview"
            value={form.previewPath}
            onChange={(e) => set("previewPath", e.target.value)}
          />
        </Field>
        <fieldset className="cms-fieldset">
          <legend>{t.notifiers}</legend>
          {endpoints?.length ? (
            endpoints.map((ep) => (
              <Check
                key={ep.id}
                label={`${ep.name} (${ep.url})`}
                checked={form.endpointIds.includes(ep.id)}
                onChange={(on) =>
                  set(
                    "endpointIds",
                    on
                      ? [...form.endpointIds, ep.id]
                      : form.endpointIds.filter((id) => id !== ep.id),
                  )
                }
              />
            ))
          ) : (
            <p className="field-hint">{t.noEndpoints}</p>
          )}
        </fieldset>
        <fieldset className="cms-fieldset">
          <legend>{t.rules}</legend>
          <Field>
            <FieldLabel htmlFor="cms-site-forbidden">{t.forbidden}</FieldLabel>
            <Textarea
              id="cms-site-forbidden"
              rows={3}
              value={form.forbidden}
              onChange={(e) => set("forbidden", e.target.value)}
            />
          </Field>
          <Check
            label={t.plainText}
            checked={form.plainText}
            onChange={(v) => set("plainText", v)}
          />
          <Field>
            <FieldLabel htmlFor="cms-site-title-max">{t.titleMax}</FieldLabel>
            <Input
              id="cms-site-title-max"
              type="number"
              min={10}
              max={200}
              value={form.titleMax}
              onChange={(e) => set("titleMax", e.target.value)}
            />
          </Field>
          <Check
            label={t.excerptRequired}
            checked={form.excerptRequired}
            onChange={(v) => set("excerptRequired", v)}
          />
          <Check
            label={t.heroRequired}
            checked={form.heroRequired}
            onChange={(v) => set("heroRequired", v)}
          />
        </fieldset>
      </FieldGroup>
      {save.error && <Alert kind="error">{settingsError(t, save.error)}</Alert>}
      <div className="cms-actions">
        <Button
          type="submit"
          disabled={save.pending || !form.name.trim() || !locales.length}
        >
          {site ? t.save : t.create}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t.cancel}
        </Button>
      </div>
    </form>
  );
}

function SitesSettings() {
  const { project, locale, isOwner } = useWorkspace();
  const t = cmsText(locale).settings;
  const sites = useResource<{ items: ManagedSite[] }>(
    cmsPath(project.id, "/sites?archived=true"),
  );
  // Webhook endpoints are owner data and exist only with ORBIT_WEBHOOKS.
  const hooks = useResource<{ items: Endpoint[] }>(
    isOwner ? `/projects/${encodeURIComponent(project.id)}/webhooks` : null,
  );
  const endpoints = hooks.data
    ? hooks.data.items.filter((e) => e.ownerModule === "cms")
    : null;
  const [editing, setEditing] = useState<ManagedSite | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = useMutation();
  const run = async (task: () => Promise<unknown>, message: string) => {
    setNotice(null);
    if (await act.run(task)) {
      setNotice(message);
      sites.refresh();
    }
  };
  const path = (id: string, rest: string) =>
    cmsPath(project.id, `/sites/${id}${rest}`);
  return (
    <div className="cms-panel">
      {!isOwner && <p className="field-hint">{t.ownerOnly}</p>}
      <ResourceError error={sites.error} retry={sites.refresh} />
      {notice && <Alert kind="success">{notice}</Alert>}
      {act.error && <Alert kind="error">{settingsError(t, act.error)}</Alert>}
      {sites.data &&
        (sites.data.items.length ? (
          <ul className="cms-revisions">
            {sites.data.items.map((site) =>
              editing !== "new" && editing?.id === site.id ? (
                <li key={site.id} className="cms-revision">
                  <SiteEditor
                    site={site}
                    endpoints={endpoints}
                    onCancel={() => setEditing(null)}
                    onDone={() => {
                      setEditing(null);
                      setNotice(t.saved);
                      sites.refresh();
                    }}
                  />
                </li>
              ) : (
                <li key={site.id} className="cms-revision">
                  <div>
                    <strong>{site.name}</strong>{" "}
                    <span className="field-hint">{site.baseUrl}</span>{" "}
                    {site.archived ? (
                      <Badge>{t.archived}</Badge>
                    ) : (
                      <Badge
                        tone={
                          site.verification === "configured"
                            ? "neutral"
                            : "success"
                        }
                      >
                        {t.verification[site.verification]}
                      </Badge>
                    )}
                    <p className="field-hint">
                      {site.locales.join(", ")} ·{" "}
                      {Object.entries(site.routes.article ?? {})
                        .map(([l, r]) => `${l}: ${r}`)
                        .join(" · ") || "/blog/{slug}/"}
                    </p>
                  </div>
                  {isOwner && (
                    <div className="cms-actions">
                      {!site.archived && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(site)}
                          >
                            {t.edit}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={act.pending}
                            onClick={() =>
                              void run(
                                () => post(path(site.id, "/verify"), {}),
                                t.verified,
                              )
                            }
                          >
                            {t.verify}
                          </Button>
                          {site.notifiers.length > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={act.pending}
                              onClick={() =>
                                void run(
                                  () =>
                                    post(path(site.id, "/notifiers/test"), {}),
                                  t.tested,
                                )
                              }
                            >
                              {t.testNotifiers}
                            </Button>
                          )}
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={act.pending}
                        onClick={() =>
                          void run(
                            () =>
                              post(
                                path(
                                  site.id,
                                  site.archived ? "/restore" : "/archive",
                                ),
                                { version: site.version },
                              ),
                            t.saved,
                          )
                        }
                      >
                        {site.archived ? t.restore : t.archive}
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="field-hint">{t.noSites}</p>
        ))}
      {isOwner &&
        (editing === "new" ? (
          <div className="cms-revision">
            <h3 className="cms-panel-title">{t.newSite}</h3>
            <SiteEditor
              site={null}
              endpoints={endpoints}
              onCancel={() => setEditing(null)}
              onDone={() => {
                setEditing(null);
                setNotice(t.saved);
                sites.refresh();
              }}
            />
          </div>
        ) : (
          <div>
            <Button onClick={() => setEditing("new")}>{t.newSite}</Button>
          </div>
        ))}
    </div>
  );
}

function PublishingSettings() {
  const { project, locale, isOwner } = useWorkspace();
  const t = cmsText(locale).settings;
  const status = useResource<CmsStatus>(cmsPath(project.id, "/status"));
  // Kept here: the form remounts with the new settings version after a save.
  const [saved, setSaved] = useState(false);
  return (
    <div className="cms-panel">
      <ResourceError error={status.error} retry={status.refresh} />
      {saved && <Alert kind="success">{t.saved}</Alert>}
      {status.data && (
        <PublishingForm
          key={status.data.settingsVersion}
          settings={status.data.settings}
          version={status.data.settingsVersion}
          editable={isOwner}
          onSaved={() => {
            setSaved(true);
            status.refresh();
          }}
          t={t}
        />
      )}
    </div>
  );
}

function PublishingForm({
  settings,
  version,
  editable,
  onSaved,
  t,
}: {
  settings: CmsSettings;
  version: number;
  editable: boolean;
  onSaved: () => void;
  t: SettingsText;
}) {
  const { project } = useWorkspace();
  const [form, setForm] = useState(settings);
  const save = useMutation();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await save.run(() =>
      put(cmsPath(project.id, "/settings"), {
        version,
        settings: { ...form, timeZone: form.timeZone?.trim() || null },
      }),
    );
    if (result) onSaved();
  };
  return (
    <form onSubmit={submit} className="cms-panel">
      {!editable && <p className="field-hint">{t.ownerOnly}</p>}
      <fieldset className="cms-fieldset" disabled={!editable}>
        <legend>{t.approvers}</legend>
        {(["owner_or_editor", "owner"] as const).map((value) => (
          <label key={value} className="cms-check">
            <input
              type="radio"
              name="cms-approvers"
              checked={form.publishApprovers === value}
              onChange={() => setForm({ ...form, publishApprovers: value })}
            />
            <span>
              {value === "owner" ? t.approverOwner : t.approverEditor}
            </span>
          </label>
        ))}
        <label className="cms-check">
          <input
            type="checkbox"
            checked={form.fourEyes}
            onChange={(e) => setForm({ ...form, fourEyes: e.target.checked })}
          />
          <span>{t.fourEyes}</span>
        </label>
        <Field>
          <FieldLabel htmlFor="cms-time-zone">{t.timeZone}</FieldLabel>
          <Input
            id="cms-time-zone"
            placeholder={project.timezone}
            value={form.timeZone ?? ""}
            onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-late-window">{t.lateWindow}</FieldLabel>
          <Input
            id="cms-late-window"
            type="number"
            min={1}
            max={168}
            value={form.lateWindowHours}
            onChange={(e) =>
              setForm({ ...form, lateWindowHours: Number(e.target.value) })
            }
          />
        </Field>
      </fieldset>
      {save.error && <Alert kind="error">{settingsError(t, save.error)}</Alert>}
      {editable && (
        <div>
          <Button type="submit" disabled={save.pending}>
            {t.save}
          </Button>
        </div>
      )}
    </form>
  );
}

const both = (key: keyof SettingsText) => ({
  en: cmsText("en").settings[key] as string,
  de: cmsText("de").settings[key] as string,
});

/** Content's sections of the settings center: /manage/p/:id/modules/cms/sites and …/publishing. */
export const cmsSettings: readonly SettingsSection[] = [
  {
    tab: { key: "cms-sites", label: both("sitesTab"), order: 10 },
    description: both("sitesDescription"),
    order: 10,
    useSection: () => ({ content: <SitesSettings /> }),
  },
  {
    tab: { key: "cms-publishing", label: both("publishingTab"), order: 20 },
    description: both("publishingDescription"),
    order: 20,
    useSection: () => ({ content: <PublishingSettings /> }),
  },
];
