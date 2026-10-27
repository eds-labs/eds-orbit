import { CreativeRequestError } from "./creative-api";

// Wording of the creative panel: [English, German] per key.
type Pair = readonly [string, string];

export const CHECK_LABELS: Record<string, Pair> = {
  CREATIVE_DIMENSIONS: ["Wrong image size", "Falsche Bildgröße"],
  CREATIVE_FILE_TOO_LARGE: ["Image file is too large", "Bilddatei ist zu groß"],
  TEXT_CONTRAST_LOW: [
    "Text is hard to read (low contrast)",
    "Text ist schlecht lesbar (geringer Kontrast)",
  ],
  TEXT_BACKDROP_BUSY: [
    "The picture behind the text is too busy",
    "Das Bild hinter dem Text ist zu unruhig",
  ],
  LOGO_CONTRAST_LOW: [
    "Logo is hard to see against the background",
    "Logo hebt sich schlecht vom Hintergrund ab",
  ],
  LOGO_INTEGRITY: [
    "The logo differs from the approved file",
    "Das Logo weicht von der freigegebenen Datei ab",
  ],
  SCREENSHOT_INTEGRITY: [
    "The screenshot differs from the approved file",
    "Der Screenshot weicht von der freigegebenen Datei ab",
  ],
  SUBJECT_TOO_SMALL: [
    "The subject of the picture is too small",
    "Das Motiv im Bild ist zu klein",
  ],
  EMPTY_AREA_EXCESSIVE: [
    "Too much empty space in the picture",
    "Zu viel leere Fläche im Bild",
  ],
  SAFE_AREA_VIOLATION: [
    "Content reaches into the platform's unsafe edge",
    "Inhalt ragt in den unsicheren Randbereich der Plattform",
  ],
  LAYER_OVERLAP: [
    "Text, logo or product overlap",
    "Text, Logo oder Produkt überlappen sich",
  ],
  ASSET_UPSCALED: ["Image was enlarged", "Bild wurde vergrößert"],
  ASSET_RIGHTS: [
    "Usage rights of a component are not approved",
    "Nutzungsrechte einer Komponente sind nicht freigegeben",
  ],
  // The image copy's wording (R66): the owner decides.
  CREATIVE_UNSUPPORTED_CLAIM: [
    "The image text states a figure, number or status",
    "Der Bildtext nennt eine Zahl, Menge oder einen Status",
  ],
  CREATIVE_PROHIBITED_LANGUAGE: [
    "The image text makes a promise or uses forbidden wording",
    "Der Bildtext verspricht etwas oder nutzt verbotene Wörter",
  ],
  LINK_UNVERIFIED: [
    "The image text names a web address",
    "Der Bildtext nennt eine Webadresse",
  ],
};

export const ERROR_LABELS: Record<string, Pair> = {
  CREATIVE_VARIANT_NOT_AVAILABLE: [
    "The chosen variant is not offered for this format. Pick another variant or choose automatic.",
    "Die gewählte Variante gibt es für dieses Format nicht. Wählen Sie eine andere oder automatisch.",
  ],
  PRODUCT_ASSET_REQUIRED: [
    "This template needs an approved product image or screenshot. Approve one in the asset library or pick another template.",
    "Diese Vorlage braucht ein freigegebenes Produktbild oder einen Screenshot. Geben Sie eines in der Asset-Bibliothek frei oder wählen Sie eine andere Vorlage.",
  ],
  CREATIVE_TEXT_TOO_LONG: [
    "A text is too long for this template. Shorten the marked field.",
    "Ein Text ist für diese Vorlage zu lang. Kürzen Sie das betroffene Feld.",
  ],
  TEXT_OVERFLOW: [
    "The text does not fit even at the smallest size. Shorten it or use a smaller text size.",
    "Der Text passt auch in der kleinsten Größe nicht. Kürzen Sie ihn.",
  ],
  CREATIVE_TEXT_UNSAFE: [
    "The text contains invisible or look-alike characters. Retype it.",
    "Der Text enthält unsichtbare oder ähnlich aussehende Zeichen. Tippen Sie ihn neu.",
  ],
  CREATIVE_LINK_NOT_ALLOWED: [
    "The image text or art direction contains a link. The post's link belongs in the post text.",
    "Der Bildtext oder die Bildvorgabe enthält einen Link. Der Link gehört in den Beitragstext.",
  ],
  CREATIVE_COPY_REQUIRED: [
    "Enter at least a headline.",
    "Geben Sie mindestens eine Überschrift ein.",
  ],
  ART_REQUIRED: [
    "This template needs a picture. Choose approved art or generate new art.",
    "Diese Vorlage braucht ein Bild. Wählen Sie freigegebene Bilder oder erzeugen Sie ein neues.",
  ],
  ASSET_RIGHTS: [
    "A component is not approved for this use.",
    "Eine Komponente ist für diese Nutzung nicht freigegeben.",
  ],
  CREATIVE_RIGHTS_REQUIRED: [
    "Approve the usage rights of the new art, then recompose.",
    "Geben Sie die Nutzungsrechte des neuen Bildes frei und setzen Sie das Creative neu zusammen.",
  ],
  CREATIVE_QA_FAILED: [
    "The checks found problems. An owner has to accept the findings first.",
    "Die Prüfungen haben Probleme gefunden. Ein Owner muss die Befunde zuerst akzeptieren.",
  ],
  OWNER_REQUIRED: ["Only an owner can do this.", "Das kann nur ein Owner."],
  CREATIVE_NOT_ATTACHABLE: [
    "This creative cannot be attached in its current state.",
    "Dieses Creative kann in seinem Zustand nicht angehängt werden.",
  ],
  CONTENT_CHANGED: [
    "The post changed meanwhile. Reload and try again.",
    "Der Beitrag hat sich geändert. Neu laden und erneut versuchen.",
  ],
  DRAFT_SUPERSEDED: [
    "A newer version of the post exists.",
    "Es gibt eine neuere Version des Beitrags.",
  ],
  ALREADY_SCHEDULED: [
    "The post is already scheduled; withdraw the schedule first.",
    "Der Beitrag ist bereits terminiert; nehmen Sie den Termin zuerst zurück.",
  ],
  CAPTION_TOO_LONG: [
    "The post text is too long for the channel.",
    "Der Beitragstext ist für den Kanal zu lang.",
  ],
  BRAND_ASSET_CHANGED: [
    "A logo or image changed since the creative was made. Produce it again.",
    "Ein Logo oder Bild hat sich seit der Erstellung geändert. Erzeugen Sie das Creative neu.",
  ],
  MARKETING_PROFILE_CHANGED: [
    "The brand profile changed meanwhile. Try again.",
    "Das Markenprofil hat sich geändert. Erneut versuchen.",
  ],
  MARKETING_PROFILE_REQUIRED: [
    "Set up the brand profile with an approved logo first.",
    "Richten Sie zuerst das Markenprofil mit freigegebenem Logo ein.",
  ],
  PRIMARY_LOGO_REQUIRED: [
    "The brand profile needs a primary logo.",
    "Das Markenprofil braucht ein Hauptlogo.",
  ],
  APPROVED_LOGO_ASSET_REQUIRED: [
    "The primary logo is not approved.",
    "Das Hauptlogo ist nicht freigegeben.",
  ],
  CREATIVE_SOCIAL_ONLY: [
    "Creatives exist for social posts only.",
    "Creatives gibt es nur für Social-Beiträge.",
  ],
  IMAGE_COST_CONFIRMATION_STALE: [
    "The image price changed. Reopen the dialog and confirm the new maximum.",
    "Der Bildpreis hat sich geändert. Dialog erneut öffnen und neues Maximum bestätigen.",
  ],
  RESERVATION_ALREADY_USED: [
    "This request was already sent; nothing was paid twice. Reload to see the result.",
    "Diese Anfrage wurde schon gesendet; nichts wurde doppelt bezahlt. Neu laden, um das Ergebnis zu sehen.",
  ],
  ART_CORRECTION_LIMIT: [
    "The limit for new art attempts is reached.",
    "Das Limit für neue Bildversuche ist erreicht.",
  ],
  CREATIVE_NOT_REVIEWABLE: [
    "This creative was replaced or waits for its art's rights; it cannot be reviewed.",
    "Dieses Creative wurde ersetzt oder wartet auf die Rechte am Bild; es kann nicht geprüft werden.",
  ],
  VISION_REVIEW_DISABLED: [
    "The vision review is switched off in the brand kit.",
    "Die Bildprüfung ist im Marken-Kit ausgeschaltet.",
  ],
  PROVIDER_USE_REQUIRED: [
    "The sources do not allow sending this image to a provider.",
    "Die Quellen erlauben nicht, dieses Bild an einen Anbieter zu senden.",
  ],
  PROJECT_PAUSED: ["The project is paused.", "Das Projekt ist pausiert."],
  VALIDATION_FAILED: ["Some input is not valid.", "Eine Eingabe ist ungültig."],
  MODULE_DISABLED: [
    "Marketing is switched off for this project.",
    "Marketing ist für dieses Projekt ausgeschaltet.",
  ],
};

const list = (value: unknown) =>
  String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");

/** A refused request in words, with the asset or draft the server named (R56). */
export function creativeErrorMessage(error: unknown, de: boolean): string {
  const i = de ? 1 : 0;
  if (!(error instanceof CreativeRequestError))
    return error instanceof Error ? error.message : "Request failed.";
  const base = ERROR_LABELS[error.code]?.[i] ?? error.message;
  const detail = error.detail ?? {};
  const parts = [base];
  if (detail.assetIds)
    parts.push(
      `${de ? "Betroffene Assets" : "Assets concerned"}: ${list(detail.assetIds)}.`,
    );
  if (Array.isArray(detail.failed))
    parts.push(
      `${de ? "Betroffene Entwürfe" : "Drafts concerned"}: ${(
        detail.failed as Array<{ contentId?: string; codes?: unknown }>
      )
        .map(
          (item) =>
            `${item.contentId ?? "—"} (${(Array.isArray(item.codes)
              ? item.codes
              : [item.codes]
            )
              .map((c) => CHECK_LABELS[String(c)]?.[i] ?? String(c))
              .join(", ")})`,
        )
        .join("; ")}.`,
    );
  if (detail.artAssetId)
    parts.push(
      de
        ? `Das bezahlte Bild ${String(detail.artAssetId)} wurde als nicht freigegebene Referenz behalten.`
        : `The paid image ${String(detail.artAssetId)} was kept as an unapproved reference.`,
    );
  return parts.join(" ");
}
