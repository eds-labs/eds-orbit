"use client";
import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Input,
  Loading,
  Modal,
  Tabs,
} from "@/components/ui/primitives";
import { collectionPath, useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import {
  creativePost,
  useContentCreative,
  useCreativeAction,
  useCreativeOptions,
  type ArtDirection,
  type CreativeCopy,
  type CreativeOptions,
  type CreativeStatus,
  type CreativeView,
  type FormatId,
  type LogoPlacement,
  type TextScale,
} from "./creative-api";
import { CHECK_LABELS, creativeErrorMessage } from "./creative-copy";

export { creativeErrorMessage } from "./creative-copy";

// The creative of one post (spec §12): the finished renditions next to the
// post text, their components and rights, QA findings, cost and status, and
// the actions each role may take. The server checks every role again.

type CreativeAction = ReturnType<typeof useCreativeAction>;
type Access = "viewer" | "editor" | "owner";
type Pair = readonly [string, string];
type PanelContent = {
  id: string;
  body: string;
  /** The Postiz channel id as stored on the post. */
  channel: string;
  /** The channel's platform identifier (`linkedin`, `x`, …) and display name. */
  channelIdentifier?: string;
  channelName?: string;
  creativeCopy?: CreativeCopy;
};
/** The asset fields the panel needs from the assets collection. */
export type PanelAsset = {
  id: string;
  name: string;
  type: string;
  usageApproved: boolean;
};

const T = {
  title: ["Creative", "Creative"],
  postText: ["Post text", "Beitragstext"],
  channel: ["Channel", "Kanal"],
  formats: ["Formats", "Formate"],
  status: ["Status", "Status"],
  quality: ["Quality", "Qualität"],
  cost: ["Cost", "Kosten"],
  components: ["Components", "Komponenten"],
  checks: ["Checks", "Prüfungen"],
  warnings: ["Warnings", "Hinweise"],
  checksOk: ["All checks passed.", "Alle Prüfungen bestanden."],
  none: ["No creative yet", "Noch kein Creative"],
  noneHint: [
    "Produce a branded image for this post from its image copy.",
    "Erzeugen Sie ein Bild im Markenstil für diesen Beitrag.",
  ],
  loading: ["Loading creative…", "Creative wird geladen…"],
  loadFailed: [
    "The creative could not be loaded.",
    "Das Creative konnte nicht geladen werden.",
  ],
  retry: ["Try again", "Erneut versuchen"],
  noBrandKit: [
    "The brand kit cannot compose yet: add a brand profile with an approved primary logo first.",
    "Das Marken-Kit kann noch nicht gestalten: Hinterlegen Sie zuerst ein Markenprofil mit freigegebenem Hauptlogo.",
  ],
  produce: ["Produce creative", "Creative erzeugen"],
  recompose: ["Recompose", "Neu zusammensetzen"],
  recomposeHint: [
    "Free: same art and products, other layout or text.",
    "Kostenlos: gleiches Bild und Produkte, anderes Layout oder Text.",
  ],
  attach: ["Attach to post", "An Beitrag anhängen"],
  attached: ["Already on the post", "Bereits am Beitrag"],
  attachNeedsRights: [
    "Approve the art's usage rights and recompose before attaching.",
    "Geben Sie die Nutzungsrechte des Bildes frei und setzen Sie neu zusammen, bevor Sie anhängen.",
  ],
  attachNeedsOwner: [
    "An owner has to accept the findings before this can be attached.",
    "Ein Owner muss die Befunde akzeptieren, bevor das angehängt werden kann.",
  ],
  attachNote: [
    "The post goes back to draft and is reviewed again.",
    "Der Beitrag geht zurück in den Entwurf und wird erneut geprüft.",
  ],
  acceptQa: [
    "I accept the QA findings for this creative.",
    "Ich akzeptiere die QA-Befunde für dieses Creative.",
  ],
  regenerate: ["Regenerate art", "Bild neu erzeugen"],
  review: ["Vision review", "Bildprüfung"],
  reviewDone: ["Vision review done", "Bildprüfung durchgeführt"],
  template: ["Template", "Vorlage"],
  variant: ["Variant", "Variante"],
  auto: ["Automatic", "Automatisch"],
  art: ["Art", "Bild"],
  noArt: ["No art", "Kein Bild"],
  product: ["Product image", "Produktbild"],
  noProduct: ["No product image", "Kein Produktbild"],
  logoPlacement: ["Logo placement", "Logo-Position"],
  textSize: ["Text size", "Textgröße"],
  newArt: [
    "Generate new art (paid, owner only)",
    "Neues Bild erzeugen (kostenpflichtig, nur Owner)",
  ],
  eyebrow: ["Eyebrow", "Vorzeile"],
  headline: ["Headline", "Überschrift"],
  subline: ["Subline", "Unterzeile"],
  cta: ["Call to action", "Handlungsaufforderung"],
  rightsOk: ["Rights approved", "Rechte freigegeben"],
  rightsOpen: ["Rights not approved", "Rechte nicht freigegeben"],
  logo: ["Logo", "Logo"],
  products: ["Product", "Produkt"],
  confirmTitle: ["Generate new art?", "Neues Bild erzeugen?"],
  confirmCost: [
    "This pays for one image, at most {cost}.",
    "Das bezahlt ein Bild, höchstens {cost}.",
  ],
  confirmPrompt: [
    "The prompt goes to the image provider.",
    "Der Prompt wird an den Bildanbieter gesendet.",
  ],
  confirmRights: [
    "The new art stays unapproved until an owner approves its usage rights; then recompose.",
    "Das neue Bild bleibt nicht freigegeben, bis ein Owner die Nutzungsrechte bestätigt; danach neu zusammensetzen.",
  ],
  confirmPromptCheck: [
    "I confirm the prompt may be sent to the image provider.",
    "Ich bestätige, dass der Prompt an den Bildanbieter gesendet werden darf.",
  ],
  confirm: ["Generate for up to {cost}", "Erzeugen für höchstens {cost}"],
  cancel: ["Cancel", "Abbrechen"],
  costUnknownMax: [
    "The maximum price is not known; configure image generation first.",
    "Der Höchstpreis ist nicht bekannt; richten Sie zuerst die Bilderzeugung ein.",
  ],
  unclear: ["unclear outcome", "Ausgang unklar"],
  motif: ["Motif", "Motiv"],
  setting: [
    "Setting (place, light, time of day)",
    "Szene (Ort, Licht, Tageszeit)",
  ],
  mood: ["Mood", "Stimmung"],
  artDirectionHint: [
    "Optional: what the picture shows. Without a motif the post's title is used; the image never contains text or logos.",
    "Optional: was das Bild zeigt. Ohne Motiv dient der Titel des Beitrags; das Bild enthält nie Text oder Logos.",
  ],
  artDirectionKeep: [
    "Optional: a new motif for the new art. Without one the current motif is kept.",
    "Optional: ein neues Motiv für das neue Bild. Ohne Angabe bleibt das bisherige Motiv.",
  ],
  motifNeeded: [
    "Enter a motif to go with the setting or mood.",
    "Geben Sie ein Motiv zu Szene oder Stimmung an.",
  ],
  working: ["Working…", "Läuft…"],
} satisfies Record<string, Pair>;

const STATUS: Record<
  CreativeStatus,
  { label: Pair; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  composed: { label: ["Composed", "Zusammengesetzt"], tone: "success" },
  needs_owner: { label: ["Needs owner", "Owner nötig"], tone: "warning" },
  needs_rights: { label: ["Rights needed", "Rechte nötig"], tone: "danger" },
  attached: { label: ["Attached", "Angehängt"], tone: "success" },
  superseded: { label: ["Replaced", "Ersetzt"], tone: "neutral" },
};
const VERDICT: Record<
  CreativeView["qa"]["verdict"],
  { label: Pair; tone: "success" | "warning" }
> = {
  pass: { label: ["Passed", "Bestanden"], tone: "success" },
  corrected: {
    label: ["Corrected automatically", "Automatisch korrigiert"],
    tone: "success",
  },
  needs_owner: {
    label: ["Needs owner review", "Owner-Prüfung nötig"],
    tone: "warning",
  },
};
const FORMAT_LABEL: Record<FormatId, Pair> = {
  feed_portrait: ["Portrait 4:5", "Hochformat 4:5"],
  square: ["Square 1:1", "Quadrat 1:1"],
  story: ["Story 9:16", "Story 9:16"],
  landscape: ["Landscape", "Querformat"],
};
const TEMPLATE_LABEL: Record<string, Pair> = {
  product_showcase: ["Product showcase", "Produktvorstellung"],
  feature_highlight: ["Feature highlight", "Funktions-Highlight"],
  problem_solution: ["Problem and solution", "Problem und Lösung"],
  lifestyle: ["Lifestyle", "Lifestyle"],
  tips: ["Tips", "Tipps"],
  announcement: ["Announcement", "Ankündigung"],
  brand_message: ["Brand message", "Markenbotschaft"],
};
const VARIANT_LABEL: Record<string, Pair> = {
  text_top: ["Text on top", "Text oben"],
  text_bottom: ["Text at the bottom", "Text unten"],
  text_side: ["Text at the side", "Text seitlich"],
  product_left: ["Product left", "Produkt links"],
  product_right: ["Product right", "Produkt rechts"],
  centered: ["Centered", "Zentriert"],
};
const PLACEMENT_LABEL: Record<LogoPlacement, Pair> = {
  auto: ["Automatic", "Automatisch"],
  top_left: ["Top left", "Oben links"],
  top_right: ["Top right", "Oben rechts"],
  bottom_left: ["Bottom left", "Unten links"],
  bottom_right: ["Bottom right", "Unten rechts"],
};
const SCALE_LABEL: Record<TextScale, string> = { s: "S", m: "M", l: "L" };

const ART_TYPES = ["photo", "background", "banner", "generated_artwork"];
const PRODUCT_TYPES = ["screenshot", "product", "photo"];

/** USD with cents; "—" when the amount is not known. */
export function formatUsd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined || !Number.isFinite(micros))
    return "—";
  const usd = micros / 1_000_000;
  // Sub-cent amounts keep their precision (a $0.004 maximum is not "$0.00").
  return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
const word = (pair: Pair, de: boolean) => pair[de ? 1 : 0];
const label = (key: keyof typeof T, de: boolean) => word(T[key], de);
const pick = (map: Record<string, Pair>, key: string, de: boolean) =>
  map[key] ? word(map[key], de) : key.replaceAll("_", " ");

/** `productAssetIds` for a request: only a template that takes products gets one. */
export function productIds(
  offer: { needs: { product: string } } | undefined,
  productId: string,
): { productAssetIds?: string[] } {
  return productId && offer && offer.needs.product !== "none"
    ? { productAssetIds: [productId] }
    : {};
}

/** Formats of a post's channel: project override, default, else square. */
function channelFormats(
  options: CreativeOptions,
  content: PanelContent,
): string[] {
  const key = content.channelIdentifier;
  if (!key) return ["square"];
  return (
    options.config?.formatsByChannel?.[key] ??
    options.defaultChannelFormats[key] ?? ["square"]
  );
}
const channelText = (content: PanelContent) =>
  content.channelName && content.channelIdentifier
    ? `${content.channelName} · ${content.channelIdentifier}`
    : (content.channelName ?? content.channelIdentifier ?? "—");

function Dot({ tone }: { tone: string }) {
  return <span className={`creative-dot creative-dot-${tone}`} aria-hidden />;
}

/** The formats a creative has renditions for, in order. */
function renditionFormats(creative: CreativeView): FormatId[] {
  return [...new Set(creative.renditions.map((r) => r.format))];
}

function Preview({
  creative,
  de,
  initialFormat,
}: {
  creative: CreativeView;
  de: boolean;
  initialFormat?: FormatId;
}) {
  const formats = renditionFormats(creative);
  const [chosen, setChosen] = useState<string>(initialFormat ?? formats[0]);
  const active = formats.includes(chosen as FormatId) ? chosen : formats[0];
  const rendition = creative.renditions.find((r) => r.format === active);
  if (!rendition) return null;
  return (
    <div className="creative-preview">
      <Tabs
        tabs={formats.map((format) => ({
          key: format,
          label: word(FORMAT_LABEL[format] ?? [format, format], de),
        }))}
        value={active}
        onChange={setChosen}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="creative-image"
        src={rendition.href}
        alt={creative.copy.headline}
        width={rendition.width}
        height={rendition.height}
      />
      <p className="creative-meta">
        {rendition.width} × {rendition.height} px
        {rendition.channel ? ` · ${rendition.channel}` : ""}
      </p>
    </div>
  );
}

function Checks({ creative, de }: { creative: CreativeView; de: boolean }) {
  const failed = creative.qa.checks.filter((c) => !c.passed);
  const blockers = failed.filter((c) => c.severity === "blocker");
  const warnings = failed.filter((c) => c.severity === "warning");
  const text = (code: string) => pick(CHECK_LABELS, code, de);
  return (
    <section aria-label={label("checks", de)}>
      <h4>{label("checks", de)}</h4>
      {failed.length === 0 && <p>{label("checksOk", de)}</p>}
      {blockers.length > 0 && (
        <ul className="creative-checks">
          {blockers.map((c, i) => (
            <li key={`${c.code}-${i}`}>
              <Dot tone="danger" />
              {text(c.code)}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <>
          <h5>{label("warnings", de)}</h5>
          <ul className="creative-checks">
            {warnings.map((c, i) => (
              <li key={`${c.code}-${i}`}>
                <Dot tone="warning" />
                {text(c.code)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Components({
  creative,
  assets,
  de,
}: {
  creative: CreativeView;
  assets: PanelAsset[];
  de: boolean;
}) {
  const rows = [
    ...(creative.components.artAssetId
      ? [{ role: label("art", de), id: creative.components.artAssetId }]
      : []),
    { role: label("logo", de), id: creative.components.logo.assetId },
    ...creative.components.products.map((p) => ({
      role: label("products", de),
      id: p.assetId,
    })),
  ];
  return (
    <section aria-label={label("components", de)}>
      <h4>{label("components", de)}</h4>
      <ul className="creative-components">
        {rows.map((row) => {
          const asset = assets.find((a) => a.id === row.id);
          return (
            <li key={`${row.role}-${row.id}`}>
              <span>
                {row.role}: {asset?.name ?? "—"}
              </span>
              {asset ? (
                <Badge tone={asset.usageApproved ? "success" : "warning"}>
                  {label(asset.usageApproved ? "rightsOk" : "rightsOpen", de)}
                </Badge>
              ) : (
                <Badge>—</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The art direction form fields; empty strings are fields left out. */
export type ArtDirectionDraft = {
  motif: string;
  setting: string;
  mood: string;
};
const NO_DIRECTION: ArtDirectionDraft = { motif: "", setting: "", mood: "" };
const DIRECTION_LIMITS = { motif: 400, setting: 300, mood: 160 } as const;

/** A setting or mood without a motif: it cannot be sent alone. */
export const artDirectionIncomplete = (draft: ArtDirectionDraft) =>
  !draft.motif.trim() && Boolean(draft.setting.trim() || draft.mood.trim());

/** `artDirection` for a request: trimmed, empty fields left out, nothing without a motif. */
export function artDirectionBody(draft: ArtDirectionDraft): {
  artDirection?: ArtDirection;
} {
  const motif = draft.motif.trim();
  if (!motif) return {};
  const setting = draft.setting.trim();
  const mood = draft.mood.trim();
  return {
    artDirection: {
      motif,
      ...(setting ? { setting } : {}),
      ...(mood ? { mood } : {}),
    },
  };
}

/** Motif, setting and mood of new art; `current` shows the stored ones as hints. */
export function ArtDirectionFields({
  value,
  onChange,
  de,
  current,
}: {
  value: ArtDirectionDraft;
  onChange: (next: ArtDirectionDraft) => void;
  de: boolean;
  current?: Partial<ArtDirectionDraft>;
}) {
  const incomplete = artDirectionIncomplete(value);
  return (
    <div className="creative-art-direction">
      <p className="creative-meta">
        {label(current ? "artDirectionKeep" : "artDirectionHint", de)}
      </p>
      {(["motif", "setting", "mood"] as const).map((key) => (
        <label className="field creative-field" key={key}>
          <span className="field-label">{label(key, de)}</span>
          <Input
            value={value[key]}
            maxLength={DIRECTION_LIMITS[key]}
            placeholder={current?.[key] || undefined}
            aria-invalid={key === "motif" && incomplete ? true : undefined}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </label>
      ))}
      {incomplete && (
        <p className="creative-meta" role="alert">
          {label("motifNeeded", de)}
        </p>
      )}
    </div>
  );
}

/** The paid-art confirmation: the maximum cost and where the prompt goes. */
export function RegenerateConfirm({
  de,
  maxCostMicros,
  pending,
  error,
  current,
  onConfirm,
  onCancel,
}: {
  de: boolean;
  maxCostMicros: number | null;
  pending: boolean;
  error: unknown;
  /** The creative's stored art plan, shown as hints. */
  current?: Partial<ArtDirectionDraft>;
  /** Called with the art direction to send (empty: keep the stored one). */
  onConfirm: (direction: { artDirection?: ArtDirection }) => void;
  onCancel: () => void;
}) {
  const [sure, setSure] = useState(false);
  const [direction, setDirection] = useState(NO_DIRECTION);
  const cost = formatUsd(maxCostMicros);
  return (
    <div className="creative-confirm">
      <p>{label("confirmCost", de).replace("{cost}", cost)}</p>
      <p>{label("confirmPrompt", de)}</p>
      <p>{label("confirmRights", de)}</p>
      <ArtDirectionFields
        value={direction}
        onChange={setDirection}
        de={de}
        current={current ?? {}}
      />
      {maxCostMicros === null && (
        <Alert kind="warning">{label("costUnknownMax", de)}</Alert>
      )}
      <label className="creative-check">
        <Input
          type="checkbox"
          checked={sure}
          onChange={(e) => setSure(e.target.checked)}
        />
        <span>{label("confirmPromptCheck", de)}</span>
      </label>
      {error ? (
        <Alert kind="error">{creativeErrorMessage(error, de)}</Alert>
      ) : null}
      <div className="form-actions">
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {label("cancel", de)}
        </Button>
        <Button
          onClick={() => onConfirm(artDirectionBody(direction))}
          disabled={
            pending ||
            !sure ||
            maxCostMicros === null ||
            artDirectionIncomplete(direction)
          }
        >
          {pending
            ? label("working", de)
            : label("confirm", de).replace("{cost}", cost)}
        </Button>
      </div>
    </div>
  );
}

function CopyFields({
  value,
  limits,
  onChange,
  de,
}: {
  value: CreativeCopy;
  limits?: Record<string, number>;
  onChange: (next: CreativeCopy) => void;
  de: boolean;
}) {
  const fields = ["eyebrow", "headline", "subline", "cta"] as const;
  return (
    <>
      {fields.map((key) => {
        const max = limits?.[key];
        const current = value[key] ?? "";
        return (
          <label className="field creative-field" key={key}>
            <span className="field-label">
              {label(key, de)}
              {max ? ` (${current.length}/${max})` : ""}
            </span>
            <Input
              value={current}
              required={key === "headline"}
              aria-invalid={max ? current.length > max : undefined}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            />
          </label>
        );
      })}
    </>
  );
}

const trimmed = (copy: CreativeCopy): CreativeCopy => ({
  headline: copy.headline.trim(),
  ...(copy.eyebrow?.trim() ? { eyebrow: copy.eyebrow.trim() } : {}),
  ...(copy.subline?.trim() ? { subline: copy.subline.trim() } : {}),
  ...(copy.cta?.trim() ? { cta: copy.cta.trim() } : {}),
});

/** Variants any of the given formats offer for a template. */
function variantsOf(
  options: CreativeOptions,
  template: string | undefined,
  formats: string[],
): string[] {
  const offer = options.templates.find((t) => t.id === template);
  if (!offer) return [];
  return [...new Set(formats.flatMap((f) => offer.variants[f] ?? []))];
}

/**
 * Sends a produce request; after a paid one succeeded, `renew` draws the
 * form's next request id, so its next paid image is a new request. A failed
 * request keeps the id: sending it again never pays twice (R51, M9).
 */
export async function sendProduce<T>(
  send: () => Promise<T>,
  paid: boolean,
  renew: () => void,
): Promise<T> {
  const result = await send();
  if (paid) renew();
  return result;
}

function ProduceForm({
  projectId,
  content,
  options,
  assets,
  isOwner,
  maxArtCostMicros,
  de,
  action,
  locked,
}: {
  projectId: string;
  content: PanelContent;
  options: CreativeOptions;
  assets: PanelAsset[];
  isOwner: boolean;
  maxArtCostMicros: number | null;
  de: boolean;
  action: CreativeAction;
  locked: boolean;
}) {
  const enabled = options.config?.enabledTemplates;
  const templates = options.templates.filter(
    (t) => !enabled || enabled.includes(t.id),
  );
  const [template, setTemplate] = useState(templates[0]?.id ?? "");
  const [variant, setVariant] = useState("");
  const [artId, setArtId] = useState("");
  const [productId, setProductId] = useState("");
  const [newArt, setNewArt] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [direction, setDirection] = useState(NO_DIRECTION);
  const [copy, setCopy] = useState<CreativeCopy>(
    content.creativeCopy ?? { headline: "" },
  );
  // One id per paid image: sending the same request again never pays twice (R51).
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const formats = channelFormats(options, content);
  const offer = templates.find((t) => t.id === template);
  const variants = variantsOf(options, template, formats);
  const arts = assets.filter(
    (a) => ART_TYPES.includes(a.type) && a.usageApproved,
  );
  const products = assets.filter(
    (a) => PRODUCT_TYPES.includes(a.type) && a.usageApproved,
  );
  const askNew = isOwner && newArt;
  return (
    <form
      className="creative-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!copy.headline.trim() && !content.creativeCopy) return;
        const paid = Boolean(askNew && maxArtCostMicros);
        void action.run(() =>
          sendProduce(
            () =>
              creativePost(collectionPath(projectId, "creatives"), {
                contentId: content.id,
                template,
                ...(variant ? { variant } : {}),
                copy: trimmed(copy),
                ...(artId && !askNew ? { artAssetId: artId } : {}),
                ...productIds(offer, productId),
                ...(askNew ? artDirectionBody(direction) : {}),
                ...(askNew && maxArtCostMicros
                  ? {
                      generateArt: {
                        confirmMaximumCostMicros: maxArtCostMicros,
                        confirmPromptMayBeSentToProvider: true,
                        requestId,
                      },
                    }
                  : {}),
              }),
            paid,
            () => setRequestId(crypto.randomUUID()),
          ),
        );
      }}
    >
      <label className="field creative-field">
        <span className="field-label">{label("template", de)}</span>
        <select
          value={template}
          onChange={(e) => {
            // A variant or product of the old template may not exist in the new one.
            setTemplate(e.target.value);
            setVariant("");
            setProductId("");
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {pick(TEMPLATE_LABEL, t.id, de)}
            </option>
          ))}
        </select>
      </label>
      <label className="field creative-field">
        <span className="field-label">{label("variant", de)}</span>
        <select value={variant} onChange={(e) => setVariant(e.target.value)}>
          <option value="">{label("auto", de)}</option>
          {variants.map((v) => (
            <option key={v} value={v}>
              {pick(VARIANT_LABEL, v, de)}
            </option>
          ))}
        </select>
      </label>
      <label className="field creative-field">
        <span className="field-label">{label("art", de)}</span>
        <select
          value={artId}
          disabled={askNew}
          onChange={(e) => setArtId(e.target.value)}
        >
          <option value="">{label("noArt", de)}</option>
          {arts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {offer && offer.needs.product !== "none" && (
        <label className="field creative-field">
          <span className="field-label">{label("product", de)}</span>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">{label("noProduct", de)}</option>
            {products.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {isOwner && (
        <label className="creative-check">
          <Input
            type="checkbox"
            checked={newArt}
            onChange={(e) => {
              setNewArt(e.target.checked);
              setConfirmed(false);
            }}
          />
          <span>{label("newArt", de)}</span>
        </label>
      )}
      {askNew && (
        <div className="creative-confirm">
          <p>
            {label("confirmCost", de).replace(
              "{cost}",
              formatUsd(maxArtCostMicros),
            )}{" "}
            {label("confirmPrompt", de)}
          </p>
          <label className="creative-check">
            <Input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>{label("confirmPromptCheck", de)}</span>
          </label>
          <ArtDirectionFields
            value={direction}
            onChange={setDirection}
            de={de}
          />
        </div>
      )}
      <CopyFields
        value={copy}
        limits={offer?.copyLimits}
        onChange={setCopy}
        de={de}
      />
      <div className="form-actions">
        <Button
          type="submit"
          disabled={
            locked ||
            !template ||
            (askNew &&
              (!confirmed ||
                !maxArtCostMicros ||
                artDirectionIncomplete(direction)))
          }
        >
          {action.pending ? label("working", de) : label("produce", de)}
        </Button>
      </div>
    </form>
  );
}

function RecomposeForm({
  projectId,
  creative,
  options,
  de,
  action,
  locked,
}: {
  projectId: string;
  creative: CreativeView;
  options: CreativeOptions;
  de: boolean;
  action: CreativeAction;
  locked: boolean;
}) {
  const formats = renditionFormats(creative);
  const variants = variantsOf(options, creative.template, formats);
  const offer = options.templates.find((t) => t.id === creative.template);
  const [variant, setVariant] = useState(
    variants.includes(creative.variant) ? creative.variant : "",
  );
  const [placement, setPlacement] = useState<LogoPlacement>(
    creative.options.logoPlacement,
  );
  const [scale, setScale] = useState<TextScale>(creative.options.textScale);
  const [copy, setCopy] = useState<CreativeCopy>(creative.copy);
  return (
    <form
      className="creative-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(() =>
          creativePost(
            collectionPath(projectId, `creatives/${creative.id}/recompose`),
            {
              ...(variant ? { variant } : {}),
              options: { logoPlacement: placement, textScale: scale },
              copy: trimmed(copy),
            },
          ),
        );
      }}
    >
      <p className="creative-meta">{label("recomposeHint", de)}</p>
      <label className="field creative-field">
        <span className="field-label">{label("variant", de)}</span>
        <select value={variant} onChange={(e) => setVariant(e.target.value)}>
          <option value="">{label("auto", de)}</option>
          {variants.map((v) => (
            <option key={v} value={v}>
              {pick(VARIANT_LABEL, v, de)}
            </option>
          ))}
        </select>
      </label>
      <label className="field creative-field">
        <span className="field-label">{label("logoPlacement", de)}</span>
        <select
          value={placement}
          onChange={(e) => setPlacement(e.target.value as LogoPlacement)}
        >
          {(Object.keys(PLACEMENT_LABEL) as LogoPlacement[]).map((p) => (
            <option key={p} value={p}>
              {word(PLACEMENT_LABEL[p], de)}
            </option>
          ))}
        </select>
      </label>
      <label className="field creative-field">
        <span className="field-label">{label("textSize", de)}</span>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as TextScale)}
        >
          {(Object.keys(SCALE_LABEL) as TextScale[]).map((s) => (
            <option key={s} value={s}>
              {SCALE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <CopyFields
        value={copy}
        limits={offer?.copyLimits}
        onChange={setCopy}
        de={de}
      />
      <div className="form-actions">
        <Button
          type="submit"
          variant="outline"
          disabled={locked || !copy.headline.trim()}
        >
          {action.pending ? label("working", de) : label("recompose", de)}
        </Button>
      </div>
    </form>
  );
}

function Actions({
  projectId,
  creative,
  isOwner,
  maxArtCostMicros,
  de,
  action,
  locked,
  regenerate,
  setRegenerate,
}: {
  projectId: string;
  creative: CreativeView;
  isOwner: boolean;
  maxArtCostMicros: number | null;
  de: boolean;
  action: CreativeAction;
  locked: boolean;
  /** The request id of the open regenerate dialog, or null while it is closed. */
  regenerate: string | null;
  setRegenerate: (id: string | null) => void;
}) {
  const [accept, setAccept] = useState(false);
  // The acceptance belongs to the findings it was given for (R-fix 3).
  useEffect(() => setAccept(false), [creative.id, creative.version]);
  const path = (tail: string) =>
    collectionPath(projectId, `creatives/${creative.id}/${tail}`);
  const needsAccept =
    creative.status === "needs_owner" || creative.qa.verdict === "needs_owner";
  const blocked = creative.status === "needs_rights";
  const done = creative.status === "attached";
  const gone = creative.status === "superseded";
  const canAttach =
    !blocked && !done && !gone && (!needsAccept || (isOwner && accept));
  const busy = locked;
  return (
    <div className="creative-actions">
      {needsAccept && !blocked && !done && !gone && isOwner && (
        <label className="creative-check">
          <Input
            type="checkbox"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
          <span>{label("acceptQa", de)}</span>
        </label>
      )}
      {blocked && (
        <Alert kind="warning">{label("attachNeedsRights", de)}</Alert>
      )}
      {needsAccept && !blocked && !done && !gone && !isOwner && (
        <Alert kind="warning">{label("attachNeedsOwner", de)}</Alert>
      )}
      <div className="form-actions">
        {isOwner && !gone && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRegenerate(crypto.randomUUID())}
            >
              {label("regenerate", de)}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action.run(() => creativePost(path("review"), {}))
              }
            >
              {label("review", de)}
            </Button>
          </>
        )}
        <Button
          disabled={busy || !canAttach}
          onClick={() =>
            void action.run(() =>
              creativePost(
                path("attach"),
                needsAccept && isOwner ? { acceptQaFindings: true } : {},
              ),
            )
          }
        >
          {done ? label("attached", de) : label("attach", de)}
        </Button>
      </div>
      {!done && !gone && (
        <p className="creative-meta">{label("attachNote", de)}</p>
      )}
      {regenerate && (
        <Modal
          title={label("confirmTitle", de)}
          onClose={() => !locked && setRegenerate(null)}
        >
          <RegenerateConfirm
            de={de}
            maxCostMicros={maxArtCostMicros}
            pending={locked}
            error={action.error}
            current={creative.brief}
            onCancel={() => setRegenerate(null)}
            onConfirm={(direction) =>
              maxArtCostMicros &&
              void action
                .run(() =>
                  creativePost(path("regenerate-art"), {
                    confirmMaximumCostMicros: maxArtCostMicros,
                    confirmPromptMayBeSentToProvider: true,
                    requestId: regenerate,
                    ...direction,
                  }),
                )
                .then((result) => result && setRegenerate(null))
            }
          />
        </Modal>
      )}
    </div>
  );
}

/** The panel for loaded data; `CreativePanel` fetches and hands it over. */
export function CreativePanelView({
  projectId,
  content,
  access,
  de,
  creative,
  options,
  assets,
  maxArtCostMicros,
  onChanged,
  refreshing = false,
  initialFormat,
}: {
  projectId: string;
  content: PanelContent;
  access: Access;
  de: boolean;
  creative: CreativeView | null;
  options: CreativeOptions;
  assets: PanelAsset[];
  maxArtCostMicros: number | null;
  onChanged: () => void;
  /** A reload after an action is still running: actions stay locked until it ends. */
  refreshing?: boolean;
  initialFormat?: FormatId;
}) {
  // One lock for every write: produce, recompose, attach, regenerate, review.
  const action = useCreativeAction(onChanged);
  const locked = action.pending || refreshing;
  const [regenerate, setRegenerate] = useState<string | null>(null);
  const canEdit = access !== "viewer";
  const isOwner = access === "owner";
  const formats = creative ? renditionFormats(creative) : [];
  return (
    <section
      className="creative-panel"
      aria-label={label("title", de)}
      aria-busy={false}
    >
      <h3>{label("title", de)}</h3>
      {!creative ? (
        <>
          <Empty
            title={label("none", de)}
            description={label("noneHint", de)}
          />
          {canEdit &&
            (options.config ? (
              <ProduceForm
                projectId={projectId}
                content={content}
                options={options}
                assets={assets}
                isOwner={isOwner}
                maxArtCostMicros={maxArtCostMicros}
                de={de}
                action={action}
                locked={locked}
              />
            ) : (
              <Alert kind="warning">{label("noBrandKit", de)}</Alert>
            ))}
        </>
      ) : (
        <>
          <div className="creative-layout">
            <Preview
              creative={creative}
              de={de}
              initialFormat={initialFormat}
            />
            <div className="creative-side">
              <h4>{label("postText", de)}</h4>
              <blockquote className="creative-post">{content.body}</blockquote>
              <dl className="creative-facts">
                <dt>{label("channel", de)}</dt>
                <dd>{channelText(content)}</dd>
                <dt>{label("formats", de)}</dt>
                <dd>
                  {formats
                    .map((f) => word(FORMAT_LABEL[f] ?? [f, f], de))
                    .join(", ") || "—"}
                </dd>
                <dt>{label("status", de)}</dt>
                <dd>
                  <span className="creative-status">
                    <Dot tone={STATUS[creative.status].tone} />
                    {word(STATUS[creative.status].label, de)}
                  </span>
                </dd>
                <dt>{label("quality", de)}</dt>
                <dd>
                  <Badge tone={VERDICT[creative.qa.verdict].tone}>
                    {word(VERDICT[creative.qa.verdict].label, de)}
                  </Badge>
                </dd>
                <dt>{label("cost", de)}</dt>
                <dd>{costText(creative, de)}</dd>
              </dl>
              {creative.qa.vision && <p>{label("reviewDone", de)}</p>}
            </div>
          </div>
          {creative.qa.verdict === "needs_owner" && (
            <Alert kind="warning">
              {de
                ? "Die Prüfungen haben Befunde, die ein Owner ansehen muss."
                : "The checks found issues an owner needs to look at."}
            </Alert>
          )}
          <Checks creative={creative} de={de} />
          <Components creative={creative} assets={assets} de={de} />
          {canEdit && (
            <>
              <Actions
                projectId={projectId}
                creative={creative}
                isOwner={isOwner}
                maxArtCostMicros={maxArtCostMicros}
                de={de}
                action={action}
                locked={locked}
                regenerate={regenerate}
                setRegenerate={setRegenerate}
              />
              <details className="creative-recompose">
                <summary>{label("recompose", de)}</summary>
                <RecomposeForm
                  projectId={projectId}
                  creative={creative}
                  options={options}
                  de={de}
                  action={action}
                  locked={locked}
                />
              </details>
            </>
          )}
        </>
      )}
      {action.error && !regenerate ? (
        <Alert kind="error">{creativeErrorMessage(action.error, de)}</Alert>
      ) : null}
    </section>
  );
}

/** Settled cost in USD, "—" when the creative carries none; unclear amounts named. */
function costText(creative: CreativeView, de: boolean): string {
  const cost = creative.cost;
  if (!cost) return "—";
  const base = formatUsd(cost.settledMicros);
  return cost.unknownMicros > 0
    ? `${base} + ${formatUsd(cost.unknownMicros)} (${label("unclear", de)})`
    : base;
}

type OpenAiImageConfig = {
  imageGeneration?: { maxCostMicrosPerImage?: number };
};

/** The creative of one post, with loading, empty and error states. */
export function CreativePanel({
  projectId,
  content,
  access,
}: {
  projectId: string;
  content: PanelContent;
  access: Access;
}) {
  const { locale } = useWorkspace();
  const de = locale === "de";
  const options = useCreativeOptions(projectId);
  const creative = useContentCreative(projectId, content.id);
  const canEdit = access !== "viewer";
  const assets = useResource<{
    items: Array<{ id: string; data: Record<string, unknown> }>;
  }>(collectionPath(projectId, "assets"));
  const openAi = useResource<OpenAiImageConfig>(
    access === "owner"
      ? collectionPath(projectId, "openai-configuration")
      : null,
  );
  if (options.loading || creative.loading || (canEdit && assets.loading))
    return <Loading label={label("loading", de)} />;
  const failure = options.error ?? creative.error;
  if (failure || !options.data)
    return (
      <Alert kind="error">
        {label("loadFailed", de)}{" "}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            options.refresh();
            creative.refresh();
          }}
        >
          {label("retry", de)}
        </Button>
      </Alert>
    );
  const items: PanelAsset[] = (assets.data?.items ?? []).map((item) => ({
    id: item.id,
    name: String(item.data.name ?? item.data.filename ?? "—"),
    type: String(item.data.type ?? ""),
    usageApproved: item.data.usageApproved === true,
  }));
  const max = openAi.data?.imageGeneration?.maxCostMicrosPerImage;
  return (
    <CreativePanelView
      projectId={projectId}
      content={content}
      access={access}
      de={de}
      creative={creative.data}
      options={options.data}
      assets={items}
      maxArtCostMicros={max && max > 0 ? max : null}
      refreshing={creative.loading || assets.loading}
      onChanged={() => {
        creative.refresh();
        assets.refresh();
      }}
    />
  );
}
