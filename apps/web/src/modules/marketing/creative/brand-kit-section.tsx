"use client";
import { useContext, useState } from "react";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { api, collectionPath, useMutation, useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import {
  useCreativeOptions,
  type CreativeOptions,
  type FormatId,
  type LogoPlacement,
} from "./creative-api";

// The brand kit of the Creative Studio (Settings -> Brand): logo variants,
// product images, imagery, typography, templates, channel formats and QA
// settings. All of it lives in the profile's `visualIdentity`, which the
// existing Brand form also saves; both merge into the stored value, never
// rebuild it, so neither drops what it does not show.

type Pair = readonly [string, string];
type Identity = Record<string, any>;
export type LogoRole = "secondary" | "onDark" | "onLight" | "mark";
const LOGO_ROLES: LogoRole[] = ["secondary", "onDark", "onLight", "mark"];
const FORMATS: FormatId[] = ["feed_portrait", "square", "story", "landscape"];
const PLACEMENTS: LogoPlacement[] = [
  "auto",
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
];
const IMAGERY_KINDS = ["photo", "illustration", "3d", "flat", "mixed"];
const PRODUCT_TYPES = ["screenshot", "product", "photo"];
const RASTER = ["image/png", "image/jpeg", "image/webp"];

export const VISION_REVIEW_HINT =
  "Sends the finished image to the configured model; billed per check";

const T = {
  title: ["Creative brand kit", "Marken-Kit für Creatives"],
  intro: [
    "Logos, product images, imagery and layout choices Orbit uses to compose images. Colours, fonts and the primary logo are set in the form below.",
    "Logos, Produktbilder, Bildsprache und Layout-Vorgaben, mit denen Orbit Bilder zusammensetzt. Farben, Schriften und das Hauptlogo stellen Sie im Formular darunter ein.",
  ],
  logos: ["Logo variants", "Logo-Varianten"],
  secondary: ["Secondary logo", "Zweites Logo"],
  onDark: ["Logo on dark backgrounds", "Logo auf dunklem Grund"],
  onLight: ["Logo on light backgrounds", "Logo auf hellem Grund"],
  mark: ["Logo mark", "Bildmarke"],
  none: ["None", "Keines"],
  unusable: ["unusable", "nicht nutzbar"],
  products: ["Product images", "Produktbilder"],
  productsHint: [
    "Approved screenshots, product images and photos.",
    "Freigegebene Screenshots, Produktbilder und Fotos.",
  ],
  imagery: ["Imagery", "Bildsprache"],
  imageryKind: ["Kind", "Art"],
  mood: ["Mood", "Stimmung"],
  subjects: ["Subjects", "Motive"],
  avoid: ["Avoid (one per line)", "Vermeiden (eine je Zeile)"],
  typography: ["Typography", "Typografie"],
  headingWeight: ["Heading weight", "Schriftstärke Überschrift"],
  headingCase: ["Heading case", "Schreibweise Überschrift"],
  caseNone: ["As written", "Wie geschrieben"],
  caseUpper: ["Upper case", "Großbuchstaben"],
  templates: ["Templates", "Vorlagen"],
  enabled: ["Enabled", "Aktiv"],
  defaultVariant: ["Default variant", "Standardvariante"],
  auto: ["Automatic", "Automatisch"],
  formats: ["Formats per channel", "Formate je Kanal"],
  formatsHint: [
    "Channels without a change use the defaults.",
    "Kanäle ohne Änderung nutzen die Standardwerte.",
  ],
  placement: ["Logo placement", "Logo-Platzierung"],
  cta: ["Button style", "Button-Stil"],
  corrections: ["Art corrections", "Korrekturen am Bild"],
  automatic: [
    "Automatic creatives for this project",
    "Automatische Creatives für dieses Projekt",
  ],
  automaticHint: [
    "When on, social drafts are written around one core message (copy craft), assignments with a creative get art planned and composed per post, and content package images are composed per draft. Off, Orbit writes and illustrates posts as before; the manual studio works either way.",
    "Wenn aktiv, werden Social-Entwürfe um eine Kernbotschaft geschrieben (Copy Craft), Aufträge mit Creative bekommen je Beitrag geplante und zusammengesetzte Bilder, und Bilder von Content-Paketen werden je Entwurf zusammengesetzt. Aus: Orbit schreibt und bebildert Beiträge wie bisher; das manuelle Studio funktioniert in beiden Fällen.",
  ],
  review: ["Vision review", "Bildprüfung durch das Modell"],
  reviewHint: [
    VISION_REVIEW_HINT,
    "Sendet das fertige Bild an das konfigurierte Modell; wird je Prüfung berechnet",
  ],
  brokenTitle: [
    "Some saved references cannot be used",
    "Einige gespeicherte Verweise sind nicht nutzbar",
  ],
  brokenHint: [
    "They are no longer approved assets, so the profile cannot be saved with them. Remove them here.",
    "Sie sind keine freigegebenen Assets mehr, daher lässt sich das Profil damit nicht speichern. Entfernen Sie sie hier.",
  ],
  remove: ["Remove", "Entfernen"],
  save: ["Save brand kit", "Marken-Kit speichern"],
  saved: ["Brand kit saved.", "Marken-Kit gespeichert."],
  ownersOnly: [
    "Only an owner can change the brand kit.",
    "Nur ein Owner kann das Marken-Kit ändern.",
  ],
  conflict: [
    "The profile changed meanwhile. Reload and try again.",
    "Das Profil wurde inzwischen geändert. Laden Sie neu und versuchen Sie es erneut.",
  ],
  noProfile: [
    "Save the Marketing profile first; the brand kit is part of it.",
    "Speichern Sie zuerst das Marketing-Profil; das Marken-Kit gehört dazu.",
  ],
  loading: ["Loading brand kit…", "Marken-Kit wird geladen…"],
  stale: [
    "The profile was changed elsewhere after you started editing. Reload to continue from the current version; your edits here are discarded.",
    "Das Profil wurde nach Beginn Ihrer Bearbeitung anderswo geändert. Laden Sie neu, um mit der aktuellen Version weiterzumachen; Ihre Änderungen hier gehen verloren.",
  ],
  reload: ["Reload", "Neu laden"],
  loadFailed: [
    "The brand kit could not be loaded:",
    "Das Marken-Kit konnte nicht geladen werden:",
  ],
  retry: ["Try again", "Erneut versuchen"],
} satisfies Record<string, Pair>;
const t = (key: keyof typeof T, de: boolean) => T[key][de ? 1 : 0];
const words = (id: string) => id.replaceAll("_", " ");

/** The asset fields the editor needs. */
export type KitAsset = {
  id: string;
  name: string;
  type: string;
  approved: boolean;
  raster: boolean;
  hasHash: boolean;
};

export function toKitAsset(item: {
  id: string;
  data: Record<string, unknown>;
}): KitAsset {
  const d = item.data;
  return {
    id: item.id,
    name: String(d.name ?? d.filename ?? item.id),
    type: String(d.type ?? ""),
    approved: d.usageApproved === true && d.assetStatus === "approved",
    raster: RASTER.includes(String(d.mime ?? "")),
    hasHash: typeof d.sha256 === "string" && d.sha256 !== "",
  };
}

export const usableLogo = (a: KitAsset) =>
  a.type === "logo" && a.approved && a.raster && a.hasHash;
export const usableProduct = (a: KitAsset) =>
  PRODUCT_TYPES.includes(a.type) && a.approved && a.raster;

/** What the editor edits; everything else of the identity is kept as it is. */
export type KitDraft = {
  logos: Partial<Record<LogoRole, string>>;
  productAssetIds: string[];
  imagery: {
    kind: string;
    mood: string;
    subjects: string;
    avoid: string;
  } | null;
  typography: { headingWeight: number; headingCase: string } | null;
  templates: Record<string, { enabled: boolean; variant?: string }>;
  formatsByChannel: Record<string, FormatId[]>;
  logoPlacement: LogoPlacement | "";
  ctaStyle: string;
  maxArtCorrections: number | null;
  visualReview: boolean | null;
  /** The project's opt-in to automatic creatives (`creative.enabled`, R65). */
  automatic: boolean;
};

/** The editor's starting values from the stored identity. */
export function draftOf(identity: Identity | undefined): KitDraft {
  const v = identity ?? {};
  const creative = v.creative ?? {};
  return {
    logos: { ...(v.logos ?? {}) },
    productAssetIds: [...(v.productAssetIds ?? [])],
    imagery: v.imagery
      ? {
          kind: v.imagery.kind,
          mood: v.imagery.mood ?? "",
          subjects: v.imagery.subjects ?? "",
          avoid: (v.imagery.avoid ?? []).join("\n"),
        }
      : null,
    typography: v.typography ? { ...v.typography } : null,
    templates: { ...(creative.templates ?? {}) },
    formatsByChannel: { ...(creative.formatsByChannel ?? {}) },
    logoPlacement: creative.logoPlacement ?? "",
    ctaStyle: creative.ctaStyle ?? "",
    maxArtCorrections: creative.maxArtCorrections ?? null,
    visualReview:
      typeof creative.visualReview === "boolean" ? creative.visualReview : null,
    automatic: creative.enabled === true,
  };
}

/**
 * The identity to save: the stored one with the brand kit fields replaced by
 * the draft. Colours, fonts, design rules, the primary logo and every field
 * the editor does not know stay as stored. `imagery` is sent whole (MCP and
 * the API replace it as a whole).
 */
export function mergeBrandKit(identity: Identity, draft: KitDraft): Identity {
  const { logos, productAssetIds, imagery, typography, creative, ...rest } =
    identity;
  void logos;
  void productAssetIds;
  void imagery;
  void typography;
  const out: Identity = { ...rest };
  const keptLogos = Object.fromEntries(
    Object.entries(draft.logos).filter(([, id]) => id),
  );
  if (Object.keys(keptLogos).length) out.logos = keptLogos;
  if (draft.productAssetIds.length)
    out.productAssetIds = [...new Set(draft.productAssetIds)];
  if (draft.imagery)
    out.imagery = {
      kind: draft.imagery.kind,
      mood: draft.imagery.mood,
      subjects: draft.imagery.subjects,
      avoid: draft.imagery.avoid
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  if (draft.typography) out.typography = { ...draft.typography };
  const next: Identity = { ...(creative ?? {}) };
  const set = (key: string, value: unknown, keep: boolean) => {
    if (keep) next[key] = value;
    else delete next[key];
  };
  set("templates", draft.templates, Object.keys(draft.templates).length > 0);
  set(
    "formatsByChannel",
    draft.formatsByChannel,
    Object.keys(draft.formatsByChannel).length > 0,
  );
  set("logoPlacement", draft.logoPlacement, draft.logoPlacement !== "");
  set("ctaStyle", draft.ctaStyle, draft.ctaStyle !== "");
  set(
    "maxArtCorrections",
    draft.maxArtCorrections,
    draft.maxArtCorrections !== null,
  );
  set("visualReview", draft.visualReview, draft.visualReview !== null);
  // Off is the absent field (R65).
  set("enabled", true, draft.automatic);
  if (Object.keys(next).length) out.creative = next;
  return out;
}

/** Profile fields a save sends besides the identity (what the form sends). */
const PROFILE_KEYS = [
  "productName",
  "contentLanguage",
  "internalLanguage",
  "audience",
  "positioning",
  "campaignTypes",
  "productStrategy",
  "presaleStrategy",
  "voice",
  "guardrails",
  "primaryCtas",
  "channelPriority",
  "brandTerms",
  "notificationPreference",
  "officialLinks",
] as const;

/** The `PUT /marketing-profile` body: the stored profile with the merged identity. */
export function brandKitSaveBody(
  profile: Record<string, any>,
  version: number,
  draft: KitDraft,
) {
  const body: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS)
    if (profile[key] !== undefined) body[key] = profile[key];
  return {
    ...body,
    visualIdentity: mergeBrandKit(profile.visualIdentity ?? {}, draft),
    assetPolicy: "approved_only",
    expectedVersion: version,
  };
}

export type BrokenReference = {
  kind: "logo" | "product";
  role?: LogoRole;
  assetId: string;
};

/**
 * Stored references that no longer pass the server's checks (each one fails
 * every profile save with APPROVED_*_ASSET_REQUIRED), so the owner can drop them.
 */
export function brokenReferences(
  draft: KitDraft,
  assets: KitAsset[],
): BrokenReference[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: BrokenReference[] = [];
  for (const role of LOGO_ROLES) {
    const id = draft.logos[role];
    if (id && !(byId.get(id) && usableLogo(byId.get(id)!)))
      out.push({ kind: "logo", role, assetId: id });
  }
  for (const id of draft.productAssetIds)
    if (!(byId.get(id) && usableProduct(byId.get(id)!)))
      out.push({ kind: "product", assetId: id });
  return out;
}

/** Variants a template can use in any format. */
export const templateVariants = (
  options: CreativeOptions,
  template: string,
): string[] => [
  ...new Set(
    Object.values(
      options.templates.find((o) => o.id === template)?.variants ?? {},
    ).flat(),
  ),
];

const isDefaultFormats = (a: FormatId[], b: FormatId[] | undefined) =>
  !!b && a.length === b.length && a.every((f) => b.includes(f));

function Select({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="field creative-field">
      <span className="field-label">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

/** The editor itself; the container below loads data and saves. */
export function BrandKitView({
  de,
  isOwner,
  draft,
  onChange,
  assets,
  options,
  pending,
  error,
  saved,
  onSave,
  stale = false,
  onReload,
}: {
  de: boolean;
  isOwner: boolean;
  draft: KitDraft;
  onChange: (draft: KitDraft) => void;
  assets: KitAsset[];
  options: CreativeOptions;
  pending: boolean;
  error: string | null;
  saved: boolean;
  onSave: () => void;
  /** The profile changed since the edit started (see `isStale`). */
  stale?: boolean;
  onReload?: () => void;
}) {
  const ro = !isOwner || pending;
  const logos = assets.filter(usableLogo);
  const products = assets.filter(usableProduct);
  const broken = brokenReferences(draft, assets);
  const imagery = draft.imagery ?? {
    kind: "photo",
    mood: "",
    subjects: "",
    avoid: "",
  };
  const channels = [
    ...new Set([
      ...Object.keys(options.defaultChannelFormats),
      ...Object.keys(draft.formatsByChannel),
    ]),
  ];
  const formatsOf = (channel: string): FormatId[] =>
    draft.formatsByChannel[channel] ??
    options.defaultChannelFormats[channel] ??
    [];
  const labelOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const dropBroken = (b: BrokenReference) =>
    onChange(
      b.kind === "logo"
        ? { ...draft, logos: { ...draft.logos, [b.role!]: undefined } }
        : {
            ...draft,
            productAssetIds: draft.productAssetIds.filter(
              (id) => id !== b.assetId,
            ),
          },
    );
  return (
    <section className="panel brand-kit">
      <div className="panel-head">
        <div>
          <h2>{t("title", de)}</h2>
          <p>{t("intro", de)}</p>
        </div>
      </div>
      {!isOwner && <Alert>{t("ownersOnly", de)}</Alert>}
      <label className="field-check">
        <input
          type="checkbox"
          disabled={ro}
          checked={draft.automatic}
          onChange={(e) => onChange({ ...draft, automatic: e.target.checked })}
        />{" "}
        {t("automatic", de)}
      </label>
      <p className="panel-note">{t("automaticHint", de)}</p>
      {stale && (
        <Alert kind="warning">
          {t("stale", de)}{" "}
          <Button size="sm" variant="outline" onClick={onReload}>
            {t("reload", de)}
          </Button>
        </Alert>
      )}
      {broken.length > 0 && (
        <Alert kind="warning">
          <strong>{t("brokenTitle", de)}</strong> {t("brokenHint", de)}
          <ul>
            {broken.map((b) => (
              <li key={`${b.kind}-${b.role ?? ""}-${b.assetId}`}>
                {b.kind === "logo" ? t(b.role!, de) : t("products", de)}:{" "}
                <code>{b.assetId}</code> ({t("unusable", de)}){" "}
                {isOwner && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => dropBroken(b)}
                  >
                    {t("remove", de)}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <h3>{t("logos", de)}</h3>
      {LOGO_ROLES.map((role) => {
        const current = draft.logos[role] ?? "";
        const stale = current && !logos.some((a) => a.id === current);
        return (
          <Select
            key={role}
            label={t(role, de)}
            value={current}
            disabled={ro}
            onChange={(value) =>
              onChange({
                ...draft,
                logos: { ...draft.logos, [role]: value || undefined },
              })
            }
          >
            <option value="">{t("none", de)}</option>
            {stale && (
              <option value={current}>
                {labelOf(current)} ({t("unusable", de)})
              </option>
            )}
            {logos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        );
      })}
      <h3>{t("products", de)}</h3>
      <p className="panel-note">{t("productsHint", de)}</p>
      {[
        ...products,
        ...draft.productAssetIds
          .filter((id) => !products.some((a) => a.id === id))
          .map((id) => ({ id, name: labelOf(id) })),
      ].map((a) => (
        <label key={a.id} className="field-check">
          <input
            type="checkbox"
            disabled={ro}
            checked={draft.productAssetIds.includes(a.id)}
            onChange={(e) =>
              onChange({
                ...draft,
                productAssetIds: e.target.checked
                  ? [...draft.productAssetIds, a.id]
                  : draft.productAssetIds.filter((id) => id !== a.id),
              })
            }
          />{" "}
          {a.name}
        </label>
      ))}
      <h3>{t("imagery", de)}</h3>
      <Select
        label={t("imageryKind", de)}
        value={imagery.kind}
        disabled={ro}
        onChange={(kind) =>
          onChange({ ...draft, imagery: { ...imagery, kind } })
        }
      >
        {IMAGERY_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </Select>
      {(
        [
          ["mood", "mood", 300],
          ["subjects", "subjects", 500],
        ] as const
      ).map(([key, name, max]) => (
        <label key={key} className="field creative-field">
          <span className="field-label">{t(name, de)}</span>
          <input
            className="input"
            maxLength={max}
            disabled={ro}
            value={imagery[key]}
            onChange={(e) =>
              onChange({
                ...draft,
                imagery: { ...imagery, [key]: e.target.value },
              })
            }
          />
        </label>
      ))}
      <label className="field creative-field">
        <span className="field-label">{t("avoid", de)}</span>
        <textarea
          className="input textarea"
          disabled={ro}
          value={imagery.avoid}
          onChange={(e) =>
            onChange({
              ...draft,
              imagery: { ...imagery, avoid: e.target.value },
            })
          }
        />
      </label>
      <h3>{t("typography", de)}</h3>
      <Select
        label={t("headingWeight", de)}
        value={draft.typography?.headingWeight ?? 700}
        disabled={ro}
        onChange={(w) =>
          onChange({
            ...draft,
            typography: {
              headingCase: draft.typography?.headingCase ?? "none",
              headingWeight: Number(w),
            },
          })
        }
      >
        {[600, 700, 800].map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </Select>
      <Select
        label={t("headingCase", de)}
        value={draft.typography?.headingCase ?? "none"}
        disabled={ro}
        onChange={(headingCase) =>
          onChange({
            ...draft,
            typography: {
              headingWeight: draft.typography?.headingWeight ?? 700,
              headingCase,
            },
          })
        }
      >
        <option value="none">{t("caseNone", de)}</option>
        <option value="upper">{t("caseUpper", de)}</option>
      </Select>
      <h3>{t("templates", de)}</h3>
      {options.templates.map((offer) => {
        const enabled =
          draft.templates[offer.id]?.enabled ??
          options.config?.enabledTemplates?.includes(offer.id) ??
          true;
        const variant = draft.templates[offer.id]?.variant ?? "";
        return (
          <div key={offer.id} className="brand-kit-template">
            <label className="field-check">
              <input
                type="checkbox"
                disabled={ro}
                checked={enabled}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    templates: {
                      ...draft.templates,
                      [offer.id]: {
                        ...draft.templates[offer.id],
                        enabled: e.target.checked,
                      },
                    },
                  })
                }
              />{" "}
              {words(offer.id)}
            </label>
            <Select
              label={`${words(offer.id)}: ${t("defaultVariant", de)}`}
              value={variant}
              disabled={ro || !enabled}
              onChange={(value) =>
                onChange({
                  ...draft,
                  templates: {
                    ...draft.templates,
                    [offer.id]: {
                      enabled,
                      ...(value ? { variant: value } : {}),
                    },
                  },
                })
              }
            >
              <option value="">{t("auto", de)}</option>
              {templateVariants(options, offer.id).map((v) => (
                <option key={v} value={v}>
                  {words(v)}
                </option>
              ))}
            </Select>
          </div>
        );
      })}
      <h3>{t("formats", de)}</h3>
      <p className="panel-note">{t("formatsHint", de)}</p>
      {channels.map((channel) => (
        <fieldset key={channel} className="field creative-field">
          <legend className="field-label">{channel}</legend>
          {FORMATS.map((format) => (
            <label key={format} className="field-check">
              <input
                type="checkbox"
                disabled={ro}
                checked={formatsOf(channel).includes(format)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...formatsOf(channel), format]
                    : formatsOf(channel).filter((f) => f !== format);
                  if (!next.length) return;
                  const formatsByChannel = { ...draft.formatsByChannel };
                  if (
                    isDefaultFormats(
                      next,
                      options.defaultChannelFormats[channel],
                    )
                  )
                    delete formatsByChannel[channel];
                  else formatsByChannel[channel] = next;
                  onChange({ ...draft, formatsByChannel });
                }}
              />{" "}
              {words(format)}
            </label>
          ))}
        </fieldset>
      ))}
      <Select
        label={t("placement", de)}
        value={draft.logoPlacement}
        disabled={ro}
        onChange={(v) =>
          onChange({ ...draft, logoPlacement: v as LogoPlacement })
        }
      >
        <option value="">{t("auto", de)}</option>
        {PLACEMENTS.map((p) => (
          <option key={p} value={p}>
            {words(p)}
          </option>
        ))}
      </Select>
      <Select
        label={t("cta", de)}
        value={draft.ctaStyle}
        disabled={ro}
        onChange={(ctaStyle) => onChange({ ...draft, ctaStyle })}
      >
        <option value="">{t("auto", de)}</option>
        {["pill", "outline", "none"].map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <Select
        label={t("corrections", de)}
        value={draft.maxArtCorrections ?? 1}
        disabled={ro}
        onChange={(v) => onChange({ ...draft, maxArtCorrections: Number(v) })}
      >
        {[0, 1, 2].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      <label className="field-check">
        <input
          type="checkbox"
          disabled={ro}
          checked={draft.visualReview === true}
          onChange={(e) =>
            onChange({ ...draft, visualReview: e.target.checked })
          }
        />{" "}
        {t("review", de)}
      </label>
      <p className="panel-note">{t("reviewHint", de)}</p>
      {error && <Alert kind="error">{error}</Alert>}
      {saved && !error && <Alert kind="success">{t("saved", de)}</Alert>}
      {isOwner && (
        <div className="form-actions">
          <Button disabled={pending || stale} onClick={onSave}>
            {t("save", de)}
          </Button>
        </div>
      )}
    </section>
  );
}

/** An edit in progress: the profile version and data it started from, and the kit being edited. */
export type KitEdit = {
  baseVersion: number;
  baseData: Record<string, any>;
  kit: KitDraft;
};

type Load = { loading: boolean; error: unknown; hasData: boolean };
export type LoadGate =
  | { kind: "loading" }
  | { kind: "error"; failed: Array<"profile" | "options" | "assets"> }
  | { kind: "no-profile" }
  | { kind: "ready" };

/**
 * What the container may render: a failed load is an error state, never a
 * missing profile or broken references (the editor shows only complete data).
 */
export function loadGate(loads: {
  profile: Load;
  options: Load;
  assets: Load;
}): LoadGate {
  const failed = (["profile", "options", "assets"] as const).filter(
    (key) => loads[key].error,
  );
  if (failed.length) return { kind: "error", failed };
  if (Object.values(loads).some((l) => l.loading)) return { kind: "loading" };
  if (!loads.profile.hasData) return { kind: "no-profile" };
  if (!loads.options.hasData || !loads.assets.hasData)
    return { kind: "error", failed: [] };
  return { kind: "ready" };
}

/** Starts an edit from the stored profile. */
export const startEdit = (stored: {
  version: number;
  data: Record<string, any>;
}): KitEdit => ({
  baseVersion: stored.version,
  baseData: stored.data,
  kit: draftOf(stored.data.visualIdentity),
});

/** Whether the stored profile moved on since the edit started. */
export const isStale = (storedVersion: number, edit: KitEdit | null) =>
  edit !== null && storedVersion !== edit.baseVersion;

/** The save body: merged onto the version the edit started from, so a newer one is refused. */
export const editSaveBody = (edit: KitEdit) =>
  brandKitSaveBody(edit.baseData, edit.baseVersion, edit.kit);

/** The text of a failed save. */
export function saveErrorText(error: string | null, de: boolean) {
  return error === "MARKETING_PROFILE_VERSION_CONFLICT"
    ? t("stale", de)
    : error;
}

/**
 * Settings -> Brand: the brand kit editor. Renders nothing while the
 * Creative Studio is off; saves the whole profile with the merged identity.
 */
export function BrandKitSection() {
  const shell = useContext(ShellContext);
  if (shell?.features?.creativeStudio !== true) return null;
  return <BrandKitLoaded />;
}

function BrandKitLoaded() {
  const { project, isOwner, refresh, locale } = useWorkspace();
  const de = locale === "de";
  const profile = useResource<{
    version: number;
    data: Record<string, any>;
  } | null>(`/projects/${project.id}/marketing-profile`);
  const options = useCreativeOptions(project.id);
  const assets = useResource<{
    items: Array<{ id: string; data: Record<string, unknown> }>;
  }>(collectionPath(project.id, "assets"));
  const [edit, setEdit] = useState<KitEdit | null>(null);
  const mutation = useMutation(() => {
    setEdit(null);
    profile.refresh();
    refresh();
    // The profile form below reloads on focus.
    window.dispatchEvent(new Event("focus"));
  });
  const reloadAll = () => {
    profile.refresh();
    options.refresh();
    assets.refresh();
  };
  const gate = loadGate({
    profile: {
      loading: profile.loading,
      error: profile.error,
      hasData: !!profile.data,
    },
    options: {
      loading: options.loading,
      error: options.error,
      hasData: !!options.data,
    },
    assets: {
      loading: assets.loading,
      error: assets.error,
      hasData: !!assets.data,
    },
  });
  // The edit survives a reload in progress; only the view waits.
  if (gate.kind === "loading") return <Loading label={t("loading", de)} />;
  if (gate.kind === "error")
    return (
      <Alert kind="error">
        {t("loadFailed", de)} {gate.failed.join(", ") || "—"}{" "}
        <Button size="sm" variant="outline" onClick={reloadAll}>
          {t("retry", de)}
        </Button>
      </Alert>
    );
  const stored = profile.data;
  if (gate.kind === "no-profile" || !stored)
    return <Alert>{t("noProfile", de)}</Alert>;
  const current = edit ?? startEdit(stored);
  const stale = isStale(stored.version, edit);
  return (
    <BrandKitView
      de={de}
      isOwner={isOwner}
      draft={current.kit}
      onChange={(kit) => setEdit({ ...current, kit })}
      assets={(assets.data?.items ?? []).map(toKitAsset)}
      options={options.data!}
      pending={mutation.pending}
      error={saveErrorText(mutation.error, de)}
      saved={mutation.success}
      stale={stale}
      onReload={() => setEdit(null)}
      onSave={() =>
        void mutation.run(() =>
          api(`/projects/${project.id}/marketing-profile`, {
            method: "PUT",
            body: JSON.stringify(editSaveBody(current)),
          }),
        )
      }
    />
  );
}
