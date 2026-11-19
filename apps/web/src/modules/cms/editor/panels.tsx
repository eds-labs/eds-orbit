"use client";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { post, put, useMutation, useResource, when } from "@/lib/api";
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
import type { OrbitDoc } from "../../../../../../packages/content-doc/src/index.ts";
import {
  cmsPath,
  type CmsAsset,
  type CmsAuthor,
  type CmsSettings,
  type CmsSite,
  type CmsTerm,
  type EntryDetail,
  type Preflight,
  type PreviewResult,
  type PublishResult,
} from "../api";
import { cmsText, type EditorText } from "../labels";
import { assetSrc } from "./media-picker";
import { lengthState, RECOMMENDED, SEO_MAX, seoChecks, type Seo } from "./seo";

// The editor's side panel (CH1.14b): publishing, SEO, images and social,
// categories and authors, translations. Draft fields save through the page's
// autosave; publishing, sites and translations are their own requests.

export type DraftForm = {
  title: string;
  excerpt: string;
  slug: string;
  seo: Seo;
  heroAssetId: string | null;
  authorIds: string[];
  termIds: string[];
};

export type SetField = <K extends keyof DraftForm>(
  key: K,
  value: DraftForm[K],
) => void;

/** A server error code as text; ApiError messages are codes with spaces. */
export function errorText(t: EditorText, raw: string | null | undefined) {
  if (!raw) return null;
  const code = raw.replaceAll(" ", "_");
  return t.errors[code] ?? `${t.errorOther} (${code})`;
}

/** The path of an entry on a site, like the server's entryPath. */
export function sitePath(
  site: CmsSite,
  type: string,
  locale: string,
  slug: string,
) {
  const pattern = site.routes?.[type]?.[locale] ?? "/blog/{slug}/";
  const path = pattern.replace("{slug}", encodeURIComponent(slug));
  const bare = path.replace(/\/+$/, "") || "/";
  return site.trailingSlash !== false && bare !== "/" ? `${bare}/` : bare;
}

export const siteUrl = (site: CmsSite, path: string) =>
  `${site.baseUrl.replace(/\/+$/, "")}${path}`;

// --- Publishing -------------------------------------------------------------

export function PublishPanel({
  detail,
  setDetail,
  sites,
  settings,
  editable,
  flush,
  draftVersion,
  base,
}: {
  detail: EntryDetail;
  setDetail: (next: EntryDetail) => void;
  sites: CmsSite[];
  settings: CmsSettings | null;
  editable: boolean;
  flush: () => Promise<boolean>;
  draftVersion: () => number;
  base: string;
}) {
  const { project, locale } = useWorkspace();
  const text = cmsText(locale);
  const t = text.editor;
  const e = detail.entry;
  const checks = useResource<Preflight>(
    `${base}/preflight?v=${detail.draft.version}&e=${e.version}`,
  );
  const serving = sites.filter(
    (s) => !s.archived && s.locales.includes(e.locale),
  );
  const [mode, setMode] = useState<"now" | "at">("now");
  const [local, setLocal] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewSite, setPreviewSite] = useState(
    detail.siteIds.find((id) => serving.some((s) => s.id === id)) ??
      serving[0]?.id ??
      "",
  );
  const act = useMutation();
  const zone = settings?.timeZone || project.timezone;
  const live = Boolean(e.publishedRevisionId);
  const busy = act.pending || Boolean(detail.pendingRequest) || !editable;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  const run = async (
    task: () => Promise<PublishResult | EntryDetail>,
    done: (r: PublishResult | EntryDetail) => string,
  ) => {
    setMessage(null);
    if (!(await flush())) return;
    const result = await act.run(task);
    if (result) {
      setDetail(result);
      setMessage(done(result));
    }
  };
  const publish = () =>
    run(
      () =>
        post<PublishResult>(`${base}/publication-requests`, {
          draftVersion: draftVersion(),
          ...(note.trim() ? { changeNote: note.trim() } : {}),
          ...(mode === "at" ? { local } : {}),
        }),
      (r) => {
        setNote("");
        return (r as PublishResult).mode === "requested"
          ? t.requested
          : mode === "at"
            ? t.scheduledDone
            : t.publishedNow;
      },
    );
  const unpublish = () => {
    if (!window.confirm(t.unpublishConfirm)) return;
    void run(
      () =>
        post<PublishResult>(`${base}/unpublish-requests`, {
          version: e.version,
        }),
      (r) =>
        (r as PublishResult).mode === "requested"
          ? t.requested
          : t.withdrawnNow,
    );
  };
  const cancel = () =>
    run(
      () =>
        post<EntryDetail>(`${base}/publication/cancel`, { version: e.version }),
      () => t.cancelled,
    );
  const toggleSite = (id: string, on: boolean) => {
    const siteIds = on
      ? [...detail.siteIds, id]
      : detail.siteIds.filter((s) => s !== id);
    void act
      .run(() =>
        put<EntryDetail>(`${base}/sites`, { siteIds, version: e.version }),
      )
      .then((next) => next && setDetail(next));
  };
  const openPreview = async () => {
    setPreview(null);
    if (!(await flush())) return;
    const result = await act.run(() =>
      post<PreviewResult>(`${base}/preview`, { siteId: previewSite }),
    );
    if (result) setPreview(result);
  };

  return (
    <div className="cms-panel">
      <dl className="detail-grid">
        <dt>{text.entries.filterStatus}</dt>
        <dd>
          {text.status[e.status]}
          {detail.pendingRequest && (
            <>
              {" "}
              <Badge tone="warning">{text.entries.waiting}</Badge>
            </>
          )}
        </dd>
        <dt>{text.entries.live}</dt>
        <dd>
          {detail.publishedRevision
            ? `#${detail.publishedRevision.number} · ${when(e.lastPublishedAt, locale, project.timezone)}`
            : text.entries.noLive}
        </dd>
        <dt>{text.entries.latest}</dt>
        <dd>
          {detail.latestRevision
            ? `#${detail.latestRevision.number} · ${when(detail.latestRevision.createdAt, locale, project.timezone)}`
            : "—"}
        </dd>
        {e.scheduledAt && (
          <>
            <dt>{text.entries.scheduledFor}</dt>
            <dd>{when(e.scheduledAt, locale, project.timezone)}</dd>
          </>
        )}
      </dl>
      {detail.unsavedChanges && (
        <p className="field-hint">{text.entries.unsaved}</p>
      )}

      <fieldset className="cms-fieldset">
        <legend>{t.sites}</legend>
        {serving.length ? (
          serving.map((s) => (
            <label key={s.id} className="cms-check">
              <input
                type="checkbox"
                checked={detail.siteIds.includes(s.id)}
                disabled={!editable || act.pending}
                onChange={(ev) => toggleSite(s.id, ev.target.checked)}
              />
              <span>
                {s.name} <span className="field-hint">{s.baseUrl}</span>
              </span>
            </label>
          ))
        ) : (
          <p className="field-hint">{text.entries.noSites}</p>
        )}
        {live && <p className="field-hint">{t.sitesHint}</p>}
      </fieldset>

      <section aria-labelledby="cms-preflight">
        <h3 id="cms-preflight" className="cms-panel-title">
          {text.entries.preflightTitle}
        </h3>
        <ResourceError error={checks.error} retry={checks.refresh} />
        {checks.data &&
          (checks.data.ok ? (
            <p className="field-hint">{text.entries.preflightOk}</p>
          ) : (
            <ul className="cms-issues">
              {checks.data.issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`}>
                  {text.entries.issue[issue.code] ??
                    `${text.entries.issueOther} (${issue.code})`}
                  {issue.siteId && (
                    <span className="field-hint">
                      {" "}
                      · {siteName(issue.siteId)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </section>

      {editable && (
        <>
          {detail.pendingRequest ? (
            <Button
              variant="outline"
              disabled={act.pending}
              onClick={() => void cancel()}
            >
              {t.cancelRequest}
            </Button>
          ) : (
            <FieldGroup>
              <fieldset className="cms-fieldset">
                <legend>{t.when}</legend>
                <label className="cms-check">
                  <input
                    type="radio"
                    name="cms-when"
                    checked={mode === "now"}
                    onChange={() => setMode("now")}
                  />
                  <span>{t.now}</span>
                </label>
                <label className="cms-check">
                  <input
                    type="radio"
                    name="cms-when"
                    checked={mode === "at"}
                    onChange={() => setMode("at")}
                  />
                  <span>{t.at}</span>
                </label>
                {mode === "at" && (
                  <>
                    <Input
                      type="datetime-local"
                      aria-label={t.at}
                      value={local}
                      onChange={(ev) => setLocal(ev.target.value)}
                    />
                    <span className="field-hint">{t.zone(zone)}</span>
                  </>
                )}
              </fieldset>
              <Field>
                <FieldLabel htmlFor="cms-change-note">
                  {t.changeNote}
                </FieldLabel>
                <Input
                  id="cms-change-note"
                  maxLength={300}
                  value={note}
                  onChange={(ev) => setNote(ev.target.value)}
                />
              </Field>
              <div className="cms-actions">
                <Button
                  disabled={
                    busy ||
                    (mode === "at" && !local) ||
                    (checks.data ? !checks.data.ok : false)
                  }
                  onClick={() => void publish()}
                >
                  {mode === "at" ? t.schedule : live ? t.update : t.publish}
                </Button>
                {e.scheduledAt && (
                  <Button
                    variant="outline"
                    disabled={act.pending}
                    onClick={() => void cancel()}
                  >
                    {t.cancelSchedule}
                  </Button>
                )}
              </div>
            </FieldGroup>
          )}
          <p className="field-hint">
            {text.approvers[settings?.publishApprovers ?? "owner_or_editor"]}
            {settings?.fourEyes ? ` ${text.fourEyes}` : ""}
          </p>
          {live && !detail.pendingRequest && (
            <Button variant="ghost" disabled={act.pending} onClick={unpublish}>
              {t.unpublish}
            </Button>
          )}
        </>
      )}
      {message && <Alert kind="success">{message}</Alert>}
      {act.error && <Alert kind="error">{errorText(t, act.error)}</Alert>}

      {serving.length > 0 && (
        <section aria-labelledby="cms-preview" className="cms-fieldset">
          <h3 id="cms-preview" className="cms-panel-title">
            {t.preview}
          </h3>
          <div className="cms-actions">
            <select
              aria-label={t.previewSite}
              className="input"
              value={previewSite}
              onChange={(ev) => setPreviewSite(ev.target.value)}
            >
              {serving.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              disabled={act.pending || !previewSite}
              onClick={() => void openPreview()}
            >
              {t.previewCreate}
            </Button>
          </div>
          {preview &&
            (preview.previewUrl ? (
              <a
                href={preview.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.previewOpen}
              </a>
            ) : (
              <p className="field-hint">
                {t.previewNoPath(
                  when(preview.expiresAt, locale, project.timezone),
                )}
              </p>
            ))}
        </section>
      )}
    </div>
  );
}

// --- SEO --------------------------------------------------------------------

function Meter({
  t,
  value,
  range,
}: {
  t: EditorText;
  value: string;
  range: { min: number; max: number };
}) {
  const state = lengthState(value, range);
  return (
    <span className={`field-hint cms-meter cms-meter-${state}`}>
      {t.length(value.trim().length, range.min, range.max)}
    </span>
  );
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function SeoPanel({
  form,
  setField,
  doc,
  detail,
  sites,
  editable,
}: {
  form: DraftForm;
  setField: SetField;
  doc: OrbitDoc;
  detail: EntryDetail;
  sites: CmsSite[];
  editable: boolean;
}) {
  const { locale } = useWorkspace();
  const t = cmsText(locale).editor;
  const e = detail.entry;
  const seo = form.seo;
  const set = (patch: Partial<Seo>) => setField("seo", { ...seo, ...patch });
  const site =
    sites.find(
      (s) => detail.siteIds.includes(s.id) && s.locales.includes(e.locale),
    ) ?? sites.find((s) => !s.archived && s.locales.includes(e.locale));
  const url = site
    ? siteUrl(site, sitePath(site, e.type, e.locale, form.slug || "…"))
    : null;
  const shownTitle = seo.seoTitle?.trim() || form.title.trim();
  const shownMeta = seo.metaDescription?.trim() || form.excerpt.trim();
  const robots = seo.robots ?? { index: true, follow: true };
  const checks = seoChecks({
    title: form.title,
    excerpt: form.excerpt,
    seo,
    doc,
  });
  const [keywords, setKeywords] = useState((seo.keywords ?? []).join(", "));
  return (
    <div className="cms-panel">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cms-slug">{t.slug}</FieldLabel>
          <Input
            id="cms-slug"
            value={form.slug}
            maxLength={120}
            disabled={!editable}
            aria-invalid={form.slug !== "" && !SLUG.test(form.slug)}
            onChange={(ev) => setField("slug", ev.target.value.toLowerCase())}
          />
          <span className="field-hint">{t.slugHint}</span>
          {url && (
            <span className="field-hint">
              {t.urlPreview}: <code>{url}</code>
            </span>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-seo-title">{t.seoTitle}</FieldLabel>
          <Input
            id="cms-seo-title"
            value={seo.seoTitle ?? ""}
            maxLength={SEO_MAX.seoTitle}
            disabled={!editable}
            onChange={(ev) => set({ seoTitle: ev.target.value })}
          />
          <Meter t={t} value={shownTitle} range={RECOMMENDED.seoTitle} />
          <span className="field-hint">{t.seoTitleHint}</span>
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-meta">{t.metaDescription}</FieldLabel>
          <Textarea
            id="cms-meta"
            rows={3}
            value={seo.metaDescription ?? ""}
            maxLength={SEO_MAX.metaDescription}
            disabled={!editable}
            onChange={(ev) => set({ metaDescription: ev.target.value })}
          />
          <Meter t={t} value={shownMeta} range={RECOMMENDED.metaDescription} />
          <span className="field-hint">{t.metaHint}</span>
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-focus">{t.focusKeyword}</FieldLabel>
          <Input
            id="cms-focus"
            value={seo.focusKeyword ?? ""}
            maxLength={SEO_MAX.focusKeyword}
            disabled={!editable}
            onChange={(ev) => set({ focusKeyword: ev.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-keywords">{t.keywords}</FieldLabel>
          <Input
            id="cms-keywords"
            value={keywords}
            disabled={!editable}
            onChange={(ev) => setKeywords(ev.target.value)}
            onBlur={() =>
              set({
                keywords: keywords
                  .split(",")
                  .map((k) => k.trim().slice(0, SEO_MAX.keyword))
                  .filter(Boolean)
                  .slice(0, SEO_MAX.keywords),
              })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-canonical">{t.canonical}</FieldLabel>
          <Input
            id="cms-canonical"
            type="url"
            placeholder="https://…"
            value={seo.canonicalOverride ?? ""}
            maxLength={2048}
            disabled={!editable}
            onChange={(ev) => set({ canonicalOverride: ev.target.value })}
          />
        </Field>
        <label className="cms-check">
          <input
            type="checkbox"
            checked={robots.index}
            disabled={!editable}
            onChange={(ev) =>
              set({ robots: { ...robots, index: ev.target.checked } })
            }
          />
          <span>{t.robotsIndex}</span>
        </label>
        <label className="cms-check">
          <input
            type="checkbox"
            checked={robots.follow}
            disabled={!editable}
            onChange={(ev) =>
              set({ robots: { ...robots, follow: ev.target.checked } })
            }
          />
          <span>{t.robotsFollow}</span>
        </label>
      </FieldGroup>
      <section aria-labelledby="cms-snippet" className="cms-fieldset">
        <h3 id="cms-snippet" className="cms-panel-title">
          {t.snippet}
        </h3>
        <div className="cms-snippet">
          {url && <span className="cms-snippet-url">{url}</span>}
          <span className="cms-snippet-title">{shownTitle || "—"}</span>
          <span className="cms-snippet-text">{shownMeta || "—"}</span>
        </div>
      </section>
      <section aria-labelledby="cms-seo-checks" className="cms-fieldset">
        <h3 id="cms-seo-checks" className="cms-panel-title">
          {t.checksTitle}
        </h3>
        <ul className="cms-checks">
          {checks.map((check) => (
            <li
              key={check.code}
              className={check.ok ? "cms-check-ok" : "cms-check-todo"}
            >
              <span aria-hidden="true">{check.ok ? "✓" : "•"}</span>{" "}
              {t.checks[check.code]}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// --- Images and social --------------------------------------------------------

function ImageChoice({
  label,
  assetId,
  asset,
  editable,
  onChoose,
  onRemove,
  t,
}: {
  label: string;
  assetId: string | null | undefined;
  asset: CmsAsset | undefined;
  editable: boolean;
  onChoose: () => void;
  onRemove: () => void;
  t: EditorText;
}) {
  const { project } = useWorkspace();
  const src = asset ? assetSrc(project.id, asset) : null;
  return (
    <Field>
      <span className="field-label">{label}</span>
      {assetId ? (
        <div className="cms-image-choice">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- private, uncached member route
            <img src={src} alt="" />
          ) : (
            <div className="cms-figure-missing" />
          )}
          {editable && (
            <div className="cms-actions">
              <Button size="sm" variant="outline" onClick={onChoose}>
                {t.chooseImage}
              </Button>
              <Button size="sm" variant="ghost" onClick={onRemove}>
                {t.removeImage}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="cms-actions">
          <span className="field-hint">{t.noImage}</span>
          {editable && (
            <Button size="sm" variant="outline" onClick={onChoose}>
              {t.chooseImage}
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

export function SocialPanel({
  form,
  setField,
  editable,
  assets,
  pick,
}: {
  form: DraftForm;
  setField: SetField;
  editable: boolean;
  assets: Record<string, CmsAsset>;
  pick: () => Promise<CmsAsset | null>;
}) {
  const { locale } = useWorkspace();
  const t = cmsText(locale).editor;
  const seo = form.seo;
  const set = (patch: Partial<Seo>) => setField("seo", { ...seo, ...patch });
  return (
    <div className="cms-panel">
      <FieldGroup>
        <ImageChoice
          t={t}
          label={t.hero}
          assetId={form.heroAssetId}
          asset={form.heroAssetId ? assets[form.heroAssetId] : undefined}
          editable={editable}
          onChoose={async () => {
            const asset = await pick();
            if (asset) setField("heroAssetId", asset.id);
          }}
          onRemove={() => setField("heroAssetId", null)}
        />
        <Field>
          <FieldLabel htmlFor="cms-og-title">{t.ogTitle}</FieldLabel>
          <Input
            id="cms-og-title"
            value={seo.ogTitle ?? ""}
            maxLength={SEO_MAX.ogTitle}
            disabled={!editable}
            onChange={(ev) => set({ ogTitle: ev.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-og-description">
            {t.ogDescription}
          </FieldLabel>
          <Textarea
            id="cms-og-description"
            rows={3}
            value={seo.ogDescription ?? ""}
            maxLength={SEO_MAX.ogDescription}
            disabled={!editable}
            onChange={(ev) => set({ ogDescription: ev.target.value })}
          />
        </Field>
        <ImageChoice
          t={t}
          label={t.ogImage}
          assetId={seo.ogImageAssetId}
          asset={seo.ogImageAssetId ? assets[seo.ogImageAssetId] : undefined}
          editable={editable}
          onChoose={async () => {
            const asset = await pick();
            if (asset) set({ ogImageAssetId: asset.id });
          }}
          onRemove={() => set({ ogImageAssetId: undefined })}
        />
      </FieldGroup>
    </div>
  );
}

// --- Categories and authors ---------------------------------------------------

function Choices<T extends { id: string; name: string; archived: boolean }>({
  legend,
  items,
  chosen,
  editable,
  empty,
  onChange,
}: {
  legend: string;
  items: T[];
  chosen: string[];
  editable: boolean;
  empty: string;
  onChange: (ids: string[]) => void;
}) {
  // Archived items stay visible while the draft still names them.
  const shown = items.filter(
    (item) => !item.archived || chosen.includes(item.id),
  );
  return (
    <fieldset className="cms-fieldset">
      <legend>{legend}</legend>
      {shown.length ? (
        shown.map((item) => (
          <label key={item.id} className="cms-check">
            <input
              type="checkbox"
              checked={chosen.includes(item.id)}
              disabled={!editable}
              onChange={(ev) =>
                onChange(
                  ev.target.checked
                    ? [...chosen, item.id]
                    : chosen.filter((id) => id !== item.id),
                )
              }
            />
            <span>{item.name}</span>
          </label>
        ))
      ) : (
        <p className="field-hint">{empty}</p>
      )}
    </fieldset>
  );
}

export function TaxonomyPanel({
  form,
  setField,
  entryLocale,
  editable,
}: {
  form: DraftForm;
  setField: SetField;
  entryLocale: string;
  editable: boolean;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).editor;
  const terms = useResource<{ items: CmsTerm[] }>(
    cmsPath(
      project.id,
      `/terms?locale=${encodeURIComponent(entryLocale)}&archived=true`,
    ),
  );
  const authors = useResource<{ items: CmsAuthor[] }>(
    cmsPath(project.id, "/authors?archived=true"),
  );
  const all = terms.data?.items ?? [];
  const setTerms = (kind: CmsTerm["kind"], ids: string[]) => {
    const others = form.termIds.filter(
      (id) => all.find((term) => term.id === id)?.kind !== kind,
    );
    setField("termIds", [...others, ...ids]);
  };
  return (
    <div className="cms-panel">
      <ResourceError error={terms.error} retry={terms.refresh} />
      {terms.data &&
        (["category", "tag"] as const).map((kind) => (
          <Choices
            key={kind}
            legend={kind === "category" ? t.categories : t.tags}
            items={all.filter((term) => term.kind === kind)}
            chosen={form.termIds.filter(
              (id) => all.find((term) => term.id === id)?.kind === kind,
            )}
            editable={editable}
            empty={t.noTerms}
            onChange={(ids) => setTerms(kind, ids)}
          />
        ))}
      <ResourceError error={authors.error} retry={authors.refresh} />
      {authors.data && (
        <Choices
          legend={t.authors}
          items={authors.data.items}
          chosen={form.authorIds}
          editable={editable}
          empty={t.noAuthors}
          onChange={(ids) => setField("authorIds", ids)}
        />
      )}
      <p className="field-hint">{t.termsLater}</p>
    </div>
  );
}

// --- Translations ---------------------------------------------------------------

export function TranslationsPanel({
  detail,
  sites,
  editable,
  base,
}: {
  detail: EntryDetail;
  sites: CmsSite[];
  editable: boolean;
  base: string;
}) {
  const { locale } = useWorkspace();
  const text = cmsText(locale);
  const t = text.editor;
  const router = useRouter();
  const pathname = usePathname();
  const taken = new Set([
    detail.entry.locale,
    ...detail.translations.map((tr) => tr.locale),
  ]);
  const open = [
    ...new Set(sites.filter((s) => !s.archived).flatMap((s) => s.locales)),
  ]
    .filter((l) => !taken.has(l))
    .sort();
  const [target, setTarget] = useState(open[0] ?? "");
  const [copy, setCopy] = useState(true);
  const create = useMutation();
  return (
    <div className="cms-panel">
      {detail.translations.length ? (
        <ul className="cms-translations">
          {detail.translations.map((tr) => (
            <li key={tr.id}>
              <a href={`?entry=${tr.id}`}>{tr.locale}</a>{" "}
              <Badge>{text.status[tr.status]}</Badge>{" "}
              <span className="field-hint">/{tr.slug}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">{t.translationsNone}</p>
      )}
      {editable &&
        (open.length ? (
          <form
            className="cms-fieldset"
            onSubmit={async (ev) => {
              ev.preventDefault();
              const next = await create.run(() =>
                post<EntryDetail>(`${base}/translations`, {
                  locale: target,
                  copy,
                }),
              );
              if (next) router.push(`${pathname}?entry=${next.entry.id}`);
            }}
          >
            <h3 className="cms-panel-title">{t.newTranslation}</h3>
            <Field>
              <FieldLabel htmlFor="cms-translation-locale">
                {t.translationLocale}
              </FieldLabel>
              <select
                id="cms-translation-locale"
                className="input"
                value={target}
                onChange={(ev) => setTarget(ev.target.value)}
              >
                {open.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <label className="cms-check">
              <input
                type="checkbox"
                checked={copy}
                onChange={(ev) => setCopy(ev.target.checked)}
              />
              <span>{t.translationCopy}</span>
            </label>
            {create.error && (
              <Alert kind="error">{errorText(t, create.error)}</Alert>
            )}
            <Button
              type="submit"
              variant="outline"
              disabled={create.pending || !target}
            >
              {t.translationCreate}
            </Button>
          </form>
        ) : (
          <p className="field-hint">{t.noMoreLocales}</p>
        ))}
    </div>
  );
}
