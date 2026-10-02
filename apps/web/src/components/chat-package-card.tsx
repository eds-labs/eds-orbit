"use client";
import Link from "next/link";
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
    | "expired";
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
    status: "planned" | "queued" | "running" | "drafted" | "failed";
    errorCode: string | null;
    content: { id: string; body: string; status: string } | null;
  }[];
};

const packageLabels: Record<ContentPackage["status"], [string, string]> = {
  proposed: ["Confirmation required", "Bestätigung erforderlich"],
  running: ["Drafts in progress", "Entwürfe in Arbeit"],
  completed: ["Drafts ready", "Entwürfe fertig"],
  partially_completed: ["Partly ready", "Teilweise fertig"],
  failed: ["Blocked", "Blockiert"],
  rejected: ["Rejected", "Abgelehnt"],
  expired: ["Expired", "Abgelaufen"],
};
const deliverableLabels: Record<
  ContentPackage["deliverables"][number]["status"],
  [string, string]
> = {
  planned: ["Planned", "Geplant"],
  queued: ["Queued", "In Warteschlange"],
  running: ["Drafting", "Wird erstellt"],
  drafted: ["Draft ready", "Entwurf fertig"],
  failed: ["Blocked", "Blockiert"],
};

/** A package is still changing while its drafts are queued or being written. */
export const packageInProgress = (pkg: ContentPackage) =>
  pkg.status === "running";

export function PackageCard({
  pkg,
  de,
  canStart,
  pending,
  onStart,
}: {
  pkg: ContentPackage;
  de: boolean;
  canStart: boolean;
  pending: boolean;
  onStart: (pkg: ContentPackage) => void;
}) {
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
            {deliverable.plannedSlotAt && (
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
            {deliverable.errorCode && (
              <Alert kind="warning">{deliverable.errorCode}</Alert>
            )}
          </li>
        ))}
      </ul>
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
      {pkg.status !== "proposed" && (
        <div className="chat-links">
          <Link href="/content">{de ? "Entwürfe ansehen" : "View drafts"}</Link>
        </div>
      )}
    </section>
  );
}
