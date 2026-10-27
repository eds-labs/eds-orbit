"use client";
import { useState } from "react";
import { usd } from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";

/** The assignment content an owner confirms (chat card or approvals inbox). */
export type AssignmentContent = {
  id: string;
  version?: number;
  // Status when the card was made; the page shows the live one.
  status?: string;
  name: string;
  kind: string;
  contentType: string;
  channels: string[];
  channelNames?: Record<string, string>;
  schedule: {
    rhythm: string;
    weekdays: number[];
    times: string[];
    date?: string;
    leadMinutes?: number;
  };
  topicFrame: string;
  tone?: string;
  image: boolean;
  styleAssetIds: string[];
  vetoMinutes: number;
  monthlyBudgetMicros: number;
  pendingReviewLimit?: number;
  // How approved posts leave Orbit (R73); absent means "publish".
  delivery?: "publish" | "postiz_draft";
  approvalMode?: "human_each" | "delegated_review";
  // One text and one image per slot for all channels (R76); absent means one text per channel.
  sharedAcrossChannels?: boolean;
  // The shape of every post (R77); absent means none.
  format?: AssignmentFormat;
  // A 16:9 banner per slot in the brand style (R78); absent means a free image.
  banner?: AssignmentBanner;
  // A composed creative per post (Creative Studio); absent for none.
  creative?: AssignmentCreative;
  actionRequestId?: string | null;
};
export type AssignmentCreative = {
  templates?: string[];
  artPer?: "run" | "post";
  imageKind?: string;
};
export type AssignmentBanner = { template: "brand_landscape"; style?: string };
export type AssignmentFormat = {
  minChars: number;
  maxChars: number;
  hashtags: { min: number; max: number };
  paragraphs: boolean;
  cta?: string;
};
/** The `assignment.confirm` action request the card decides. */
export type AssignmentRequest = {
  id: string;
  version: number;
  packageHash: string;
  status: string;
};

export const IMAGE_RIGHTS_CONSENT: [string, string] = [
  "Generated images may be used for this assignment (no logos, no real persons, no text in the image)",
  "Generierte Bilder dürfen für diesen Auftrag verwendet werden (keine Logos, keine echten Personen, kein Text im Bild)",
];

/** What a banner adds to the image consent (R78): Orbit composes it, nothing is generated but the background. */
export const BANNER_CONSENT: [string, string] = [
  "Banner: a generated background, with the approved logo and reviewed text added by Orbit",
  "Banner: generierter Hintergrund, dazu das freigegebene Logo und geprüfter Text",
];

/** What a creative adds to the image consent: only the art is generated, logos and screenshots never leave Orbit. */
export const CREATIVE_CONSENT =
  "Orbit generates the image art with your configured image model and composes it with your approved logo and product images. Logos and screenshots are never sent to the image provider.";
const CREATIVE_CONSENT_DE =
  "Orbit erzeugt das Bild mit Ihrem konfigurierten Bildmodell und setzt es mit Ihrem freigegebenen Logo und Ihren freigegebenen Produktbildern zusammen. Logos und Screenshots gehen nie an den Bildanbieter.";

/** "Art per post · Image kind: auto · Templates: …" for the creative a card confirms. */
export function creativeText(
  creative: AssignmentCreative | undefined,
  de: boolean,
) {
  if (!creative) return de ? "Kein Creative" : "No creative";
  const art =
    creative.artPer === "run"
      ? de
        ? "Bild je Lauf"
        : "Art per run"
      : de
        ? "Bild je Beitrag"
        : "Art per post";
  return [
    art,
    `${de ? "Bildart" : "Image kind"}: ${creative.imageKind ?? "auto"}`,
    `${de ? "Vorlagen" : "Templates"}: ${
      creative.templates?.length
        ? creative.templates.join(", ")
        : de
          ? "alle aktiven"
          : "all enabled"
    }`,
  ].join(" · ");
}

export const assignmentStatusLabels: Record<string, [string, string]> = {
  draft: ["Confirmation required", "Bestätigung erforderlich"],
  active: ["Active", "Aktiv"],
  paused: ["Paused", "Pausiert"],
  budget_exhausted: ["Budget used up", "Budget aufgebraucht"],
  ended: ["Ended", "Beendet"],
};
/** The delivery an owner confirms: published after the veto window, or only a draft in Postiz (R73). */
export const deliveryLabels: Record<
  "publish" | "postiz_draft",
  [string, string]
> = {
  publish: [
    "Published after the veto window",
    "Veröffentlichen nach dem Veto-Fenster",
  ],
  postiz_draft: [
    "As a draft in Postiz (you publish it yourself)",
    "Als Entwurf in Postiz (du veröffentlichst selbst)",
  ],
};
export const approvalModeText = (
  mode: AssignmentContent["approvalMode"],
  de: boolean,
) =>
  mode === "human_each"
    ? de
      ? "Jeden Beitrag vor externer Übergabe selbst freigeben"
      : "Approve each post before any external handoff"
    : de
      ? "Delegierte Prüfung mit bestehenden Freigabe- und Veto-Regeln"
      : "Delegated review under existing approval and veto rules";

export const deliveryText = (
  delivery: AssignmentContent["delivery"],
  de: boolean,
  approvalMode?: AssignmentContent["approvalMode"],
) =>
  delivery === "postiz_draft"
    ? deliveryLabels.postiz_draft[de ? 1 : 0]
    : approvalMode === "human_each"
      ? de
        ? "Veröffentlichen nach deiner Freigabe"
        : "Publish after your approval"
      : deliveryLabels.publish[de ? 1 : 0];

/** Whether a slot's channels share one text (and the image, when there is one) (R76). */
export const sharedText = (
  shared: boolean | undefined,
  de: boolean,
  image = true,
) =>
  shared
    ? image
      ? de
        ? "Ein Text und ein Bild für alle Kanäle"
        : "One text and one image for all channels"
      : de
        ? "Ein Text für alle Kanäle"
        : "One text for all channels"
    : de
      ? "Eigener Text je Kanal"
      : "Own text per channel";

/** "600–900 Zeichen · 2–3 Hashtags · Absätze · Link …" (R77). */
export function formatText(format: AssignmentFormat | undefined, de: boolean) {
  if (!format) return de ? "Ohne Vorgabe" : "None";
  const range = (min: number, max: number) =>
    min === max ? `${min}` : `${min}–${max}`;
  return [
    `${range(format.minChars, format.maxChars)} ${de ? "Zeichen" : "characters"}`,
    `${range(format.hashtags.min, format.hashtags.max)} Hashtags`,
    ...(format.paragraphs ? [de ? "kurze Absätze" : "short paragraphs"] : []),
    ...(format.cta ? [`${de ? "Link" : "Link"} ${format.cta}`] : []),
  ].join(" · ");
}

/** "Markenbanner 16:9 je Termin …" (R78); without a banner the free image or none. */
export function bannerText(
  banner: AssignmentBanner | undefined,
  image: boolean,
  de: boolean,
) {
  if (!banner)
    return image
      ? de
        ? "Kein Banner, freies Bild je Lauf"
        : "No banner, a free image per run"
      : de
        ? "Kein Banner"
        : "No banner";
  const base = de
    ? "Markenbanner 16:9 je Termin: Logo, Überschrift, Unterzeile, Button und Domain auf generiertem Hintergrund"
    : "Brand banner 16:9 per slot: logo, headline, subline, button and domain over a generated background";
  return banner.style
    ? `${base} · ${de ? "Stil" : "Style"}: ${banner.style}`
    : base;
}

export const contentTypeLabels: Record<string, [string, string]> = {
  social: ["Social post", "Social-Post"],
  blog: ["Blog article", "Blogartikel"],
  newsletter: ["Newsletter", "Newsletter"],
  report: ["Report", "Bericht"],
};
const weekdayShort = {
  de: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
export const statusTone = (status: string) =>
  status === "active"
    ? "success"
    : status === "draft"
      ? "blue"
      : status === "ended"
        ? "neutral"
        : "warning";

/** "Daily at 10:00, 17:00" in the project's local times. */
export function scheduleText(
  schedule: AssignmentContent["schedule"],
  de: boolean,
) {
  const times = schedule.times.join(", ");
  if (schedule.rhythm === "once")
    return de
      ? `Einmalig am ${schedule.date ?? "—"} um ${times}`
      : `Once on ${schedule.date ?? "—"} at ${times}`;
  if (schedule.rhythm === "weekly") {
    const days = schedule.weekdays
      .map((day) => weekdayShort[de ? "de" : "en"][day])
      .join(", ");
    return de
      ? `Wöchentlich ${days} um ${times}`
      : `Weekly ${days} at ${times}`;
  }
  return de ? `Täglich um ${times}` : `Daily at ${times}`;
}

export const channelText = (
  assignment: Pick<AssignmentContent, "channels" | "channelNames">,
  de: boolean,
) =>
  assignment.channels.length
    ? assignment.channels
        .map((id) => assignment.channelNames?.[id] ?? id)
        .join(", ")
    : de
      ? "Keine (Bericht an dich)"
      : "None (report to you)";

/**
 * An assignment as the owner confirms it: every field of the confirmation,
 * the image-rights consent for image assignments and the decision on its
 * exact `assignment.confirm` request. Changes go through the chat.
 */
export function AssignmentCard({
  assignment,
  status,
  request,
  de,
  canDecide,
  pending,
  onConfirm,
  onReject,
  superseded = false,
  expiresAt,
}: {
  assignment: AssignmentContent;
  // Live status of the assignment (R16); the content is what the card showed.
  status: string;
  request: AssignmentRequest | null;
  de: boolean;
  canDecide: boolean;
  pending: boolean;
  onConfirm: (request: AssignmentRequest, imageRightsConsent: boolean) => void;
  onReject: (request: AssignmentRequest) => void;
  // A later change replaced this content; its own card asks for the decision.
  superseded?: boolean;
  // Expiry of the open request.
  expiresAt?: string;
}) {
  const [consent, setConsent] = useState(false);
  const open = request?.status === "pending";
  const lead = assignment.schedule.leadMinutes;
  const drafts = assignment.delivery === "postiz_draft";
  return (
    <section
      className="chat-proposal assignment-card"
      aria-label={de ? "Auftrag" : "Assignment"}
    >
      <div className="chat-proposal-head">
        <strong>{assignment.name}</strong>
        <Badge tone={statusTone(status)}>
          {(assignmentStatusLabels[status] ?? [status, status])[de ? 1 : 0]}
        </Badge>
      </div>
      <dl>
        <div>
          <dt>{de ? "Rhythmus" : "Schedule"}</dt>
          <dd>
            {scheduleText(assignment.schedule, de)}
            {lead !== undefined &&
              (de
                ? ` · Vorbereitung ${lead} Minuten vorher`
                : ` · prepared ${lead} minutes ahead`)}
          </dd>
        </div>
        <div>
          <dt>{de ? "Kanäle" : "Channels"}</dt>
          <dd>{channelText(assignment, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Art" : "Type"}</dt>
          <dd>
            {
              (contentTypeLabels[assignment.contentType] ?? [
                assignment.contentType,
                assignment.contentType,
              ])[de ? 1 : 0]
            }
          </dd>
        </div>
        <div>
          <dt>{de ? "Thema" : "Topic"}</dt>
          <dd>{assignment.topicFrame}</dd>
        </div>
        <div>
          <dt>{de ? "Ton" : "Tone"}</dt>
          <dd>{assignment.tone ?? "—"}</dd>
        </div>
        <div>
          <dt>{de ? "Bild" : "Image"}</dt>
          <dd>{assignment.image ? (de ? "Ja" : "Yes") : de ? "Nein" : "No"}</dd>
        </div>
        <div>
          <dt>{de ? "Stilreferenzen" : "Style references"}</dt>
          <dd>
            {assignment.styleAssetIds.length
              ? de
                ? `${assignment.styleAssetIds.length} Stilreferenzen`
                : `${assignment.styleAssetIds.length} style references`
              : de
                ? "Keine"
                : "None"}
          </dd>
        </div>
        {assignment.contentType === "social" && (
          <>
            <div>
              <dt>{de ? "Beiträge" : "Posts"}</dt>
              <dd>
                {sharedText(
                  assignment.sharedAcrossChannels,
                  de,
                  assignment.image,
                )}
              </dd>
            </div>
            <div>
              <dt>{de ? "Format" : "Format"}</dt>
              <dd>{formatText(assignment.format, de)}</dd>
            </div>
            <div>
              <dt>Banner</dt>
              <dd>{bannerText(assignment.banner, assignment.image, de)}</dd>
            </div>
            {assignment.creative && (
              <div>
                <dt>Creative</dt>
                <dd>{creativeText(assignment.creative, de)}</dd>
              </div>
            )}
          </>
        )}
        <div>
          <dt>{de ? "Freigabe" : "Approval"}</dt>
          <dd>{approvalModeText(assignment.approvalMode, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Zustellung" : "Delivery"}</dt>
          <dd>
            {deliveryText(assignment.delivery, de, assignment.approvalMode)}
          </dd>
        </div>
        <div>
          <dt>{de ? "Veto-Fenster" : "Veto window"}</dt>
          <dd>
            {assignment.approvalMode === "human_each"
              ? de
                ? "Jeder Beitrag wartet auf deine ausdrückliche Freigabe"
                : "Each post waits for your explicit approval"
              : drafts
                ? de
                  ? "Entfällt – Orbit veröffentlicht nichts"
                  : "None – Orbit publishes nothing"
                : de
                  ? `${assignment.vetoMinutes} Minuten vor dem Termin`
                  : `${assignment.vetoMinutes} minutes before the slot`}
          </dd>
        </div>
        <div>
          <dt>{de ? "Offene Reviews" : "Pending reviews"}</dt>
          <dd>
            {assignment.pendingReviewLimit === undefined
              ? de
                ? "Kein Limit festgelegt"
                : "No limit configured"
              : de
                ? `Höchstens ${assignment.pendingReviewLimit}; neue Erstellung wartet bei vollem Limit`
                : `At most ${assignment.pendingReviewLimit}; new generation waits when full`}
          </dd>
        </div>
        <div>
          <dt>{de ? "Budget" : "Budget"}</dt>
          <dd>
            {usd(assignment.monthlyBudgetMicros)} {de ? "pro Monat" : "a month"}
          </dd>
        </div>
      </dl>
      {open && canDecide && request && (
        <>
          {assignment.image && (
            <label className="assignment-consent">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                {IMAGE_RIGHTS_CONSENT[de ? 1 : 0]}
                {assignment.banner && (
                  <>
                    <br />
                    {BANNER_CONSENT[de ? 1 : 0]}
                  </>
                )}
                {assignment.creative && (
                  <>
                    <br />
                    {de ? CREATIVE_CONSENT_DE : CREATIVE_CONSENT}
                  </>
                )}
              </span>
            </label>
          )}
          {expiresAt && (
            <p className="chat-package-note">
              {de ? "Bestätigung gültig bis" : "Confirmation valid until"}{" "}
              <time dateTime={expiresAt}>
                {new Date(expiresAt).toLocaleString(de ? "de-DE" : "en-GB")}
              </time>
            </p>
          )}
          <p className="chat-package-note">
            {assignment.approvalMode === "human_each"
              ? de
                ? "Mit der Bestätigung erstellt Orbit Inhalte innerhalb des Budgets. Jeden Beitrag inklusive Bild und Termin gibst du vor der Veröffentlichung oder Übergabe als Postiz-Entwurf ausdrücklich frei."
                : "Confirming starts preparation within the budget. You must explicitly approve each post, including its image and time, before publication or handoff as a Postiz draft."
              : drafts
                ? de
                  ? "Mit der Bestätigung arbeitet Orbit diesen Auftrag im Budget selbstständig ab. Freigegebene Posts legt Orbit nur als Entwürfe in Postiz an, zu ihrem Termin. Veröffentlichen machst du selbst in Postiz."
                  : "Once confirmed, Orbit runs this assignment on its own within the budget. Approved posts are only created as drafts in Postiz, dated at their slot. You publish them yourself in Postiz."
                : de
                  ? "Mit der Bestätigung arbeitet Orbit diesen Auftrag im Budget selbstständig ab. Posts gehen nach dem Veto-Fenster raus, wenn du sie nicht stoppst."
                  : "Once confirmed, Orbit runs this assignment on its own within the budget. Posts go out after the veto window unless you stop them."}
          </p>
          <div className="chat-links">
            <Button
              onClick={() => onConfirm(request, assignment.image && consent)}
              disabled={pending || (assignment.image && !consent)}
            >
              {de ? "Auftrag bestätigen" : "Confirm assignment"}
            </Button>
            <Button
              variant="outline"
              onClick={() => onReject(request)}
              disabled={pending}
            >
              {de ? "Ablehnen" : "Reject"}
            </Button>
          </div>
        </>
      )}
      {superseded && (
        <p className="chat-package-note">
          {de
            ? "Veraltet: Eine geänderte Fassung dieses Auftrags wartet auf Bestätigung."
            : "Outdated: a changed version of this assignment awaits confirmation."}
        </p>
      )}
      {open && !canDecide && (
        <p className="chat-package-note">
          {de
            ? "Wartet auf Bestätigung durch den Owner."
            : "Waiting for the owner's confirmation."}
        </p>
      )}
      <p className="chat-package-note">
        {de
          ? "Änderungen am Auftrag laufen über den Chat und brauchen eine neue Bestätigung."
          : "Changes to the assignment go through the chat and need a new confirmation."}
      </p>
    </section>
  );
}
