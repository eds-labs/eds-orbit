"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { api, ApiError, patch, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Field,
  FieldLabel,
  Loading,
  Tabs,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  emptyDoc,
  fromTiptap,
  isOrbitDoc,
  referencedAssetIds,
  toTiptap,
  validateOrbitDoc,
  type OrbitDoc,
  type TiptapChange,
  type TiptapNode,
} from "../../../../../../packages/content-doc/src/index.ts";
import {
  cmsPath,
  type CmsAsset,
  type CmsStatus,
  type EntryDetail,
  type SiteList,
} from "../api";
import { cmsText, type EditorText } from "../labels";
import { assetSrc, MediaPicker } from "./media-picker";
import type { PasteNotice } from "./paste";
import {
  errorText,
  PublishPanel,
  SeoPanel,
  SocialPanel,
  TaxonomyPanel,
  TranslationsPanel,
  type DraftForm,
  type SetField,
} from "./panels";
import type { Seo } from "./seo";

// The content editor (ADR 0029 §5, CH1.14b): title, excerpt and the TipTap
// canvas, with a side panel for publishing, SEO, images, categories and
// translations. Draft fields save automatically with the draft's version; a
// conflict asks to reload instead of overwriting someone else's work.

const Canvas = dynamic(() => import("./canvas"), {
  ssr: false,
  loading: () => <div className="cms-canvas cms-canvas-loading" />,
});

const AUTOSAVE_MS = 1200;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type SaveState = keyof EditorText["save"];

export function formOf(detail: EntryDetail): DraftForm {
  return {
    title: detail.draft.title,
    excerpt: detail.draft.excerpt,
    slug: detail.entry.slug,
    seo: (detail.draft.seo ?? {}) as Seo,
    heroAssetId: detail.draft.heroAssetId,
    authorIds: detail.draft.authorIds ?? [],
    termIds: detail.draft.termIds ?? [],
  };
}

/** SEO as the server accepts it: no empty texts or lists. */
export function cleanSeo(seo: Seo): Seo {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seo)) {
    if (typeof value === "string") {
      if (value.trim()) out[key] = value.trim();
    } else if (Array.isArray(value)) {
      if (value.length) out[key] = value;
    } else if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Seo;
}

/** What a changed form field sends; null when it is not ready to save yet. */
export function draftPatch<K extends keyof DraftForm>(
  key: K,
  value: DraftForm[K],
): Record<string, unknown> | null {
  switch (key) {
    case "slug":
      return SLUG.test(value as string) ? { slug: value } : null;
    case "seo":
      return { seo: cleanSeo(value as Seo) };
    case "title":
    case "excerpt":
      return { [key]: (value as string).trim() };
    default:
      return { [key]: value };
  }
}

export const initialDoc = (detail: EntryDetail): OrbitDoc =>
  isOrbitDoc(detail.draft.body) ? (detail.draft.body as OrbitDoc) : emptyDoc();

function SaveIndicator({ state, t }: { state: SaveState; t: EditorText }) {
  const tone =
    state === "saved"
      ? "success"
      : state === "saving" || state === "dirty"
        ? "neutral"
        : "danger";
  return (
    <span aria-live="polite">
      <Badge tone={tone}>{t.save[state]}</Badge>
    </span>
  );
}

type Tab = "publish" | "seo" | "social" | "taxonomy" | "translations";

function EditorBody({
  initial,
  sites,
  status,
  reload,
  tab,
  setTab,
}: {
  initial: EntryDetail;
  sites: SiteList["items"];
  status: CmsStatus | null;
  reload: () => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
}) {
  const { project, locale, canEdit } = useWorkspace();
  const text = cmsText(locale);
  const t = text.editor;
  const base = cmsPath(project.id, `/entries/${initial.entry.id}`);
  const [detail, setDetail] = useState(initial);
  const editable = canEdit && !detail.entry.archivedAt;
  const startDoc = useMemo(() => initialDoc(initial), [initial]);
  const startJson = useMemo(() => toTiptap(startDoc), [startDoc]);
  const [form, setForm] = useState<DraftForm>(() => formOf(initial));
  const [doc, setDoc] = useState<OrbitDoc>(startDoc);
  const [changes, setChanges] = useState<TiptapChange[]>([]);
  const [paste, setPaste] = useState<PasteNotice | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Autosave: changed fields collect in `pending` and go out together.
  const pending = useRef<Record<string, unknown>>({});
  const version = useRef(initial.draft.version);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<boolean> | null>(null);
  const conflict = useRef(false);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    if (conflict.current) return false;
    const body = pending.current;
    if (!Object.keys(body).length) return true;
    pending.current = {};
    setSave("saving");
    setSaveError(null);
    const run = (async () => {
      try {
        const next = await patch<EntryDetail>(`${base}/draft`, {
          version: version.current,
          ...body,
        });
        version.current = next.draft.version;
        setDetail(next);
        setSave(Object.keys(pending.current).length ? "dirty" : "saved");
        return true;
      } catch (e) {
        // Keep the changes; newer edits win over the failed ones.
        pending.current = { ...body, ...pending.current };
        const code = e instanceof ApiError ? e.code : "REQUEST_FAILED";
        if (code === "CMS_DRAFT_STALE") {
          conflict.current = true;
          setSave("conflict");
        } else {
          setSave("error");
          setSaveError(code);
        }
        return false;
      }
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      inflight.current = null;
    }
  }, [base]);

  const queue = useCallback(
    (patchBody: Record<string, unknown>) => {
      if (!editable || conflict.current) return;
      Object.assign(pending.current, patchBody);
      setSave("dirty");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [editable, flush],
  );

  // Unsaved work: warn before the page unloads; save when the editor closes.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length || inflight.current)
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (Object.keys(pending.current).length) void flush();
    };
  }, [flush]);

  const setField: SetField = useCallback(
    (key, value) => {
      setForm((current) => ({ ...current, [key]: value }));
      const body = draftPatch(key, value);
      if (body) queue(body);
    },
    [queue],
  );

  const onBody = useCallback(
    (json: TiptapNode) => {
      const mapped = fromTiptap(json);
      setChanges(mapped.changes);
      const result = validateOrbitDoc(mapped.doc);
      if (!result.valid) {
        setProblems([...new Set(result.problems.map((p) => p.code))]);
        setSave("invalid");
        return;
      }
      setProblems([]);
      setDoc(mapped.doc);
      queue({ body: mapped.doc });
    },
    [queue],
  );

  // Images: the canvas renders previews from this cache (never stored).
  const [assets, setAssets] = useState<Record<string, CmsAsset>>({});
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const remember = (asset: CmsAsset) => {
    assetsRef.current = { ...assetsRef.current, [asset.id]: asset };
    setAssets(assetsRef.current);
  };
  const srcOf = useCallback(
    (id: string) => {
      const asset = assetsRef.current[id];
      return asset ? assetSrc(project.id, asset) : null;
    },
    [project.id],
  );
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const ids = [
      ...new Set([
        ...referencedAssetIds(startDoc),
        ...(initial.draft.heroAssetId ? [initial.draft.heroAssetId] : []),
        ...(typeof initial.draft.seo?.ogImageAssetId === "string"
          ? [initial.draft.seo.ogImageAssetId]
          : []),
      ]),
    ];
    let live = true;
    void Promise.allSettled(
      ids.map((id) => api<CmsAsset>(cmsPath(project.id, `/assets/${id}`))),
    ).then((results) => {
      if (!live) return;
      const found: Record<string, CmsAsset> = {};
      for (const r of results)
        if (r.status === "fulfilled") found[r.value.id] = r.value;
      assetsRef.current = { ...assetsRef.current, ...found };
      setAssets(assetsRef.current);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [initial, project.id, startDoc]);

  const [picker, setPicker] = useState<
    ((asset: CmsAsset | null) => void) | null
  >(null);
  const pick = useCallback(
    () =>
      new Promise<CmsAsset | null>((resolve) => {
        setPicker(() => (asset: CmsAsset | null) => {
          if (asset) remember(asset);
          setPicker(null);
          resolve(asset);
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const pickImage = useCallback(async () => (await pick())?.id ?? null, [pick]);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "publish", label: t.tabs.publish },
    { key: "seo", label: t.tabs.seo },
    { key: "social", label: t.tabs.social },
    { key: "taxonomy", label: t.tabs.taxonomy },
    { key: "translations", label: t.tabs.translations },
  ];

  return (
    <div className="cms-editor-page">
      <PageHead
        title={form.title || text.entries.untitled}
        description={`${detail.entry.locale} · ${text.status[detail.entry.status]}`}
      >
        {editable && <SaveIndicator state={save} t={t} />}
        <a className="button button-outline" href="?">
          {text.entries.back}
        </a>
      </PageHead>
      {!canEdit && <Alert kind="info">{t.readOnly}</Alert>}
      {detail.entry.archivedAt && <Alert kind="info">{t.archived}</Alert>}
      {save === "conflict" && (
        <Alert kind="warning">
          {t.conflictBody}{" "}
          <Button size="sm" variant="outline" onClick={reload}>
            {t.reload}
          </Button>
        </Alert>
      )}
      {save === "error" && (
        <Alert kind="error">
          {errorText(t, saveError)}{" "}
          <Button size="sm" variant="outline" onClick={() => void flush()}>
            {t.retry}
          </Button>
        </Alert>
      )}
      {problems.length > 0 && (
        <Alert kind="error">
          {t.invalid} {problems.join(", ")}
        </Alert>
      )}
      {changes.length > 0 && (
        <Alert kind="warning">
          {t.removed}{" "}
          {[...new Set(changes.map((c) => t.changes[c.code] ?? c.code))].join(
            "; ",
          )}
          .
        </Alert>
      )}
      {paste && (
        <Alert kind="info">
          {t.removedPaste(paste.images, paste.links)}{" "}
          <Button size="sm" variant="ghost" onClick={() => setPaste(null)}>
            OK
          </Button>
        </Alert>
      )}
      <div className="cms-editor">
        <div className="cms-editor-main">
          <input
            className="cms-title-input"
            aria-label={text.entries.titleLabel}
            placeholder={t.titlePlaceholder}
            value={form.title}
            maxLength={200}
            readOnly={!editable}
            onChange={(e) => setField("title", e.target.value)}
          />
          <Field>
            <FieldLabel htmlFor="cms-excerpt">{t.excerptLabel}</FieldLabel>
            <Textarea
              id="cms-excerpt"
              rows={2}
              value={form.excerpt}
              maxLength={500}
              readOnly={!editable}
              onChange={(e) => setField("excerpt", e.target.value)}
            />
            <span className="field-hint">{t.excerptHint}</span>
          </Field>
          {ready ? (
            <Canvas
              initial={startJson}
              editable={editable}
              t={t}
              srcOf={srcOf}
              onChange={onBody}
              onPaste={setPaste}
              pickImage={pickImage}
            />
          ) : (
            <div className="cms-canvas cms-canvas-loading" />
          )}
        </div>
        <aside className="cms-editor-side" aria-label={t.tabs.publish}>
          <Tabs
            tabs={tabs}
            value={tab}
            onChange={(key) => setTab(key as Tab)}
          />
          <div role="tabpanel">
            {tab === "publish" && (
              <PublishPanel
                detail={detail}
                setDetail={setDetail}
                sites={sites}
                settings={status?.settings ?? null}
                editable={editable}
                flush={flush}
                draftVersion={() => version.current}
                base={base}
              />
            )}
            {tab === "seo" && (
              <SeoPanel
                form={form}
                setField={setField}
                doc={doc}
                detail={detail}
                sites={sites}
                editable={editable}
              />
            )}
            {tab === "social" && (
              <SocialPanel
                form={form}
                setField={setField}
                editable={editable}
                assets={assets}
                pick={pick}
              />
            )}
            {tab === "taxonomy" && (
              <TaxonomyPanel
                form={form}
                setField={setField}
                entryLocale={detail.entry.locale}
                editable={editable}
              />
            )}
            {tab === "translations" && (
              <TranslationsPanel
                detail={detail}
                sites={sites}
                editable={editable}
                base={base}
              />
            )}
          </div>
        </aside>
      </div>
      {picker && (
        <MediaPicker
          entryLocale={detail.entry.locale}
          onPick={(asset) => picker(asset)}
          onClose={() => picker(null)}
        />
      )}
    </div>
  );
}

export function EntryEditor({ entryId }: { entryId: string }) {
  const { project } = useWorkspace();
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<Tab>("publish");
  const detail = useResource<EntryDetail>(
    cmsPath(project.id, `/entries/${entryId}`),
  );
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const status = useResource<CmsStatus>(cmsPath(project.id, "/status"));
  const reload = () => {
    setGeneration((g) => g + 1);
    detail.refresh();
  };
  if (detail.error)
    return <ResourceError error={detail.error} retry={detail.refresh} />;
  if (sites.error)
    return <ResourceError error={sites.error} retry={sites.refresh} />;
  if (!detail.data || !sites.data) return <Loading />;
  return (
    <EditorBody
      key={`${entryId}:${generation}`}
      initial={detail.data}
      sites={sites.data.items}
      status={status.data}
      reload={reload}
      tab={tab}
      setTab={setTab}
    />
  );
}
