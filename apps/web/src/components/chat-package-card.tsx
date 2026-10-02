"use client";
import Link from "next/link";
import Image from "next/image";
import { usd } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";

export type ContentPackage = {
  id: string;
  goal: string;
  status:
    | "proposed"
    | "running"
    | "completed"
    | "partially_completed"
    | "failed"
    | "rejected"
    | "expired"
    | "canceled";
  ceilingMicros: number | null;
  actionRequest: {
    id: string;
    version: number;
    packageHash: string;
    status: string;
  } | null;
  deliverables: {
    key: string;
    channelName: string;
    platform: string;
    plannedSlotAt: string | null;
    status:
      | "planned"
      | "queued"
      | "running"
      | "drafted"
      | "revising"
      | "failed"
      | "canceled";
    errorCode: string | null;
    content: {
      id: string;
      body: string;
      status: string;
      reused?: boolean;
      assetId?: string | null;
    } | null;
    review: { valid: boolean; problems: string[] } | null;
    revisions?: number;
    revisionError?: string | null;
    schedule?: {
      status: string;
      scheduledAt: string;
      executionMode: "test" | "live" | null;
      blockers: string[];
      move?: { status: string; scheduledAt: string } | null;
    } | null;
  }[];
  image: {
    prompt: string;
    maxCostMicros: number;
    status: ImageStatus;
    assetId: string | null;
    assetVersion?: number | null;
    rightsApproved?: boolean;
    href: string | null;
    errorCode: string | null;
  } | null;
};
type ImageStatus =
  | "planned"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "generated"
  | "outcome_unknown"
  | "failed"
  | "canceled";

const packageLabels: Record<ContentPackage["status"], [string, string]> = {
  proposed: ["Confirmation required", "Bestätigung erforderlich"],
  running: ["Drafts in progress", "Entwürfe in Arbeit"],
  completed: ["Drafts ready", "Entwürfe fertig"],
  partially_completed: ["Partly ready", "Teilweise fertig"],
  failed: ["Blocked", "Blockiert"],
  rejected: ["Rejected", "Abgelehnt"],
  expired: ["Expired", "Abgelaufen"],
  canceled: ["Canceled", "Abgebrochen"],
};
const deliverableLabels: Record<
  ContentPackage["deliverables"][number]["status"],
  [string, string]
> = {
  planned: ["Planned", "Geplant"],
  queued: ["Queued", "In Warteschlange"],
  running: ["Drafting", "Wird erstellt"],
  drafted: ["Draft ready", "Entwurf fertig"],
  revising: ["Revising", "Wird überarbeitet"],
  failed: ["Blocked", "Blockiert"],
  canceled: ["Canceled", "Abgebrochen"],
};
const imageLabels: Record<ImageStatus, [string, string]> = {
  planned: ["Planned", "Geplant"],
  awaiting_approval: ["Waiting for owner", "Wartet auf Owner"],
  queued: ["Queued", "In Warteschlange"],
  running: ["Generating", "Wird erzeugt"],
  generated: ["Generated, rights review open", "Erzeugt, Rechteprüfung offen"],
  outcome_unknown: [
    "Unclear result, not resent",
    "Ergebnis unklar, nicht erneut gesendet",
  ],
  failed: ["Blocked", "Blockiert"],
  canceled: ["Canceled", "Abgebrochen"],
};

// Schedule states from the decision request, then from the publication itself.
const scheduleLabels: Record<string, [string, string]> = {
  awaiting_approval: [
    "Waiting for owner decision",
    "Wartet auf Owner-Freigabe",
  ],
  stale: ["Draft changed, propose again", "Entwurf geändert, neu vorschlagen"],
  expired: ["Decision expired", "Freigabe abgelaufen"],
  rejected: ["Rejected by owner", "Vom Owner abgelehnt"],
  canceled: ["Canceled", "Abgebrochen"],
  scheduled: ["Scheduled", "Terminiert"],
  sending: ["Handing over", "Wird übergeben"],
  published: ["Published", "Veröffentlicht"],
  published_test: ["Published (test mode)", "Veröffentlicht (Testmodus)"],
  blocked_dependency: ["Blocked before handoff", "Vor Übergabe blockiert"],
  outcome_unknown: [
    "Unclear result, not resent",
    "Ergebnis unklar, nicht erneut gesendet",
  ],
  failed: ["Failed", "Fehlgeschlagen"],
};

/** A package is still changing while its drafts are queued or being written. */
export const packageInProgress = (pkg: ContentPackage) =>
  pkg.status === "running";
// Before the handoff a schedule or an open proposal can still be stopped.
const cancelableSchedule = (schedule: {
  status: string;
  move?: { status: string } | null;
}) =>
  ["awaiting_approval", "stale", "scheduled", "blocked_dependency"].includes(
    schedule.status,
  ) || schedule.move?.status === "awaiting_approval";
const cancelable = (pkg: ContentPackage) =>
  pkg.status === "proposed" || pkg.status === "running";

export function PackageCard({
  pkg,
  de,
  canStart,
  pending,
  onStart,
  onCancel,
  canApproveRights = false,
  onApproveRights,
  onAttachImage,
  onUnschedule,
}: {
  pkg: ContentPackage;
  de: boolean;
  canStart: boolean;
  pending: boolean;
  onStart: (pkg: ContentPackage) => void;
  onCancel: (pkg: ContentPackage) => void;
  canApproveRights?: boolean;
  onApproveRights?: (pkg: ContentPackage) => void;
  onAttachImage?: (pkg: ContentPackage, deliverableKeys: string[]) => void;
  onUnschedule?: (pkg: ContentPackage, deliverableKey: string) => void;
}) {
  const image = pkg.image;
  // Drafts that could still take the rights-approved image.
  const withoutImage =
    image?.status === "generated" && image.rightsApproved
      ? pkg.deliverables.filter(
          (deliverable) =>
            deliverable.content &&
            deliverable.content.assetId !== image.assetId &&
            !["scheduled", "sending", "published", "published_test"].includes(
              deliverable.schedule?.status ?? "",
            ),
        )
      : [];
  const tone =
    pkg.status === "completed"
      ? "success"
      : pkg.status === "proposed" || pkg.status === "running"
        ? "blue"
        : "warning";
  return (
    <section
      className="chat-proposal chat-package"
      aria-label={de ? "Content-Paket" : "Content package"}
    >
      <div className="chat-proposal-head">
        <strong>{de ? "Content-Paket" : "Content package"}</strong>
        <Badge tone={tone}>{packageLabels[pkg.status][de ? 1 : 0]}</Badge>
      </div>
      <p>{pkg.goal}</p>
      <dl>
        <div>
          <dt>{de ? "Kostenobergrenze" : "Cost ceiling"}</dt>
          <dd>{usd(pkg.ceilingMicros)}</dd>
        </div>
      </dl>
      <ul className="chat-package-deliverables">
        {pkg.deliverables.map((deliverable) => (
          <li key={deliverable.key}>
            <div className="chat-proposal-head">
              <span>{deliverable.channelName}</span>
              <Badge
                tone={deliverable.status === "drafted" ? "success" : "blue"}
              >
                {deliverableLabels[deliverable.status][de ? 1 : 0]}
              </Badge>
            </div>
            {deliverable.plannedSlotAt && !deliverable.schedule && (
              <p className="chat-package-note">
                {de ? "Geplanter Termin" : "Planned slot"}:{" "}
                <time dateTime={deliverable.plannedSlotAt}>
                  {new Date(deliverable.plannedSlotAt).toLocaleString(
                    de ? "de-DE" : "en-GB",
                  )}
                </time>{" "}
                ({de ? "wird nicht veröffentlicht" : "not published"})
              </p>
            )}
            {deliverable.content && (
              <blockquote className="chat-package-draft">
                {deliverable.content.body}
              </blockquote>
            )}
            {deliverable.content?.assetId && (
              <p className="chat-package-note">
                {de ? "Mit Paketbild" : "With package image"}
              </p>
            )}
            {withoutImage.includes(deliverable) &&
              canStart &&
              onAttachImage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAttachImage(pkg, [deliverable.key])}
                  disabled={pending}
                >
                  {de ? "Paketbild anhängen" : "Attach package image"}
                </Button>
              )}
            {Boolean(deliverable.revisions) && (
              <p className="chat-package-note">
                {de
                  ? `${deliverable.revisions}× überarbeitet`
                  : `Revised ${deliverable.revisions}×`}
              </p>
            )}
            {deliverable.revisionError && (
              <Alert kind="warning">{deliverable.revisionError}</Alert>
            )}
            {deliverable.content?.reused && (
              <p className="chat-package-note">
                {de
                  ? "Identischer früherer Entwurf wiederverwendet."
                  : "Identical earlier draft reused."}
              </p>
            )}
            {deliverable.review && (
              <p className="chat-package-note">
                <Badge tone={deliverable.review.valid ? "success" : "warning"}>
                  {deliverable.review.valid
                    ? de
                      ? "Prüfung bestanden"
                      : "Review passed"
                    : de
                      ? "Prüfung nötig"
                      : "Needs review"}
                </Badge>{" "}
                {deliverable.review.problems.join(", ")}
              </p>
            )}
            {deliverable.errorCode && (
              <Alert kind="warning">{deliverable.errorCode}</Alert>
            )}
            {deliverable.schedule && (
              <p className="chat-package-note chat-package-schedule">
                <Badge
                  tone={
                    ["scheduled", "published", "published_test"].includes(
                      deliverable.schedule.status,
                    )
                      ? "success"
                      : deliverable.schedule.status === "awaiting_approval"
                        ? "blue"
                        : "warning"
                  }
                >
                  {scheduleLabels[deliverable.schedule.status]?.[de ? 1 : 0] ??
                    deliverable.schedule.status}
                </Badge>{" "}
                <time dateTime={deliverable.schedule.scheduledAt}>
                  {new Date(deliverable.schedule.scheduledAt).toLocaleString(
                    de ? "de-DE" : "en-GB",
                  )}
                </time>
                {deliverable.schedule.executionMode === "test" &&
                  (de ? " · Testmodus" : " · test mode")}
                {deliverable.schedule.blockers.length > 0 &&
                  ` · ${deliverable.schedule.blockers.join(", ")}`}
              </p>
            )}
            {deliverable.schedule?.move && (
              <p className="chat-package-note">
                {de ? "Verschieben auf" : "Move to"}{" "}
                <time dateTime={deliverable.schedule.move.scheduledAt}>
                  {new Date(
                    deliverable.schedule.move.scheduledAt,
                  ).toLocaleString(de ? "de-DE" : "en-GB")}
                </time>
                :{" "}
                {scheduleLabels[deliverable.schedule.move.status]?.[
                  de ? 1 : 0
                ] ?? deliverable.schedule.move.status}
              </p>
            )}
            {deliverable.schedule &&
              cancelableSchedule(deliverable.schedule) &&
              canStart &&
              onUnschedule && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onUnschedule(pkg, deliverable.key)}
                  disabled={pending}
                >
                  {de ? "Termin abbrechen" : "Cancel schedule"}
                </Button>
              )}
          </li>
        ))}
      </ul>
      {pkg.image && (
        <div className="chat-package-image">
          <div className="chat-proposal-head">
            <span>{de ? "Bild" : "Image"}</span>
            <Badge tone={pkg.image.status === "generated" ? "success" : "blue"}>
              {imageLabels[pkg.image.status][de ? 1 : 0]}
            </Badge>
          </div>
          <p className="chat-package-note">
            {pkg.image.prompt} · {de ? "höchstens" : "at most"}{" "}
            {usd(pkg.image.maxCostMicros)}
          </p>
          {pkg.image.href && (
            <Image
              unoptimized
              src={pkg.image.href}
              width={240}
              height={240}
              alt={de ? "Erzeugtes Paketbild" : "Generated package image"}
            />
          )}
          {pkg.image.errorCode && (
            <Alert kind="warning">{pkg.image.errorCode}</Alert>
          )}
          {pkg.image.status === "generated" && (
            <p className="chat-package-note">
              {pkg.image.rightsApproved
                ? de
                  ? "Nutzungsrechte bestätigt."
                  : "Usage rights approved."
                : de
                  ? "Erst nach der Rechtebestätigung eines Owners an Beiträge anhängbar."
                  : "Can be attached to posts once an owner approved its usage rights."}
            </p>
          )}
          <div className="chat-links">
            {pkg.image.status === "generated" &&
              !pkg.image.rightsApproved &&
              canApproveRights &&
              onApproveRights && (
                <Button
                  variant="outline"
                  onClick={() => onApproveRights(pkg)}
                  disabled={pending}
                >
                  {de ? "Nutzungsrechte bestätigen" : "Approve usage rights"}
                </Button>
              )}
          </div>
        </div>
      )}
      {pkg.status === "proposed" && (
        <>
          <p className="chat-package-note">
            {de
              ? "Entwürfe entstehen erst nach dem Start. Es wird nichts veröffentlicht."
              : "Drafts are created only after you start the package. Nothing is published."}
          </p>
          {canStart && (
            <Button onClick={() => onStart(pkg)} disabled={pending}>
              {de ? "Paket starten" : "Start package"}
            </Button>
          )}
        </>
      )}
      <div className="chat-links">
        {cancelable(pkg) && canStart && (
          <Button
            variant="outline"
            onClick={() => onCancel(pkg)}
            disabled={pending}
          >
            {de ? "Paket abbrechen" : "Cancel package"}
          </Button>
        )}
        {pkg.status !== "proposed" && (
          <Link href="/content">{de ? "Entwürfe ansehen" : "View drafts"}</Link>
        )}
      </div>
    </section>
  );
}
