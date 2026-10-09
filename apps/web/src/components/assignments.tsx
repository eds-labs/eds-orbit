"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
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
  channelText,
  contentTypeLabels,
  scheduleText,
  statusTone,
  type AssignmentContent,
} from "./assignment-card";
import { Alert, Badge, Button, Loading } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

/** One row of `GET /assignments`. */
export type AssignmentItem = Pick<
  AssignmentContent,
  "id" | "name" | "kind" | "contentType" | "channels" | "channelNames" | "image"
> & {
  version: number;
  status: string;
  schedule: AssignmentContent["schedule"];
  vetoMinutes: number;
  nextRunAt: string | null;
  monthCostMicros: number;
  monthlyBudgetMicros: number;
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
  vetoDeadline: string;
  excerpt: string;
  assignmentId: string | null;
  assignmentName: string | null;
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
 * The project's assignments; `available` stays true once the route answered
 * and turns false on a 404 (Orbit Agents off), so the page hides the tab.
 */
export function useAssignments() {
  const { project, revision } = useWorkspace();
  const resource = useResource<AssignmentList>(
    collectionPath(project.id, `assignments?revision=${revision}`),
  );
  const data = useKnownData(project.id, resource.data, resource.error);
  return {
    resource,
    data,
    available:
      data !== null || (resource.error !== null && !agentsOff(resource.error)),
  };
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
}: {
  items: AssignmentItem[];
  de: boolean;
  timezone: string;
  role: Role;
  pending: boolean;
  onStatus: (item: AssignmentItem, status: NextStatus) => void;
}) {
  const [ending, setEnding] = useState("");
  const locale = de ? "de" : "en";
  const editor = role !== "viewer";
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{de ? "Auftrag" : "Assignment"}</th>
            <th>Status</th>
            <th>{de ? "Nächste Vorbereitung" : "Next preparation"}</th>
            <th>{de ? "Kosten diesen Monat" : "Cost this month"}</th>
            <th>
              <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
            </th>
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
                  {item.status === "draft" && item.actionRequestId && (
                    <small>
                      {de ? "Bestätigung offen" : "Confirmation open"} ·{" "}
                      <Link href="/approvals">
                        {de ? "Freigaben" : "Approvals"}
                      </Link>
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
                </td>
                <td>
                  {editor && item.status !== "ended" && (
                    <div className="form-actions">
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
export function Assignments({
  resource,
  data,
}: {
  resource: ReturnType<typeof useAssignments>["resource"];
  // The last answer, kept while the list reloads.
  data: AssignmentList | null;
}) {
  const { locale, project, isOwner, canEdit, refresh } = useWorkspace();
  const de = locale === "de";
  const mutation = useMutation(refresh);
  const role: Role = isOwner ? "owner" : canEdit ? "editor" : "viewer";
  const items = data?.items ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{de ? "Aufträge" : "Assignments"}</h2>
          <p>
            {de
              ? "Was Orbit für dich verfolgt. Neue Aufträge und Änderungen besprichst du im Orbit Chat; jede Änderung braucht eine neue Bestätigung."
              : "What Orbit pursues for you. Create and change assignments in the Orbit chat; every change needs a new confirmation."}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/chat">{de ? "Im Chat ändern" : "Change in chat"}</Link>
        </Button>
      </div>
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
          onStatus={(item, status) =>
            mutation.run(() =>
              refreshOnConflict(
                () =>
                  post(
                    collectionPath(project.id, `assignments/${item.id}/status`),
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
  );
}

const HANDED_OVER: [string, string] = [
  "Already handed over to Postiz – can only be removed there",
  "Bereits an Postiz übergeben – nur dort entfernbar",
];

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
    <section className="panel autopilot-approvals">
      <div className="panel-head">
        <div>
          <h2>{de ? "Anstehende Posts" : "Upcoming posts"}</h2>
          <p>
            {de
              ? "Posts aus Aufträgen gehen nach Ablauf des Veto-Fensters automatisch raus. Bis zur Übergabe an Postiz kannst du jeden hier oder im Telegram-Bot stoppen."
              : "Assignment posts go out automatically after their veto window. Until the handoff to Postiz you can stop each one here or in the Telegram bot."}
          </p>
        </div>
      </div>
      {items.map((item) => (
        <article key={item.id} className="autopilot-approval">
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
          <pre className="autopilot-approval-body">{item.excerpt}</pre>
          {Date.parse(item.vetoDeadline) <= now ? (
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
                  onClick={() => onStop(item)}
                >
                  Stop
                </Button>
              </div>
            )
          )}
        </article>
      ))}
    </section>
  );
}

/**
 * Approvals page fallback (spec §10): upcoming assignment posts with Stop,
 * independent of Telegram delivery. Hidden while Orbit Agents is off or
 * nothing is upcoming.
 */
export function UpcomingAssignmentPosts() {
  const { locale, project, revision, canEdit, refresh } = useWorkspace();
  const de = locale === "de";
  const posts = useResource<{ items: UpcomingPost[] }>(
    collectionPath(project.id, `assignment-posts?revision=${revision}`),
  );
  const known = useKnownData(project.id, posts.data, posts.error);
  const [handedOver, setHandedOver] = useState<string[]>([]);
  const mutation = useMutation();
  const items = known?.items ?? [];
  if (agentsOff(posts.error) || (!items.length && !posts.error)) return null;
  return (
    <>
      {posts.error && <Alert kind="error">{posts.error.message}</Alert>}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {items.length > 0 && (
        <UpcomingPostList
          items={items}
          de={de}
          timezone={project.timezone}
          canStop={canEdit}
          pending={mutation.pending}
          handedOver={handedOver}
          onStop={(item) =>
            mutation.run(async () => {
              const { result } = await refreshOnConflict(
                () =>
                  post<{
                    result: "vetoed" | "already_handed_over" | "not_found";
                  }>(
                    collectionPath(project.id, `publications/${item.id}/veto`),
                    { version: item.version },
                  ),
                refresh,
              );
              if (result === "already_handed_over")
                setHandedOver((ids) => [...ids, item.id]);
              else refresh();
            })
          }
        />
      )}
    </>
  );
}

/** One answer of `GET /assignments/autopilot-migration`. */
export type AutopilotMigration = {
  proposal: Omit<AssignmentContent, "id"> | null;
  channelNames: Record<string, string>;
  assignment: {
    id: string;
    status: string;
    actionRequestId: string | null;
  } | null;
};

/**
 * The autopilot migration offer. `available` is true once the route answered
 * (Orbit Agents on) and false on a 404; `settled` says an answer exists at all.
 */
export function useAutopilotMigration() {
  const { project, revision } = useWorkspace();
  const resource = useResource<AutopilotMigration>(
    collectionPath(
      project.id,
      `assignments/autopilot-migration?revision=${revision}`,
    ),
  );
  const data = useKnownData(project.id, resource.data, resource.error);
  return {
    resource,
    data,
    available:
      data !== null || (resource.error !== null && !agentsOff(resource.error)),
    settled: data !== null || resource.error !== null,
  };
}

/**
 * The migration card (spec D5): the saved autopilot settings as a proposed
 * assignment. Proposing creates a draft with an owner confirmation; nothing
 * runs before that. Hidden when there is nothing to offer or the proposed
 * assignment was confirmed.
 */
export function AutopilotMigrationView({
  state,
  de,
  canPropose,
  pending,
  onPropose,
}: {
  state: AutopilotMigration;
  de: boolean;
  canPropose: boolean;
  pending: boolean;
  onPropose: () => void;
}) {
  const { proposal, assignment } = state;
  if (assignment ? assignment.status !== "draft" : !proposal) return null;
  return (
    <section className="panel autopilot-migration">
      <div className="panel-head">
        <div>
          <h2>
            {de
              ? "Autopilot als Auftrag übernehmen"
              : "Take over the autopilot as an assignment"}
          </h2>
          <p>
            {de
              ? "Aufträge ersetzen den wöchentlichen Autopilot. Orbit schlägt deine gespeicherten Autopilot-Einstellungen als Auftrag vor; er läuft erst, wenn ein Owner ihn bestätigt. Die Autopilot-Einstellungen bleiben unverändert."
              : "Assignments replace the weekly autopilot. Orbit proposes your saved autopilot settings as an assignment; it runs only after an owner confirms it. The autopilot settings stay unchanged."}
          </p>
        </div>
      </div>
      {assignment ? (
        <p className="panel-note">
          {de
            ? "Vorschlag erstellt – die Bestätigung ist offen unter"
            : "Proposal created – its confirmation is open under"}{" "}
          <Link href="/approvals">{de ? "Freigaben" : "Approvals"}</Link>.
        </p>
      ) : (
        proposal && (
          <>
            <dl className="detail-grid">
              <dt>{de ? "Kanäle" : "Channels"}</dt>
              <dd>
                {channelText(
                  {
                    channels: proposal.channels,
                    channelNames: state.channelNames,
                  },
                  de,
                )}
              </dd>
              <dt>{de ? "Rhythmus" : "Schedule"}</dt>
              <dd>{scheduleText(proposal.schedule, de)}</dd>
              <dt>{de ? "Themenrahmen" : "Topic frame"}</dt>
              <dd>{proposal.topicFrame}</dd>
              <dt>{de ? "Bild" : "Image"}</dt>
              <dd>
                {proposal.image
                  ? de
                    ? "Ja, im Stil der Autopilot-Bilder"
                    : "Yes, in the style of the autopilot images"
                  : de
                    ? "Nein"
                    : "No"}
              </dd>
              <dt>{de ? "Budget pro Monat" : "Monthly budget"}</dt>
              <dd>{usd(proposal.monthlyBudgetMicros)}</dd>
            </dl>
            {canPropose && (
              <div className="form-actions">
                <Button disabled={pending} onClick={onPropose}>
                  {de ? "Als Auftrag vorschlagen" : "Propose as an assignment"}
                </Button>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

/** The migration card for a loaded offer; proposing reloads the page data. */
export function AutopilotMigrationCard({
  migration,
}: {
  migration: ReturnType<typeof useAutopilotMigration>;
}) {
  const { locale, project, canEdit, refresh } = useWorkspace();
  const mutation = useMutation(refresh);
  if (!migration.data) return null;
  return (
    <>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <AutopilotMigrationView
        state={migration.data}
        de={locale === "de"}
        canPropose={canEdit}
        pending={mutation.pending}
        onPropose={() =>
          mutation.run(() =>
            post(
              collectionPath(project.id, "assignments/autopilot-migration"),
              {},
            ),
          )
        }
      />
    </>
  );
}

/** The migration card with its own data, for the assignments tab. */
export function AutopilotMigrationPanel() {
  return <AutopilotMigrationCard migration={useAutopilotMigration()} />;
}
