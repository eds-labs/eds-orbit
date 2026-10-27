"use client";
import { useState } from "react";
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

type Access = "viewer" | "editor" | "owner";
type Pair = readonly [string, string];
type PanelContent = {
  id: string;
  body: string;
  channel: string;
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
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
const word = (pair: Pair, de: boolean) => pair[de ? 1 : 0];
const label = (key: keyof typeof T, de: boolean) => word(T[key], de);
const pick = (map: Record<string, Pair>, key: string, de: boolean) =>
  map[key] ? word(map[key], de) : key.replaceAll("_", " ");

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

/** The paid-art confirmation: the maximum cost and where the prompt goes. */
export function RegenerateConfirm({
  de,
  maxCostMicros,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  de: boolean;
  maxCostMicros: number | null;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [sure, setSure] = useState(false);
  const cost = formatUsd(maxCostMicros);
  return (
    <div className="creative-confirm">
      <p>{label("confirmCost", de).replace("{cost}", cost)}</p>
      <p>{label("confirmPrompt", de)}</p>
      <p>{label("confirmRights", de)}</p>
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
          onClick={onConfirm}
          disabled={pending || !sure || maxCostMicros === null}
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

function ProduceForm({
  projectId,
  content,
  options,
  assets,
  isOwner,
  maxArtCostMicros,
  de,
  onChanged,
}: {
  projectId: string;
  content: PanelContent;
  options: CreativeOptions;
  assets: PanelAsset[];
  isOwner: boolean;
  maxArtCostMicros: number | null;
  de: boolean;
  onChanged: () => void;
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
  const [copy, setCopy] = useState<CreativeCopy>(
    content.creativeCopy ?? { headline: "" },
  );
  // One id for this form: sending the same request again never pays twice (R51).
  const [requestId] = useState(() => crypto.randomUUID());
  const action = useCreativeAction(onChanged);
  const formats = options.defaultChannelFormats[content.channel] ?? ["square"];
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
        void action.run(() =>
          creativePost(collectionPath(projectId, "creatives"), {
            contentId: content.id,
            template,
            ...(variant ? { variant } : {}),
            copy: trimmed(copy),
            ...(artId && !askNew ? { artAssetId: artId } : {}),
            ...(productId ? { productAssetIds: [productId] } : {}),
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
        );
      }}
    >
      <label className="field creative-field">
        <span className="field-label">{label("template", de)}</span>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
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
      {offer?.needs.product && (
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
        </div>
      )}
      <CopyFields
        value={copy}
        limits={offer?.copyLimits}
        onChange={setCopy}
        de={de}
      />
      {action.error ? (
        <Alert kind="error">{creativeErrorMessage(action.error, de)}</Alert>
      ) : null}
      <div className="form-actions">
        <Button
          type="submit"
          disabled={
            action.pending ||
            !template ||
            (askNew && (!confirmed || !maxArtCostMicros))
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
  onChanged,
}: {
  projectId: string;
  creative: CreativeView;
  options: CreativeOptions;
  de: boolean;
  onChanged: () => void;
}) {
  const formats = renditionFormats(creative);
  const variants = variantsOf(options, creative.template, formats);
  const offer = options.templates.find((t) => t.id === creative.template);
  const [variant, setVariant] = useState("");
  const [placement, setPlacement] = useState<LogoPlacement>(
    creative.options.logoPlacement,
  );
  const [scale, setScale] = useState<TextScale>(creative.options.textScale);
  const [copy, setCopy] = useState<CreativeCopy>(creative.copy);
  const action = useCreativeAction(onChanged);
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
      {action.error ? (
        <Alert kind="error">{creativeErrorMessage(action.error, de)}</Alert>
      ) : null}
      <div className="form-actions">
        <Button
          type="submit"
          variant="outline"
          disabled={action.pending || !copy.headline.trim()}
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
  onChanged,
}: {
  projectId: string;
  creative: CreativeView;
  isOwner: boolean;
  maxArtCostMicros: number | null;
  de: boolean;
  onChanged: () => void;
}) {
  const [accept, setAccept] = useState(false);
  const [regenerate, setRegenerate] = useState<string | null>(null);
  const attach = useCreativeAction(onChanged);
  const review = useCreativeAction(onChanged);
  const regen = useCreativeAction(() => {
    setRegenerate(null);
    onChanged();
  });
  const path = (tail: string) =>
    collectionPath(projectId, `creatives/${creative.id}/${tail}`);
  const needsAccept =
    creative.status === "needs_owner" || creative.qa.verdict === "needs_owner";
  const blocked = creative.status === "needs_rights";
  const done = creative.status === "attached";
  const gone = creative.status === "superseded";
  const canAttach =
    !blocked && !done && !gone && (!needsAccept || (isOwner && accept));
  const busy = attach.pending || review.pending || regen.pending;
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
                void review.run(() => creativePost(path("review"), {}))
              }
            >
              {review.pending ? label("working", de) : label("review", de)}
            </Button>
          </>
        )}
        <Button
          disabled={busy || !canAttach}
          onClick={() =>
            void attach.run(() =>
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
      {[attach.error, review.error].map((error, i) =>
        error ? (
          <Alert kind="error" key={i}>
            {creativeErrorMessage(error, de)}
          </Alert>
        ) : null,
      )}
      {regenerate && (
        <Modal
          title={label("confirmTitle", de)}
          onClose={() => !regen.pending && setRegenerate(null)}
        >
          <RegenerateConfirm
            de={de}
            maxCostMicros={maxArtCostMicros}
            pending={regen.pending}
            error={regen.error}
            onCancel={() => setRegenerate(null)}
            onConfirm={() =>
              maxArtCostMicros &&
              void regen.run(() =>
                creativePost(path("regenerate-art"), {
                  confirmMaximumCostMicros: maxArtCostMicros,
                  confirmPromptMayBeSentToProvider: true,
                  requestId: regenerate,
                }),
              )
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
  initialFormat?: FormatId;
}) {
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
                onChanged={onChanged}
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
                <dd>{content.channel || "—"}</dd>
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
                onChanged={onChanged}
              />
              <details className="creative-recompose">
                <summary>{label("recompose", de)}</summary>
                <RecomposeForm
                  projectId={projectId}
                  creative={creative}
                  options={options}
                  de={de}
                  onChanged={onChanged}
                />
              </details>
            </>
          )}
        </>
      )}
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
      onChanged={() => {
        creative.refresh();
        assets.refresh();
      }}
    />
  );
}
