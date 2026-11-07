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

const STATE: Record<
  DeliverableState,
  [string, string, "neutral" | "success" | "warning" | "danger" | "blue"]
> = {
  awaiting_release: ["Waiting for release", "Wartet auf Freigabe", "warning"],
  expired: ["Expired", "Abgelaufen", "neutral"],
  released: ["Released", "Freigegeben", "blue"],
  published: ["Published", "Veröffentlicht", "success"],
  failed: ["Failed", "Fehlgeschlagen", "danger"],
  canceled: ["Canceled", "Abgebrochen", "neutral"],
  dropped: ["Dropped", "Nicht eingeplant", "neutral"],
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
            {a.delivery} · {a.approvalMode}
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
      {detail.runs.map((run) => (
        <article key={run.id} className="approval-item">
          <p className="panel-note">
            {run.date} ·{" "}
            <Badge
              tone={
                run.status === "completed"
                  ? "success"
                  : run.status === "failed"
                    ? "danger"
                    : "neutral"
              }
            >
              {run.status}
            </Badge>
            {run.errors.map((error) => (
              <span key={`${error.step}:${error.code}`}>
                {" "}
                <Badge tone="warning">
                  {error.step}: {error.code}
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
              {de ? "Keine Beiträge in diesem Lauf." : "No posts in this run."}
            </p>
          )}
          {run.deliverables.map((d) => {
            const [en, deText, tone] = STATE[d.state];
            const link = d.publication?.permalink;
            return (
              <div key={d.contentId} className="approval-item">
                <p className="panel-note">
                  {when(d.slotAt, locale, zone)} · {d.channelName ?? d.channel}{" "}
                  <Badge tone={tone}>{de ? deText : en}</Badge>
                  {d.publication?.errorCode && (
                    <span>
                      {" "}
                      <Badge tone="danger">{d.publication.errorCode}</Badge>
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
                      href={`/social/calendar?post=${d.publication.socialPostId}`}
                    >
                      {de ? "Im Social-Kalender" : "In the Social calendar"}
                    </AppLink>
                  )}
                </div>
              </div>
            );
          })}
        </article>
      ))}
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
