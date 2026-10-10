"use client";
import { useState } from "react";
import { usd } from "@/lib/api";
import { Badge, Button } from "./ui/primitives";

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
  // How approved posts leave Orbit (R73); absent means "publish".
  delivery?: "publish" | "postiz_draft";
  actionRequestId?: string | null;
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
export const deliveryText = (
  delivery: AssignmentContent["delivery"],
  de: boolean,
) => deliveryLabels[delivery ?? "publish"][de ? 1 : 0];

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
        <div>
          <dt>{de ? "Zustellung" : "Delivery"}</dt>
          <dd>{deliveryText(assignment.delivery, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Veto-Fenster" : "Veto window"}</dt>
          <dd>
            {drafts
              ? de
                ? "Entfällt – Orbit veröffentlicht nichts"
                : "None – Orbit publishes nothing"
              : de
                ? `${assignment.vetoMinutes} Minuten vor dem Termin`
                : `${assignment.vetoMinutes} minutes before the slot`}
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
              <span>{IMAGE_RIGHTS_CONSENT[de ? 1 : 0]}</span>
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
            {drafts
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
