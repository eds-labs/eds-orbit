"use client";
import { RunOperationView, type RunOperation } from "./run-operation";
import { AppLink } from "@/platform/ui/app-link";
import { ExceptionWords } from "./exception-words";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { AssignmentDetail } from "./assignment-detail";
import {
  ApiError,
  collectionPath,
  post,
  useMutation,
  useResource,
  usd,
  when,
} from "@/lib/api";
import {
  assignmentStatusLabels,
  bannerText,
  channelText,
  contentTypeLabels,
  deliveryText,
  approvalModeText,
  formatText,
  sharedText,
  scheduleText,
  statusTone,
  type AssignmentContent,
} from "./assignment-card";
import {
  Alert,
  Badge,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Loading,
  Modal,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";

/** One row of `GET /assignments`. */
export type AssignmentItem = Pick<
  AssignmentContent,
  | "id"
  | "name"
  | "kind"
  | "contentType"
  | "channels"
  | "channelNames"
  | "image"
  | "delivery"
  | "approvalMode"
  | "sharedAcrossChannels"
  | "format"
  | "banner"
> & {
  latestRun?: { operation?: RunOperation } | null;
  // The latest run when the owner can still retry it before its slot (G6); else null.
  retryableRunId?: string | null;
  version: number;
  status: string;
  schedule: AssignmentContent["schedule"];
  vetoMinutes: number;
  nextRunAt: string | null;
  monthCostMicros: number;
  monthlyBudgetMicros: number;
  pendingReviewLimit?: number;
  historyDays?: number;
  backlog?: {
    limit: number | null;
    pending: number;
    held: number;
    available: number | null;
    blocked: boolean;
  };
  actionRequestId: string | null;
};
type AssignmentList = {
  timezone: string;
  paused: boolean;
  items: AssignmentItem[];
};
/** One row of `GET /assignment-posts`. */
export type UpcomingPost = {
  id: string;
  version: number;
  status: string;
  reason: string | null;
  channel: string;
  channelName: string | null;
  scheduledAt: string;
  // Null for a post the owner released: it has no veto window.
  vetoDeadline: string | null;
  excerpt: string;
  assignmentId: string | null;
  assignmentName: string | null;
  ownerReleased: boolean;
  // "postiz_draft": a draft handoff of an assignment with that delivery (R73);
  // `id`, `version` and `status` are the handoff's then. Absent means "publish".
  delivery?: "publish" | "postiz_draft";
};
/** States of an assignment draft on the approvals page. */
export type DraftState =
  "pending" | "expired" | "released" | "rejected" | "archived";
/** One row of `GET /assignment-drafts`: a draft that waits for the owner's release. */
export type AwaitingOwnerDraft = {
  id: string;
  version: number;
  // `pending` while the slot is ahead; `expired` once it has passed (no release).
  state?: "pending" | "expired";
  channel: string;
  channelName: string | null;
  slotAt: string;
  excerpt: string;
  // The draft's image or creative rendition (thumbnail); absent or null: none.
  assetId?: string | null;
  assignmentId: string;
  assignmentName: string | null;
  agentApproved: boolean;
  // Why the review agent's approval does not stand in for the owner's (a
  // code, pending drafts only); absent or null: no reason recorded.
  waitingReason?: string | null;
  problems: string[];
  // Why Orbit objected (2026-11-11): the review's reasons; the owner decides.
  concerns?: string[];
  // The owner changed the text since Orbit's review.
  ownerEdited?: boolean;
  // The full text, for the owner's edit (the excerpt is shortened).
  body?: string;
  // What the release does: schedule the post or book a Postiz draft (R73).
  delivery?: "publish" | "postiz_draft";
  // The original of a channel copy (R76), else the draft itself: a
  // Facebook/Instagram pair is shown as one item with a release per channel.
  baseId?: string;
};
const UUID_PARAM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of the `history` of `GET /assignment-drafts`: an owner's decision. */
export type DraftHistoryItem = {
  id: string;
  version: number;
  state: "released" | "rejected" | "archived";
  channel: string;
  channelName: string | null;
  excerpt: string;
  assignmentName: string | null;
  decidedAt: string;
  reason: string | null;
  hidden: boolean;
  slotAt: string | null;
};
type Role = "owner" | "editor" | "viewer";
type NextStatus = "paused" | "active" | "ended";

// Orbit Agents is off when its routes do not exist.
const agentsOff = (error: ApiError | null) => error?.status === 404;

/**
 * The last answer of an Orbit Agents route: kept while the route reloads
 * (no data, no error yet), replaced by a new answer and forgotten only on a
 * 404 (Orbit Agents switched off), so tabs and sections do not flicker.
 */
export function knownData<T>(
  known: T | null,
  data: T | null,
  error: ApiError | null,
): T | null {
  if (agentsOff(error)) return null;
  return data ?? known;
}
/**
 * The kept answer of one project. `stale` is the previous project's answer
 * that the resource still holds after a switch, until its reload clears it.
 */
export type Known<T> = { key: string; value: T | null; stale?: T | null };
/** The kept answer for `key` after this render. */
export function nextKnown<T>(
  known: Known<T>,
  key: string,
  data: T | null,
  error: ApiError | null,
): Known<T> {
  // Another project starts from nothing: in the switch render the resource
  // still holds the previous project's answer and error.
  if (known.key !== key) return { key, value: null, stale: data };
  const fresh = data !== null && data === known.stale ? null : data;
  return {
    key,
    value: knownData(known.value, fresh, error),
    stale: fresh === null ? (known.stale ?? null) : null,
  };
}
function useKnownData<T>(key: string, data: T | null, error: ApiError | null) {
  const [known, setKnown] = useState<Known<T>>({ key, value: null });
  const next = nextKnown(known, key, data, error);
  useEffect(() => setKnown(next), [next.key, next.value, next.stale]);
  return next.value;
}

/**
 * Which surface a page shows: the assignments (Orbit Agents) only once its
 * route answered; `unavailable` on any error without an answer — a 404 (flag
 * off) as much as a 5xx, a 429 or a network failure during a redeploy;
 * `pending` before either. A confirmed answer kept by `knownData` through a
 * later error stays assignments.
 */
export type AgentsSurface = "pending" | "unavailable" | "assignments";
export function agentsSurface(
  data: unknown,
  error: ApiError | null,
): AgentsSurface {
  if (data !== null && data !== undefined) return "assignments";
  return error ? "unavailable" : "pending";
}
type KnownSurface = { key: string; surface: AgentsSurface };
/** Keeps the decided surface while the same project reloads; another project starts pending. */
export function nextSurface(
  known: KnownSurface,
  key: string,
  current: AgentsSurface,
): KnownSurface {
  return current === "pending" && known.key === key
    ? { key, surface: known.surface }
    : { key, surface: current };
}
function useSurface(key: string, data: unknown, error: ApiError | null) {
  const [known, setKnown] = useState<KnownSurface>({
    key,
    surface: "pending",
  });
  const next = nextSurface(known, key, agentsSurface(data, error));
  useEffect(() => setKnown(next), [next.key, next.surface]);
  return next.surface;
}

/** Runs a change and reloads after a version conflict, so the next try uses the current version. */
export async function refreshOnConflict<T>(
  task: () => Promise<T>,
  refresh: () => void,
) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) refresh();
    throw error;
  }
}

/**
 * The project's assignments and the settings surface (`agentsSurface`):
 * `available` only once the route answered, `settled` once it is decided.
 */
export function useAssignments() {
  const { project, revision } = useWorkspace();
  const resource = useResource<AssignmentList>(
    collectionPath(project.id, `assignments?revision=${revision}`),
  );
  const data = useKnownData(project.id, resource.data, resource.error);
  const surface = useSurface(project.id, data, resource.error);
  return {
    resource,
    data,
    surface,
    available: surface === "assignments",
    settled: surface !== "pending",
  };
}

/** What a retry does to the run's drafts, shown on the button and asked before it runs. */
export const retryRunHelp = (de: boolean) =>
  de
    ? "Plant einen neuen Lauf für denselben Tag. Wartende Entwürfe dieses Laufs werden ersetzt und können nicht mehr freigegeben werden."
    : "Plans a new run for the same day. Waiting drafts of this run are replaced and can no longer be released.";

/** The owner's "retry run" button of the table and the detail view; it asks first. */
export function RetryRunButton({
  de,
  disabled,
  onClick,
}: {
  de: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const help = retryRunHelp(de);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      title={help}
      onClick={() => {
        if (window.confirm(help)) onClick();
      }}
    >
      {de ? "Lauf wiederholen" : "Retry run"}
    </Button>
  );
}

const share = (cost: number, budget: number) =>
  budget > 0 ? Math.round((cost / budget) * 100) : null;

/** Assignments with status, next run, month cost against budget and the actions the role allows. */
export function AssignmentTable({
  items,
  de,
  timezone,
  role,
  pending,
  onStatus,
  onRetry,
  detailHref,
}: {
  items: AssignmentItem[];
  de: boolean;
  timezone: string;
  role: Role;
  pending: boolean;
  onStatus: (item: AssignmentItem, status: NextStatus) => void;
  // Retries the item's failed run (owner only; needs `retryableRunId`).
  onRetry?: (item: AssignmentItem, runId: string) => void;
  // Where a row opens its detail (`?assignment=<id>`); absent: no link.
  detailHref?: (item: AssignmentItem) => string;
}) {
  const [ending, setEnding] = useState("");
  const locale = de ? "de" : "en";
  const editor = role !== "viewer";
  return (
    <div className="table-wrap">
      <table className="assignments-table">
        <thead>
          <tr>
            <th>{de ? "Auftrag" : "Assignment"}</th>
            <th>Status</th>
            <th>{de ? "Nächste Vorbereitung" : "Next preparation"}</th>
            <th>{de ? "Kosten diesen Monat" : "Cost this month"}</th>
            <th scope="col" aria-label={de ? "Aktionen" : "Actions"} />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const used = share(item.monthCostMicros, item.monthlyBudgetMicros);
            const stoppable = ["active", "budget_exhausted"].includes(
              item.status,
            );
            const resumable = ["paused", "budget_exhausted"].includes(
              item.status,
            );
            return (
              <tr key={item.id}>
                <td>
                  <strong>{item.name}</strong>
                  {detailHref && (
                    <small>
                      <AppLink href={detailHref(item)}>
                        {de ? "Details" : "Details"}
                      </AppLink>
                    </small>
                  )}
                  <small>
                    {
                      (contentTypeLabels[item.contentType] ?? [
                        item.contentType,
                        item.contentType,
                      ])[de ? 1 : 0]
                    }{" "}
                    · {channelText(item, de)} ·{" "}
                    {scheduleText(item.schedule, de)}
                  </small>
                  <small>
                    {de ? "Zustellung" : "Delivery"}:{" "}
                    {deliveryText(item.delivery, de, item.approvalMode)}
                    <br />
                    {approvalModeText(item.approvalMode, de)}
                  </small>
                  {item.sharedAcrossChannels && (
                    <small>{sharedText(true, de, item.image)}</small>
                  )}
                  {item.historyDays !== undefined && (
                    <small>
                      {de
                        ? `Themen der letzten ${item.historyDays} Tage bleiben gesperrt`
                        : `Topics of the last ${item.historyDays} days stay closed`}
                    </small>
                  )}
                  {item.format && (
                    <small>
                      {de ? "Format" : "Format"}: {formatText(item.format, de)}
                    </small>
                  )}
                  {item.banner && (
                    <small>Banner: {bannerText(item.banner, true, de)}</small>
                  )}
                </td>
                <td>
                  <Badge tone={statusTone(item.status)}>
                    {
                      (assignmentStatusLabels[item.status] ?? [
                        item.status,
                        item.status,
                      ])[de ? 1 : 0]
                    }
                  </Badge>
                  <RunOperationView
                    operation={item.latestRun?.operation}
                    de={de}
                  />
                  {item.status === "draft" && item.actionRequestId && (
                    <small>
                      {de ? "Bestätigung offen" : "Confirmation open"} ·{" "}
                      <AppLink href="/approvals">
                        {de ? "Freigaben" : "Approvals"}
                      </AppLink>
                    </small>
                  )}
                </td>
                <td>
                  {item.nextRunAt
                    ? when(item.nextRunAt, locale, timezone)
                    : "—"}
                </td>
                <td>
                  {usd(item.monthCostMicros)} {de ? "von" : "of"}{" "}
                  {usd(item.monthlyBudgetMicros)}
                  {used !== null && <small>{used} %</small>}
                  <small>
                    {item.backlog?.limit != null
                      ? de
                        ? `${item.backlog.pending} warten · ${item.backlog.held} reserviert · Limit ${item.backlog.limit}`
                        : `${item.backlog.pending} waiting · ${item.backlog.held} reserved · limit ${item.backlog.limit}`
                      : de
                        ? "Review-Limit nicht festgelegt"
                        : "No review limit configured"}
                  </small>
                  {item.backlog?.blocked && (
                    <small role="status">
                      {de
                        ? "Erstellung wartet auf freie Review-Kapazität"
                        : "Generation waits for review capacity"}
                    </small>
                  )}
                </td>
                <td>
                  {editor && item.status !== "ended" && (
                    <div className="form-actions">
                      {role === "owner" && item.retryableRunId && onRetry && (
                        <RetryRunButton
                          de={de}
                          disabled={pending}
                          onClick={() => onRetry(item, item.retryableRunId!)}
                        />
                      )}
                      {stoppable && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => onStatus(item, "paused")}
                        >
                          {de ? "Pausieren" : "Pause"}
                        </Button>
                      )}
                      {resumable && role === "owner" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => onStatus(item, "active")}
                        >
                          {de ? "Fortsetzen" : "Resume"}
                        </Button>
                      )}
                      {ending === item.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={pending}
                            onClick={() => {
                              setEnding("");
                              onStatus(item, "ended");
                            }}
                          >
                            {de ? "Endgültig beenden" : "End for good"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEnding("")}
                          >
                            {de ? "Abbrechen" : "Cancel"}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setEnding(item.id)}
                        >
                          {de ? "Beenden" : "End"}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Settings tab "Aufträge": the list and its status actions; changes go through the chat. */
/** The intro of the assignments, shared by the panel and the Marketing page. */
export const ASSIGNMENTS_TEXT = {
  title: { en: "Assignments", de: "Aufträge" },
  description: {
    en: "What Orbit pursues for you. Create and change assignments in the Orbit chat; every change needs a new confirmation.",
    de: "Was Orbit für dich verfolgt. Neue Aufträge und Änderungen besprichst du im Orbit Chat; jede Änderung braucht eine neue Bestätigung.",
  },
  change: { en: "Change in chat", de: "Im Chat ändern" },
} as const;

export function Assignments({
  resource,
  data,
  headless = false,
}: {
  resource: ReturnType<typeof useAssignments>["resource"];
  // The last answer, kept while the list reloads.
  data: AssignmentList | null;
  /** Without the panel's own head, below a page head that carries it. */
  headless?: boolean;
}) {
  const { locale, project, isOwner, canEdit, refresh } = useWorkspace();
  const de = locale === "de";
  const mutation = useMutation(refresh);
  const role: Role = isOwner ? "owner" : canEdit ? "editor" : "viewer";
  const items = data?.items ?? [];
  const search = useSearchParams();
  const wanted = search?.get("assignment") ?? "";
  const selected = UUID_PARAM.test(wanted) ? wanted : "";
  const listHref = `/p/${project.id}/marketing/assignments`;
  return (
    <>
      {selected && (
        <AssignmentDetail assignmentId={selected} closeHref={listHref} />
      )}
      <section className="panel">
        {!headless && (
          <div className="panel-head">
            <div>
              <h2>{ASSIGNMENTS_TEXT.title[locale]}</h2>
              <p>{ASSIGNMENTS_TEXT.description[locale]}</p>
            </div>
            <Button asChild variant="outline">
              <AppLink href="/chat">{ASSIGNMENTS_TEXT.change[locale]}</AppLink>
            </Button>
          </div>
        )}
        {data?.paused && (
          <Alert kind="warning">
            {de
              ? "Das Projekt ist pausiert: Kein Auftrag läuft, bis du es unter Betrieb fortsetzt."
              : "The project is paused: no assignment runs until you resume it under Operations."}
          </Alert>
        )}
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        {resource.error && !agentsOff(resource.error) && (
          <Alert kind="error">{resource.error.message}</Alert>
        )}
        {!data && resource.loading ? (
          <Loading />
        ) : items.length ? (
          <AssignmentTable
            items={items}
            de={de}
            timezone={data?.timezone ?? project.timezone}
            role={role}
            pending={mutation.pending}
            detailHref={(item) => `${listHref}?assignment=${item.id}`}
            onRetry={(_item, runId) =>
              mutation.run(async () => {
                await post(
                  collectionPath(project.id, `assignment-runs/${runId}/retry`),
                  {},
                );
                refresh();
              })
            }
            onStatus={(item, status) =>
              mutation.run(() =>
                refreshOnConflict(
                  () =>
                    post(
                      collectionPath(
                        project.id,
                        `assignments/${item.id}/status`,
                      ),
                      { status, version: item.version },
                    ),
                  refresh,
                ),
              )
            }
          />
        ) : (
          <p className="panel-note">
            {de
              ? "Noch keine Aufträge. Beschreibe im Chat, was Orbit regelmäßig für dich erledigen soll."
              : "No assignments yet. Describe in the chat what Orbit should do for you regularly."}
          </p>
        )}
      </section>
    </>
  );
}

const HANDED_OVER: [string, string] = [
  "Already handed over to Postiz – can only be removed there",
  "Bereits an Postiz übergeben – nur dort entfernbar",
];

/** What a Postiz draft delivery (R73) says per handoff status; it has no Stop. */
function draftNote(status: string, de: boolean) {
  if (status === "accepted")
    return de
      ? "Als Entwurf in Postiz angelegt. Orbit veröffentlicht ihn nicht – du veröffentlichst selbst. Zurückziehen nur in Postiz."
      : "Created as a draft in Postiz. Orbit does not publish it – you publish it yourself. Withdraw it in Postiz only.";
  if (status === "outcome_unknown")
    return de
      ? "Ergebnis der Übergabe unklar – bitte in Postiz prüfen. Orbit sendet ihn nicht erneut."
      : "Handoff outcome unclear – please check in Postiz. Orbit will not send it again.";
  return de
    ? "Wird als Entwurf an Postiz übergeben. Orbit veröffentlicht ihn nicht – du veröffentlichst selbst in Postiz."
    : "Being handed to Postiz as a draft. Orbit does not publish it – you publish it yourself in Postiz.";
}

/**
 * What still can be done about one upcoming post: its veto deadline (or
 * the owner's release, which has none) and Stop until the hand-off; for a
 * Postiz draft delivery, what happens to it. `compact` leaves out the
 * owner-release sentence where the release is already named.
 */
export function UpcomingPostControls({
  item,
  de,
  timezone,
  canStop,
  pending,
  handedOver,
  onStop,
  now = Date.now(),
  compact = false,
  stopLabel,
}: {
  item: UpcomingPost;
  de: boolean;
  timezone: string;
  canStop: boolean;
  pending: boolean;
  handedOver: string[];
  onStop: (post: UpcomingPost) => void;
  now?: number;
  compact?: boolean;
  /** The Stop button's accessible name when several are listed, e.g. "Stop – Instagram". */
  stopLabel?: string;
}) {
  const locale = de ? "de" : "en";
  if (item.delivery === "postiz_draft")
    return <p className="panel-note">{draftNote(item.status, de)}</p>;
  return (
    <>
      {item.vetoDeadline === null ? (
        // Released by the owner: no veto window, Stop works until the handoff.
        compact ? null : (
          <p className="panel-note">
            {de
              ? "Vom Owner freigegeben – kein Veto-Fenster."
              : "Released by the owner – no veto window."}
          </p>
        )
      ) : Date.parse(item.vetoDeadline) <= now ? (
        // Past the deadline but not claimed yet: Stop still works until the handoff.
        <p className="panel-note">
          {de
            ? "Frist abgelaufen – die Übergabe an Postiz steht bevor."
            : "Deadline passed – the handoff to Postiz is imminent."}
        </p>
      ) : (
        <p className="panel-note">
          {de ? "Stop möglich bis" : "Stop possible until"}{" "}
          <time dateTime={item.vetoDeadline}>
            {when(item.vetoDeadline, locale, timezone)}
          </time>
        </p>
      )}
      {handedOver.includes(item.id) ? (
        <Alert kind="warning">{HANDED_OVER[de ? 1 : 0]}</Alert>
      ) : (
        canStop && (
          <div className="form-actions">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              aria-label={stopLabel}
              onClick={() => onStop(item)}
            >
              Stop
            </Button>
          </div>
        )
      )}
    </>
  );
}

/** Upcoming assignment posts with their veto deadline and Stop. */
export function UpcomingPostList({
  items,
  de,
  timezone,
  canStop,
  pending,
  handedOver,
  onStop,
  now = Date.now(),
}: {
  items: UpcomingPost[];
  de: boolean;
  timezone: string;
  canStop: boolean;
  pending: boolean;
  handedOver: string[];
  onStop: (post: UpcomingPost) => void;
  // Render time in ms; a test passes a fixed one.
  now?: number;
}) {
  const locale = de ? "de" : "en";
  return (
    <section className="panel approval-list">
      <div className="panel-head">
        <div>
          <h3>{de ? "Anstehende Posts" : "Upcoming posts"}</h3>
          <p>
            {de
              ? "Posts aus Aufträgen gehen nach Ablauf des Veto-Fensters automatisch raus. Bis zur Übergabe an Postiz kannst du jeden hier oder im Telegram-Bot stoppen. Aufträge mit Zustellung als Entwurf legen nur Entwürfe in Postiz an; die veröffentlichst du selbst."
              : "Assignment posts go out automatically after their veto window. Until the handoff to Postiz you can stop each one here or in the Telegram bot. Assignments delivering drafts only create drafts in Postiz, which you publish yourself."}
          </p>
        </div>
      </div>
      {items.map((item) =>
        item.delivery === "postiz_draft" ? (
          <article key={item.id} className="approval-item">
            <p className="panel-note">
              {when(item.scheduledAt, locale, timezone)} ·{" "}
              {item.channelName ?? item.channel}
              {item.assignmentName && ` · ${item.assignmentName}`}{" "}
              <Badge
                tone={item.status === "outcome_unknown" ? "warning" : "blue"}
              >
                {de ? "Entwurf in Postiz" : "Draft in Postiz"}
              </Badge>
            </p>
            <pre className="approval-item-body">{item.excerpt}</pre>
            <p className="panel-note">{draftNote(item.status, de)}</p>
          </article>
        ) : (
          <article key={item.id} className="approval-item">
            <p className="panel-note">
              {when(item.scheduledAt, locale, timezone)} ·{" "}
              {item.channelName ?? item.channel}
              {item.assignmentName && ` · ${item.assignmentName}`}
              {item.status === "blocked_dependency" && (
                <>
                  {" "}
                  <Badge tone="warning">
                    {de ? "Blockiert" : "Blocked"}
                    {item.reason ? `: ${item.reason}` : ""}
                  </Badge>
                </>
              )}
            </p>
            <pre className="approval-item-body">{item.excerpt}</pre>
            <UpcomingPostControls
              item={item}
              de={de}
              timezone={timezone}
              canStop={canStop}
              pending={pending}
              handedOver={handedOver}
              onStop={onStop}
              now={now}
            />
          </article>
        ),
      )}
    </section>
  );
}

/**
 * Assignment drafts left for the owner (R70): the review left them, no bot
 * is linked, or agent review authority is off. Only an owner releases one;
 * the release schedules it at its run slot (or the next free one that day).
 */
/** Labels of the draft states on the approvals page (pending, expired, decided). */
export const DRAFT_STATE_LABELS: Record<
  DraftState,
  { de: string; en: string; tone: "warning" | "neutral" | "success" | "danger" }
> = {
  pending: { de: "Ausstehend", en: "Pending", tone: "warning" },
  expired: { de: "Abgelaufen", en: "Expired", tone: "neutral" },
  released: { de: "Freigegeben", en: "Released", tone: "success" },
  rejected: { de: "Abgelehnt", en: "Rejected", tone: "danger" },
  archived: { de: "Archiviert", en: "Archived", tone: "neutral" },
};

/** Readable texts of the refusals a release or decision can meet; others show their code. */
const DECISION_ERRORS: Record<string, [string, string]> = {
  OWNER_REQUIRED: [
    "Dafür fehlen dir die Rechte: Nur ein Owner des Projekts kann Entwürfe freigeben, ablehnen, verwerfen oder archivieren.",
    "You lack the permission: only a project owner can release, reject, discard or archive drafts.",
  ],
  FORBIDDEN: [
    "Dafür fehlen dir die Rechte in diesem Projekt.",
    "You lack the permission for this in this project.",
  ],
  SLOT_EXPIRED: [
    "Der Termin dieses Entwurfs ist vorbei und wird nicht nachgeholt. Lehne ihn ab oder archiviere ihn.",
    "This draft's slot has passed and is not caught up. Reject or archive it.",
  ],
  CONTENT_CLOSED: [
    "Dieser Entwurf wurde bereits abgelehnt oder archiviert und kann nicht mehr veröffentlicht werden.",
    "This draft was already rejected or archived and can no longer be published.",
  ],
  DRAFT_HAS_PUBLICATION: [
    "Dieser Entwurf ist bereits eingeplant. Stoppe den geplanten Post unter „Freigegeben & geplant“.",
    "This draft is already scheduled. Stop the planned post under “Released & scheduled”.",
  ],
  DRAFT_NOT_DECIDABLE: [
    "Dieser Entwurf wartet nicht mehr auf eine Entscheidung.",
    "This draft no longer waits for a decision.",
  ],
  VERSION_CONFLICT: [
    "Der Entwurf wurde inzwischen geändert. Die Ansicht ist aktualisiert, bitte erneut versuchen.",
    "The draft changed meanwhile. The view is refreshed, please try again.",
  ],
};

/** A refusal's code as a sentence the owner understands (codes without a text stay as they are). */
export function decisionErrorText(message: string, de: boolean) {
  const text = DECISION_ERRORS[message];
  return text ? text[de ? 0 : 1] : message;
}

/** Readable names for review findings an owner meets most; others show their code. */
const PROBLEM_LABELS: Record<string, [string, string]> = {
  BANNER_BRAND_MISMATCH: [
    "Bildstil passt nicht zum Brandkit",
    "Image does not match the brand kit",
  ],
  BANNER_IMAGE_MISSING: ["Banner fehlt", "Banner missing"],
  CREATIVE_QA_FAILED: ["Bildprüfung fehlgeschlagen", "Image check failed"],
};

function StateBadge({ state, de }: { state: DraftState; de: boolean }) {
  const label = DRAFT_STATE_LABELS[state];
  return <Badge tone={label.tone}>{de ? label.de : label.en}</Badge>;
}

/** The optional reason dialog of a rejection. */
function RejectDialog({
  de,
  pending,
  onCancel,
  onConfirm,
}: {
  de: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={de ? "Entwurf ablehnen" : "Reject draft"}
      description={
        de
          ? "Der Entwurf wird nicht veröffentlicht und kann später nicht erneut eingeplant werden. Er bleibt im Verlauf nachvollziehbar."
          : "The draft will not be published and cannot be scheduled again later. It stays traceable in the history."
      }
      onClose={onCancel}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="reject-reason">
            {de ? "Grund (optional)" : "Reason (optional)"}
          </FieldLabel>
          <Textarea
            id="reject-reason"
            maxLength={500}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              de
                ? "z. B. Bild passt nicht zur Marke"
                : "e.g. image does not match the brand"
            }
          />
        </Field>
      </FieldGroup>
      <div className="form-actions approval-actions">
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => onConfirm(reason.trim())}
        >
          {de ? "Ablehnen" : "Reject"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The owner's edit of a waiting draft (2026-11-11): one text for the draft,
 * or for every channel of a Facebook/Instagram pair. The draft keeps
 * waiting for the release; the release checks the edited text again.
 */
function EditDialog({
  de,
  pending,
  initial,
  onCancel,
  onConfirm,
}: {
  de: boolean;
  pending: boolean;
  initial: string;
  onCancel: () => void;
  onConfirm: (body: string) => void;
}) {
  const [body, setBody] = useState(initial);
  const text = body.trim();
  return (
    <Modal
      title={de ? "Entwurf bearbeiten" : "Edit draft"}
      description={
        de
          ? "Der Entwurf wartet danach weiter auf deine Freigabe. Bei der Freigabe prüft Orbit den geänderten Text erneut."
          : "The draft keeps waiting for your release. Orbit checks the changed text again when you release it."
      }
      onClose={onCancel}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-body">{de ? "Text" : "Text"}</FieldLabel>
          <Textarea
            id="edit-body"
            maxLength={40000}
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
      </FieldGroup>
      <div className="form-actions approval-actions">
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
        <Button
          disabled={pending || !text || text === initial.trim()}
          onClick={() => onConfirm(text)}
        >
          {de ? "Speichern" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}

/** Confirmation before a draft is discarded or archived (nothing is deleted). */
function ConfirmDialog({
  title,
  description,
  confirm,
  pending,
  onCancel,
  onConfirm,
  de,
}: {
  title: string;
  description: string;
  confirm: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  de: boolean;
}) {
  return (
    <Modal title={title} description={description} onClose={onCancel}>
      <div className="form-actions approval-actions">
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
        <Button disabled={pending} onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </Modal>
  );
}

type DraftDialog =
  | { kind: "reject"; item: AwaitingOwnerDraft }
  | { kind: "edit"; items: AwaitingOwnerDraft[] }
  | { kind: "discard" | "archive"; item: AwaitingOwnerDraft }
  | { kind: "archive-history"; item: DraftHistoryItem };

/** Drafts grouped by their original (R76 copies with it), in list order. */
export function draftGroups(items: AwaitingOwnerDraft[]) {
  const groups = new Map<string, AwaitingOwnerDraft[]>();
  for (const item of items) {
    const key = item.baseId ?? item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([baseId, members]) =>
    // The original first, then its copies.
    [...members].sort(
      (a, b) => Number(a.id !== baseId) - Number(b.id !== baseId),
    ),
  );
}

export function AwaitingOwnerDraftList({
  items,
  history = [],
  showArchived = false,
  onShowArchived,
  projectId,
  thumbnails = false,
  de,
  timezone,
  canRelease,
  pending,
  onRelease,
  onReject = () => {},
  onDiscard = () => {},
  onArchive = () => {},
  onEdit,
  heading,
  historyAs = "details",
  channelText = (item) => item.channelName ?? item.channel,
  channelName = channelText,
}: {
  items: AwaitingOwnerDraft[];
  /** The owner's recent decisions (released, rejected, archived). */
  history?: DraftHistoryItem[];
  /** Whether archived items are shown in the history. */
  showArchived?: boolean;
  onShowArchived?: (show: boolean) => void;
  /** Needed for the thumbnails of drafts with an image. */
  projectId: string;
  /** Thumbnails of drafts with an image (Creative Studio on; off, none, CS-D6). */
  thumbnails?: boolean;
  de: boolean;
  timezone: string;
  /** Whether the viewer may decide (owner); others see the actions disabled with the reason. */
  canRelease: boolean;
  pending: boolean;
  onRelease: (draft: AwaitingOwnerDraft) => void;
  onReject?: (draft: AwaitingOwnerDraft, reason: string) => void;
  onDiscard?: (draft: AwaitingOwnerDraft) => void;
  onArchive?: (draft: { id: string; version: number }) => void;
  /** The owner's edit of a waiting draft (every channel of a pair); absent, no edit is offered. */
  onEdit?: (drafts: AwaitingOwnerDraft[], body: string) => void;
  /** The panel's head; the default names the release, null leaves it out. */
  heading?: { title: string; text?: string } | null;
  /** "list": the history entries as a plain list (inside a history lane). */
  historyAs?: "details" | "list";
  /** A draft's channel in words (button labels; the page passes the channel list's names). */
  channelText?: (item: {
    channel: string;
    channelName: string | null;
  }) => string;
  /** A draft's channel as shown (the page adds the platform mark). */
  channelName?: (item: {
    channel: string;
    channelName: string | null;
  }) => ReactNode;
}) {
  const [dialog, setDialog] = useState<DraftDialog | null>(null);
  if (!items.length && !history.length) return null;
  const locale = de ? "de" : "en";
  const close = () => setDialog(null);
  const ownerNote = de
    ? "Nur ein Owner kann freigeben, ablehnen, verwerfen oder archivieren."
    : "Only an owner can release, reject, discard or archive.";
  const head =
    heading === undefined
      ? {
          title: de ? "Wartet auf deine Freigabe" : "Waiting for your release",
          text: de
            ? "Diese Entwürfe aus Aufträgen gehen erst raus, wenn ein Owner sie freigibt. Die Freigabe plant den Post zum Termin seines Laufs ein oder, wenn der belegt ist, zum nächsten freien Termin desselben Tages. Ein abgelaufener Termin wird nicht nachgeholt."
            : "These assignment drafts go out only once an owner releases them. Releasing schedules the post at its run's slot or, if that is taken, at the next free slot of the same day. A slot that has passed is not caught up.",
        }
      : heading;
  // The release, reject and discard (or archive) of one draft; in a group
  // each button also names its channel for screen readers.
  const actions = (item: AwaitingOwnerDraft, channel?: string) => {
    const state: DraftState = item.state ?? "pending";
    const named = (label: string) =>
      channel ? { "aria-label": `${label}: ${channel}` } : {};
    const release = de ? "Freigeben" : "Release";
    const reject = de ? "Ablehnen" : "Reject";
    const other =
      state === "expired"
        ? de
          ? "Archivieren"
          : "Archive"
        : de
          ? "Verwerfen"
          : "Discard";
    return (
      <div className="form-actions approval-actions">
        {state === "pending" && (
          <Button
            size="sm"
            disabled={pending || !canRelease}
            onClick={() => onRelease(item)}
            {...named(release)}
          >
            {release}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !canRelease}
          onClick={() => setDialog({ kind: "reject", item })}
          {...named(reject)}
        >
          {reject}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !canRelease}
          onClick={() =>
            setDialog({
              kind: state === "expired" ? "archive" : "discard",
              item,
            })
          }
          {...named(other)}
        >
          {other}
        </Button>
      </div>
    );
  };
  const notes = (item: AwaitingOwnerDraft) => {
    const state: DraftState = item.state ?? "pending";
    const concerns = item.concerns ?? [];
    return (
      <>
        {concerns.length > 0 && (
          <div className="panel-note approval-concerns" role="note">
            <p>{de ? "Orbit hat Bedenken:" : "Orbit has concerns:"}</p>
            <ul>
              {concerns.map((concern) => (
                <li key={concern}>{concern}</li>
              ))}
            </ul>
            {item.ownerEdited && (
              <p>
                {de
                  ? "Von dir bearbeitet: Die Bedenken betrafen die vorige Fassung."
                  : "Edited by you: the concerns were about the text before."}
              </p>
            )}
          </div>
        )}
        {item.delivery === "postiz_draft" && state === "pending" && (
          <p className="panel-note">
            {de
              ? "Zustellung als Entwurf: Die Freigabe legt ihn nur als Entwurf in Postiz an, zu seinem Termin. Veröffentlichen machst du selbst in Postiz."
              : "Draft delivery: releasing only creates it as a draft in Postiz, dated at its slot. You publish it yourself in Postiz."}
          </p>
        )}
        <p className="panel-note">
          {state === "expired"
            ? de
              ? "Der Termin ist vorbei. Er wird nicht nachgeholt: Lehne den Entwurf ab oder archiviere ihn."
              : "The slot has passed and is not caught up: reject or archive the draft."
            : item.agentApproved
              ? de
                ? "Vom Review-Agenten geprüft – ohne verbundenen Bot oder freigeschaltete Agenten-Freigabe entscheidest du."
                : "Checked by the review agent – without a linked bot or enabled agent approval, you decide."
              : concerns.length > 0
                ? de
                  ? "Orbit empfiehlt, ihn so nicht zu veröffentlichen. Du entscheidest: freigeben, bearbeiten oder ablehnen."
                  : "Orbit advises against publishing it as it is. You decide: release, edit or reject."
                : de
                  ? "Der Review-Agent hat diesen Entwurf an dich übergeben."
                  : "The review agent left this draft to you."}
        </p>
        {state === "pending" && item.waitingReason && (
          <div className="panel-note approval-waiting-reason">
            <ExceptionWords code={item.waitingReason} />
          </div>
        )}
      </>
    );
  };
  // The edit of one draft, or of every channel of a pair (one shared text).
  const editButton = (group: AwaitingOwnerDraft[]) =>
    onEdit && (group[0]!.state ?? "pending") === "pending" ? (
      <div className="form-actions approval-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !canRelease}
          onClick={() => setDialog({ kind: "edit", items: group })}
        >
          {de ? "Bearbeiten" : "Edit"}
        </Button>
      </div>
    ) : null;
  const problems = (codes: string[]) =>
    [...new Set(codes)].map((code) => (
      <span key={code} title={code}>
        {" "}
        <Badge tone="warning">
          {PROBLEM_LABELS[code]?.[de ? 0 : 1] ?? code}
        </Badge>
      </span>
    ));
  const thumbnail = (item: AwaitingOwnerDraft) =>
    thumbnails && item.assetId ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="approval-item-thumbnail"
        src={`/api/projects/${projectId}/assets/${item.assetId}/content`}
        alt={de ? "Bild des Entwurfs" : "Draft image"}
        width={160}
        loading="lazy"
      />
    ) : null;
  const historyEntries = history.map((entry) => (
    <article key={`${entry.state}:${entry.id}`} className="approval-item">
      <p className="panel-note approval-item-meta">
        <StateBadge state={entry.hidden ? "archived" : entry.state} de={de} />{" "}
        {entry.slotAt ? `${when(entry.slotAt, locale, timezone)} · ` : ""}
        {channelName(entry)}
        {entry.assignmentName && ` · ${entry.assignmentName}`}
      </p>
      <pre className="approval-item-body">{entry.excerpt}</pre>
      {entry.reason && (
        <p className="panel-note">
          {de ? "Grund" : "Reason"}: {entry.reason}
        </p>
      )}
      {entry.state !== "released" && !entry.hidden && (
        <div className="form-actions approval-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !canRelease}
            onClick={() => setDialog({ kind: "archive-history", item: entry })}
          >
            {de ? "Archivieren" : "Archive"}
          </Button>
        </div>
      )}
    </article>
  ));
  const archivedToggle = onShowArchived && (
    <label className="approval-history-toggle">
      <input
        type="checkbox"
        checked={showArchived}
        onChange={(e) => onShowArchived(e.target.checked)}
      />{" "}
      {de ? "Archivierte anzeigen" : "Show archived"}
    </label>
  );
  return (
    <section className="panel approval-list">
      {head && (
        <div className="panel-head">
          <div>
            <h3>{head.title}</h3>
            {head.text && <p>{head.text}</p>}
          </div>
        </div>
      )}
      {!canRelease && items.length > 0 && (
        <p className="panel-note" role="note">
          {ownerNote}
        </p>
      )}
      {draftGroups(items).map((group) => {
        const first = group[0]!;
        const state: DraftState = first.state ?? "pending";
        if (group.length === 1)
          return (
            <article key={first.id} className="approval-item">
              <p className="panel-note approval-item-meta">
                <StateBadge state={state} de={de} />{" "}
                {when(first.slotAt, locale, timezone)} · {channelName(first)}
                {first.assignmentName && ` · ${first.assignmentName}`}
                {problems(first.problems)}
              </p>
              {thumbnail(first)}
              <pre className="approval-item-body">{first.excerpt}</pre>
              {notes(first)}
              {editButton([first])}
              {actions(first)}
            </article>
          );
        // A Facebook/Instagram pair (R76): one text, one release per channel.
        return (
          <article key={first.baseId ?? first.id} className="approval-item">
            <p className="panel-note approval-item-meta">
              <StateBadge state={state} de={de} />{" "}
              {when(first.slotAt, locale, timezone)}
              {first.assignmentName && ` · ${first.assignmentName}`}
              {problems(group.flatMap((item) => item.problems))}
            </p>
            {thumbnail(first)}
            <pre className="approval-item-body">{first.excerpt}</pre>
            {notes(first)}
            {editButton(group)}
            <ul className="approval-variants">
              {group.map((item) => {
                const label = channelText(item);
                return (
                  <li key={item.id} className="approval-variant">
                    <span className="approval-item-meta">
                      {(item.state ?? "pending") !== state && (
                        <StateBadge state={item.state ?? "pending"} de={de} />
                      )}
                      {channelName(item)}
                      {item.slotAt !== first.slotAt &&
                        ` · ${when(item.slotAt, locale, timezone)}`}
                    </span>
                    {actions(item, label)}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
      {historyAs === "list" ? (
        <>
          {archivedToggle}
          {historyEntries}
        </>
      ) : history.length > 0 || showArchived ? (
        <details className="approval-history">
          <summary>
            {de ? "Verlauf" : "History"} ({history.length})
          </summary>
          {archivedToggle}
          {historyEntries}
        </details>
      ) : null}
      {dialog?.kind === "edit" && onEdit && (
        <EditDialog
          de={de}
          pending={pending}
          initial={dialog.items[0]!.body ?? dialog.items[0]!.excerpt}
          onCancel={close}
          onConfirm={(body) => {
            onEdit(dialog.items, body);
            close();
          }}
        />
      )}
      {dialog?.kind === "reject" && (
        <RejectDialog
          de={de}
          pending={pending}
          onCancel={close}
          onConfirm={(reason) => {
            onReject(dialog.item, reason);
            close();
          }}
        />
      )}
      {(dialog?.kind === "discard" ||
        dialog?.kind === "archive" ||
        dialog?.kind === "archive-history") && (
        <ConfirmDialog
          de={de}
          pending={pending}
          title={
            dialog.kind === "discard"
              ? de
                ? "Entwurf verwerfen?"
                : "Discard draft?"
              : de
                ? "Aus der Übersicht archivieren?"
                : "Archive from the overview?"
          }
          description={
            dialog.kind === "discard"
              ? de
                ? "Der Entwurf wird aus dem aktiven Ablauf entfernt und nicht veröffentlicht. Er wird nicht gelöscht: Verlauf und Prüfprotokoll bleiben erhalten."
                : "The draft leaves the active workflow and is not published. It is not deleted: history and audit records stay."
              : de
                ? "Die Anfrage verschwindet aus der aktiven Übersicht. Unter „Archivierte anzeigen“ bleibt sie nachvollziehbar; nichts wird gelöscht."
                : "The request leaves the active overview. It stays traceable under “Show archived”; nothing is deleted."
          }
          confirm={
            dialog.kind === "discard"
              ? de
                ? "Verwerfen"
                : "Discard"
              : de
                ? "Archivieren"
                : "Archive"
          }
          onCancel={close}
          onConfirm={() => {
            if (dialog.kind === "discard") onDiscard(dialog.item);
            else onArchive(dialog.item);
            close();
          }}
        />
      )}
    </section>
  );
}

/**
 * Approvals page data of Orbit Agents (spec §10 fallback, R70): upcoming
 * assignment posts with Stop, independent of Telegram delivery, the drafts
 * that wait for the owner's release and the owner's recent decisions, with
 * the release, decisions and Stop. `off` while Orbit Agents is off (404).
 */
export function useAssignmentApprovals() {
  const { project, revision, refresh } = useWorkspace();
  const posts = useResource<{ items: UpcomingPost[] }>(
    collectionPath(project.id, `assignment-posts?revision=${revision}`),
  );
  const [showArchived, setShowArchived] = useState(false);
  const waiting = useResource<{
    items: AwaitingOwnerDraft[];
    history?: DraftHistoryItem[];
  }>(
    collectionPath(
      project.id,
      `assignment-drafts?revision=${revision}${showArchived ? "&archived=true" : ""}`,
    ),
  );
  const known = useKnownData(project.id, posts.data, posts.error);
  const knownDrafts = useKnownData(
    `${project.id}:drafts`,
    waiting.data,
    waiting.error,
  );
  const [handedOver, setHandedOver] = useState<string[]>([]);
  const mutation = useMutation();
  // The owner's reject, discard or archive of one draft; nothing is deleted.
  const decide = (
    item: { id: string; version: number },
    decision: "reject" | "discard" | "archive",
    extra: { reason?: string } = {},
  ) =>
    mutation.run(async () => {
      await refreshOnConflict(
        () =>
          post(
            collectionPath(
              project.id,
              `assignment-drafts/${item.id}/${decision}`,
            ),
            { version: item.version, ...extra },
          ),
        refresh,
      );
      refresh();
    });
  const release = (item: { id: string; version: number }) =>
    mutation.run(async () => {
      await refreshOnConflict(
        () =>
          post(
            collectionPath(project.id, `assignment-drafts/${item.id}/release`),
            { version: item.version },
          ),
        refresh,
      );
      refresh();
    });
  // The owner's edit (2026-11-11): the same text for every channel of a pair.
  const edit = (items: Array<{ id: string; version: number }>, body: string) =>
    mutation.run(async () => {
      for (const item of items)
        await refreshOnConflict(
          () =>
            post(
              collectionPath(project.id, `assignment-drafts/${item.id}/edit`),
              { version: item.version, body },
            ),
          refresh,
        );
      refresh();
    });
  const stop = (item: { id: string; version: number }) =>
    mutation.run(async () => {
      const { result } = await refreshOnConflict(
        () =>
          post<{
            result: "vetoed" | "already_handed_over" | "not_found";
          }>(collectionPath(project.id, `publications/${item.id}/veto`), {
            version: item.version,
          }),
        refresh,
      );
      if (result === "already_handed_over")
        setHandedOver((ids) => [...ids, item.id]);
      else refresh();
    });
  const error =
    (!agentsOff(posts.error) && posts.error) ||
    (!agentsOff(waiting.error) && waiting.error) ||
    null;
  return {
    off: agentsOff(posts.error) && agentsOff(waiting.error),
    error,
    posts: known?.items ?? [],
    drafts: knownDrafts?.items ?? [],
    history: knownDrafts?.history ?? [],
    showArchived,
    setShowArchived,
    handedOver,
    mutation,
    decide,
    release,
    edit,
    stop,
  };
}
