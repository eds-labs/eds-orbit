"use client";
import { AppLink } from "@/platform/ui/app-link";
import {
  collectionPath,
  post,
  useMutation,
  useResource,
  usd,
  when,
} from "@/lib/api";
import { Alert, Badge, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { RetryRunButton } from "./assignments";

/** `GET /assignments/:id/detail` (G7). */
export type DeliverableState =
  | "awaiting_release"
  | "expired"
  | "released"
  | "handoff_pending"
  | "scheduled"
  | "published"
  | "failed"
  | "canceled"
  | "dropped";
export type AssignmentDetailData = {
  assignment: {
    id: string;
    version: number;
    name: string;
    status: string;
    channels: Array<{ id: string; name: string; platform: string }>;
    schedule: {
      rhythm: string;
      times: string[];
      leadMinutes: number;
      timezone: string;
    };
    delivery: string;
    approvalMode: string;
    image: "none" | "plain" | "banner" | "creative";
    historyDays: number;
    monthlyBudgetMicros: number;
    monthSpentMicros: number;
  };
  nextRunAt: string | null;
  runs: Array<{
    id: string;
    date: string;
    status: string;
    createdAt: string;
    errors: Array<{ step: string; code: string }>;
    retryable: boolean;
    /** Set when the owner retried this run (G6); the new run is `retriedByRunId`. */
    retiredAt?: string | null;
    retriedByRunId?: string | null;
    deliverables: Array<{
      contentId: string;
      channel: string;
      channelName: string | null;
      slotAt: string;
      excerpt: string;
      assetId: string | null;
      state: DeliverableState;
      publication: {
        id: string;
        status: string;
        permalink: string | null;
        socialPostId: string | null;
        errorCode: string | null;
      } | null;
    }>;
  }>;
};

type Tone = "neutral" | "success" | "warning" | "danger" | "blue";
const STATE: Record<DeliverableState, [string, string, Tone]> = {
  awaiting_release: ["Waiting for release", "Wartet auf Freigabe", "warning"],
  expired: ["Expired", "Abgelaufen", "neutral"],
  released: ["Released", "Freigegeben", "blue"],
  handoff_pending: ["Approved, moving to Social", "Freigegeben, geht an Social", "blue"],
  scheduled: ["Scheduled in Social", "In Social geplant", "blue"],
  published: ["Published", "Veröffentlicht", "success"],
  failed: ["Failed", "Fehlgeschlagen", "danger"],
  canceled: ["Canceled", "Abgebrochen", "neutral"],
  dropped: ["Dropped", "Nicht eingeplant", "neutral"],
};
/** Run statuses of assignment-runs.ts: [en, de, tone]. */
const RUN_STATUS: Record<string, [string, string, Tone]> = {
  planned: ["Planned", "Geplant", "neutral"],
  running: ["Running", "Läuft", "blue"],
  done: ["Done", "Erledigt", "success"],
  partial: ["Partly done", "Teilweise erledigt", "warning"],
  failed: ["Failed", "Fehlgeschlagen", "danger"],
  canceled: ["Canceled", "Abgebrochen", "neutral"],
};
const DELIVERY: Record<string, [string, string]> = {
  publish: ["Publish at the slot", "Zum Termin veröffentlichen"],
  postiz_draft: ["Postiz draft only", "Nur als Postiz-Entwurf"],
};
const APPROVAL_MODE: Record<string, [string, string]> = {
  human_each: ["Owner releases each post", "Owner gibt jeden Beitrag frei"],
  delegated_review: [
    "Agent review with veto window",
    "Agenten-Prüfung mit Einspruchsfrist",
  ],
};
/** What the codes this view shows mean: [en, de]. */
const ERROR_TEXT: Record<string, [string, string]> = {
  SOCIAL_VALIDATION_FAILED: [
    "Social would refuse this post (for example Instagram without an image).",
    "Social würde diesen Beitrag ablehnen (zum Beispiel Instagram ohne Bild).",
  ],
  SOCIAL_HOLD_FAILED: [
    "The post could not be shown in Social yet. Orbit tries again; the planned time stays.",
    "Der Beitrag konnte noch nicht in Social angezeigt werden. Orbit versucht es erneut; der geplante Zeitpunkt bleibt.",
  ],
  SLOT_EXPIRED: [
    "The planned time had passed; the post was not published.",
    "Der geplante Zeitpunkt war vorbei; der Beitrag wurde nicht veröffentlicht.",
  ],
  SOCIAL_SLOT_EXPIRED: [
    "Not published: the planned time had passed by more than 30 minutes.",
    "Nicht veröffentlicht: Der geplante Zeitpunkt lag mehr als 30 Minuten zurück.",
  ],
  SLOT_UNAVAILABLE: [
    "No free slot was left for this post.",
    "Für diesen Beitrag war kein freier Termin mehr übrig.",
  ],
  RUN_NOT_RETRYABLE: [
    "This run cannot be retried.",
    "Dieser Lauf kann nicht wiederholt werden.",
  ],
  RUN_RETRY_TOO_LATE: [
    "Too late to retry: the slot is less than an hour away.",
    "Zu spät für eine Wiederholung: Der Termin ist weniger als eine Stunde entfernt.",
  ],
  SOCIAL_PLATFORM_NOT_AVAILABLE: [
    "Publishing to this platform is switched off.",
    "Veröffentlichen auf dieser Plattform ist ausgeschaltet.",
  ],
};
/** A human message for a code, with a generic fallback; the code is shown beside it. */
export function errorText(code: string, de: boolean): string {
  const known = ERROR_TEXT[code];
  if (known) return de ? known[1] : known[0];
  return de ? "Fehler" : "Error";
}
const label = (
  map: Record<string, [string, string]>,
  value: string,
  de: boolean,
) => {
  const known = map[value];
  return known ? known[de ? 1 : 0] : value;
};

const IMAGE: Record<
  AssignmentDetailData["assignment"]["image"],
  [string, string]
> = {
  none: ["No image", "Kein Bild"],
  plain: ["Image", "Bild"],
  banner: ["Banner", "Banner"],
  creative: ["Creative", "Creative"],
};

/** The presentational detail: settings, runs and per-platform posts of one assignment. */
export function AssignmentDetailView({
  detail,
  projectId,
  de,
  isOwner,
  pending = false,
  onRetry,
  closeHref,
}: {
  detail: AssignmentDetailData;
  projectId: string;
  de: boolean;
  isOwner: boolean;
  pending?: boolean;
  onRetry?: (runId: string) => void;
  closeHref?: string;
}) {
  const locale = de ? "de" : "en";
  const a = detail.assignment;
  const zone = a.schedule.timezone;
  return (
    <section className="panel assignment-detail">
      <div className="panel-head">
        <div>
          <h2>{a.name}</h2>
          <p>
            {a.channels.map((c) => `${c.name} (${c.platform})`).join(", ") ||
              (de ? "Keine Kanäle" : "No channels")}
          </p>
        </div>
        {closeHref && (
          <AppLink href={closeHref}>{de ? "Schließen" : "Close"}</AppLink>
        )}
      </div>
      <h3>{de ? "Einstellungen" : "Settings"}</h3>
      <dl>
        <div>
          <dt>{de ? "Rhythmus" : "Schedule"}</dt>
          <dd>
            {a.schedule.rhythm} · {a.schedule.times.join(", ")} ({zone}) ·{" "}
            {de
              ? `${a.schedule.leadMinutes} min Vorlauf`
              : `${a.schedule.leadMinutes} min lead`}
          </dd>
        </div>
        <div>
          <dt>{de ? "Nächster Lauf" : "Next run"}</dt>
          <dd>
            {detail.nextRunAt ? when(detail.nextRunAt, locale, zone) : "—"}
          </dd>
        </div>
        <div>
          <dt>{de ? "Zustellung" : "Delivery"}</dt>
          <dd>
            {label(DELIVERY, a.delivery, de)} ·{" "}
            {label(APPROVAL_MODE, a.approvalMode, de)}
          </dd>
        </div>
        <div>
          <dt>{de ? "Bild" : "Image"}</dt>
          <dd>{IMAGE[a.image][de ? 1 : 0]}</dd>
        </div>
        <div>
          <dt>{de ? "Themen-Historie" : "Topic history"}</dt>
          <dd>{de ? `${a.historyDays} Tage` : `${a.historyDays} days`}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>
            {usd(a.monthSpentMicros)} / {usd(a.monthlyBudgetMicros)}
          </dd>
        </div>
      </dl>
      <h3>{de ? "Läufe" : "Runs"}</h3>
      {detail.runs.length === 0 && (
        <p className="panel-note">
          {de ? "Noch keine Läufe." : "No runs yet."}
        </p>
      )}
      {detail.runs.map((run) => {
        const [statusEn, statusDe, statusTone] = RUN_STATUS[run.status] ?? [
          run.status,
          run.status,
          "neutral" as const,
        ];
        const retried = Boolean(run.retiredAt);
        return (
          <article key={run.id} id={`run-${run.id}`} className="approval-item">
            <p className="panel-note">
              {run.date} ·{" "}
              {retried ? (
                // Replaced by its retry: not an open failure (G6).
                <Badge tone="neutral">
                  {run.retriedByRunId ? (
                    <a href={`#run-${run.retriedByRunId}`}>
                      {de
                        ? "Erneut versucht → neuer Lauf"
                        : "Retried → new run"}
                    </a>
                  ) : de ? (
                    "Erneut versucht"
                  ) : (
                    "Retried"
                  )}
                </Badge>
              ) : (
                <Badge tone={statusTone}>{de ? statusDe : statusEn}</Badge>
              )}
              {run.errors.map((error) => (
                <span key={`${error.step}:${error.code}`}>
                  {" "}
                  <Badge tone={retried ? "neutral" : "warning"}>
                    {error.step}: {errorText(error.code, de)} ({error.code})
                  </Badge>
                </span>
              ))}
            </p>
            {isOwner && run.retryable && onRetry && (
              <div className="form-actions">
                <RetryRunButton
                  de={de}
                  disabled={pending}
                  onClick={() => onRetry(run.id)}
                />
              </div>
            )}
            <h4>{de ? "Beiträge" : "Posts"}</h4>
            {run.deliverables.length === 0 && (
              <p className="panel-note">
                {de
                  ? "Keine Beiträge in diesem Lauf."
                  : "No posts in this run."}
              </p>
            )}
            {run.deliverables.map((d) => {
              const [en, deText, tone] = STATE[d.state];
              const link = d.publication?.permalink;
              return (
                <div key={d.contentId} className="approval-item">
                  <p className="panel-note">
                    {when(d.slotAt, locale, zone)} ·{" "}
                    {d.channelName ?? d.channel}{" "}
                    <Badge tone={tone}>{de ? deText : en}</Badge>
                    {d.publication?.errorCode && (
                      <span>
                        {" "}
                        <Badge tone="danger">
                          {errorText(d.publication.errorCode, de)} (
                          {d.publication.errorCode})
                        </Badge>
                      </span>
                    )}
                  </p>
                  {d.assetId && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="approval-item-thumbnail"
                      src={`/api/projects/${projectId}/assets/${d.assetId}/content`}
                      alt={de ? "Bild des Beitrags" : "Post image"}
                      width={160}
                      loading="lazy"
                    />
                  )}
                  <pre className="approval-item-body">{d.excerpt}</pre>
                  <div className="form-actions">
                    {d.state === "awaiting_release" && (
                      <AppLink href="/approvals">
                        {de ? "Freigeben" : "Release"}
                      </AppLink>
                    )}
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer noopener">
                        {de ? "Beitrag ansehen" : "View post"}
                      </a>
                    )}
                    {d.publication?.socialPostId && (
                      <AppLink
                        href={`/social/posts?post=${d.publication.socialPostId}`}
                      >
                        {de ? "In Social öffnen" : "Open in Social"}
                      </AppLink>
                    )}
                  </div>
                </div>
              );
            })}
          </article>
        );
      })}
    </section>
  );
}

/** Loads one assignment's detail; retry goes through the existing run retry route. */
export function AssignmentDetail({
  assignmentId,
  closeHref,
}: {
  assignmentId: string;
  closeHref?: string;
}) {
  const { project, locale, isOwner, refresh } = useWorkspace();
  const resource = useResource<AssignmentDetailData>(
    collectionPath(project.id, `assignments/${assignmentId}/detail`),
  );
  const mutation = useMutation(() => {
    resource.refresh();
    refresh();
  });
  if (resource.error)
    return (
      <section className="panel">
        <Alert kind="error">{resource.error.message}</Alert>
      </section>
    );
  if (!resource.data) return <Loading />;
  return (
    <>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <AssignmentDetailView
        detail={resource.data}
        projectId={project.id}
        de={locale === "de"}
        isOwner={isOwner}
        pending={mutation.pending}
        closeHref={closeHref}
        onRetry={(runId) =>
          mutation.run(async () => {
            await post(
              collectionPath(project.id, `assignment-runs/${runId}/retry`),
              {},
            );
          })
        }
      />
    </>
  );
}
