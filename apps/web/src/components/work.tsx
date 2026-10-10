"use client";
import {
  approveEach,
  autopilotApprovals,
  openExceptions,
  pausedPosts,
} from "./autopilot-approvals";
import { CalendarBlocks, calendarBlockConflicts } from "./calendar-blocks";
import { approvalItems } from "./draft-cleanup";
import { DraftCleanup } from "./draft-cleanup-panel";
import {
  AdaptationDialog,
  BriefProposalDialog,
  CommunityQuestions,
  type BriefProposal,
} from "./editorial";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Target,
  Eye,
  CircleCheck,
  FileText,
  Link2,
  Wallet,
  Plus,
  ArrowRight,
  Play,
  Pause,
  Search,
  CalendarDays,
  BookOpen,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import {
  action,
  api,
  collectionPath,
  post,
  useMutation,
  useResource,
  value,
  when,
  usd,
  type Dashboard,
  type Entity,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { actionLabel, actionOrder, blockerReason } from "@/lib/readiness-text";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  Status,
  Input,
} from "./ui/primitives";
import {
  DataForm,
  csv,
  iso,
  num,
  options,
  str,
  dateField,
  type FormField,
  type FormValues,
} from "./form";
import { CreativeRenderer } from "./advanced";
import { useWorkspace } from "./workspace-context";
import { ActionRequestInbox } from "./action-request-inbox";
import { AgentActivityPanel } from "./agent-activity";
import {
  AutopilotMigrationCard,
  UpcomingAssignmentPosts,
  useAutopilotMigration,
} from "./assignments";
export function useCollection(name: string) {
  const { project, revision } = useWorkspace();
  return useResource<{ items: Entity[] }>(
    collectionPath(project.id, `${name}?revision=${revision}`),
  );
}
export function PageHead({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function ResourceError({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  return error ? (
    <Alert kind="error">
      <p>{error.message}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        Try again
      </Button>
    </Alert>
  ) : null;
}
export function Overview() {
  const { project, t, locale, revision, canEdit } = useWorkspace();
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const missions = useCollection("missions");
  const [create, setCreate] = useState(false);
  const d = dashboard.data;
  return (
    <>
      <PageHead title={t("heading")} description={t("subtitle")}>
        {canEdit && (
          <Button onClick={() => setCreate(true)}>
            <Plus data-icon="inline-start" />
            {t("newMission")}
          </Button>
        )}
      </PageHead>
      <ResourceError error={dashboard.error} retry={dashboard.refresh} />
      {dashboard.loading ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="mode-band">
              <div className="mode-icon">
                {d.project.paused ? <Pause /> : <Eye />}
              </div>
              <div>
                <h2>
                  {d.project.paused
                    ? t("paused")
                    : d.project.mode === "observe"
                      ? t("observe")
                      : d.project.mode}
                </h2>
                <p className="mode-desktop-copy">
                  {d.project.mode === "observe"
                    ? t("observeHint")
                    : locale === "de"
                      ? "Jede Aktion wird vor Ausführung gegen das aktuelle Mandat geprüft."
                      : "Every action is checked against the current mandate before execution."}
                </p>
                <p className="mode-mobile-copy">
                  {d.project.paused
                    ? locale === "de"
                      ? "Alle Aktionen pausiert."
                      : "All actions paused."
                    : d.project.mode === "observe"
                      ? locale === "de"
                        ? "Externes Publizieren ist aus."
                        : "External publishing is off."
                      : locale === "de"
                        ? "Mandat wird vor Ausführung geprüft."
                        : "Mandate checked before execution."}
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href="/settings">{t("reviewSetup")}</Link>
              </Button>
            </div>
            <div className="metrics-strip">
              <Metric
                icon={Target}
                label={t("activeMissions")}
                amount={
                  missions.data
                    ? String(
                        missions.data.items.filter((mission) =>
                          ["active", "running", "queued"].includes(
                            String(mission.data.status),
                          ),
                        ).length,
                      )
                    : "—"
                }
              />
              <Metric
                icon={FileText}
                label={t("decisions")}
                amount={String(
                  d.exceptions.filter(
                    (exception) => exception.data.status === "open",
                  ).length,
                )}
              />
              <Metric
                icon={Wallet}
                label={t("approvedSpend")}
                amount={usd(d.budget.dailyLimitMicros)}
                detail={
                  d.budget.dailyLimitMicros === null
                    ? t("noBudget")
                    : `${usd(d.budget.spentMicros)} ${locale === "de" ? "verbraucht" : "spent"} · ${usd(d.budget.reservedMicros)} ${locale === "de" ? "reserviert" : "reserved"}`
                }
              />
            </div>
            <AgentActivityPanel />
            <div className="overview-columns">
              <section className="panel">
                <div className="panel-head">
                  <h2>{t("missionControl")}</h2>
                  <Link className="text-link" href="/missions">
                    {t("viewAll")}
                    <ArrowRight />
                  </Link>
                </div>
                {missions.data?.items.length ? (
                  <div className="data-list">
                    {missions.data.items.slice(0, 4).map((m) => (
                      <Link className="data-row" key={m.id} href="/missions">
                        <Target />
                        <div>
                          <strong>{value(m, "title")}</strong>
                          <p>{value(m, "goal")}</p>
                        </div>
                        <Status value={m.data.status} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title={t("startMission")}
                    description={t("missionHint")}
                    icon={Target}
                  >
                    {canEdit && (
                      <Button onClick={() => setCreate(true)}>
                        {t("createMission")}
                      </Button>
                    )}
                  </Empty>
                )}
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>{t("readiness")}</h2>
                  <Status value={d.readiness.state} />
                </div>
                <div className="readiness-list">
                  <Readiness
                    icon={CircleCheck}
                    label={t("projectCreated")}
                    status={t("complete")}
                    ready
                    href="/settings"
                  />
                  <Readiness
                    icon={FileText}
                    label={t("facts")}
                    status={
                      (d.counts.verifiedFacts ?? 0) > 0
                        ? t("complete")
                        : t("required")
                    }
                    ready={(d.counts.verifiedFacts ?? 0) > 0}
                    href="/knowledge"
                  />
                  <Readiness
                    icon={Link2}
                    label={t("channels")}
                    status={
                      (d.counts.connectedConnectors ?? 0) > 0
                        ? t("complete")
                        : t("notConfigured")
                    }
                    ready={(d.counts.connectedConnectors ?? 0) > 0}
                    href="/connectors"
                  />
                  <Readiness
                    icon={Wallet}
                    label={t("spend")}
                    status={
                      d.budget.dailyLimitMicros !== null
                        ? t("complete")
                        : t("notConfigured")
                    }
                    ready={d.budget.dailyLimitMicros !== null}
                    href="/settings"
                  />
                </div>
                {d.readiness.actions && (
                  <ActionReadinessList
                    actions={d.readiness.actions}
                    locale={locale}
                  />
                )}
              </section>
            </div>
            <section className="panel activity-panel">
              <div className="panel-head">
                <h2>{t("recent")}</h2>
                <Link className="text-link" href="/operations">
                  {t("viewAll")}
                  <ArrowRight />
                </Link>
              </div>
              {d.jobs.length ? (
                <EntityRows
                  items={d.jobs.slice(0, 5)}
                  fields={["topic", "status", "createdAt"]}
                />
              ) : (
                <Empty
                  title={t("emptyActivity")}
                  description={t("activityHint")}
                  icon={FileText}
                />
              )}
            </section>
          </>
        )
      )}
      {create && <MissionEditor onClose={() => setCreate(false)} />}
    </>
  );
}
function Metric({
  icon: Icon,
  label,
  amount,
  detail,
}: {
  icon: typeof Target;
  label: string;
  amount: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">
        <Icon />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{amount}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}
function Readiness({
  icon: Icon,
  label,
  status,
  ready = false,
  href,
}: {
  icon: typeof Target;
  label: string;
  status: string;
  ready?: boolean;
  href: string;
}) {
  return (
    <Link href={href} className="readiness-row">
      <Icon />
      <span>{label}</span>
      <Badge tone={ready ? "success" : "neutral"}>{status}</Badge>
    </Link>
  );
}
function ActionReadinessList({
  actions,
  locale,
}: {
  actions: NonNullable<Dashboard["readiness"]["actions"]>;
  locale: Locale;
}) {
  const groups = [
    ["internal", locale === "de" ? "Intern" : "Internal"],
    ["external", locale === "de" ? "Extern" : "External"],
  ] as const;
  return (
    <div className="action-readiness">
      {groups.map(([effect, heading]) => (
        <div key={effect}>
          <h3>{heading}</h3>
          <ul>
            {actionOrder
              .filter((name) => actions[name]?.effect === effect)
              .map((name) => {
                const action = actions[name]!;
                return (
                  <li key={name} data-action={name}>
                    <div>
                      <strong>{actionLabel(locale, name)}</strong>
                      {action.blockers.length > 0 && (
                        <p>
                          {action.blockers
                            .map((code) => blockerReason(locale, code))
                            .join(" ")}
                        </p>
                      )}
                    </div>
                    <Status value={action.state} />
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}
export function EntityRows({
  items,
  fields,
  onSelect,
}: {
  items: Entity[];
  fields: string[];
  onSelect?: (e: Entity) => void;
}) {
  const { locale, project, t } = useWorkspace();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f}>{f.replace(/([A-Z])/g, " $1")}</th>
            ))}
            {onSelect && (
              <th>
                <span className="sr-only">{t("review")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              {fields.map((f, i) => (
                <td key={f}>
                  {f === "status" ? (
                    <Status value={e.data.status} />
                  ) : f === "createdAt" || f === "updatedAt" ? (
                    when(e[f], locale, project.timezone)
                  ) : i === 0 && onSelect ? (
                    <button className="row-button" onClick={() => onSelect(e)}>
                      {value(
                        e,
                        f,
                        f === "title" && e.kind === "insights"
                          ? "Performance insight"
                          : "—",
                      )}
                    </button>
                  ) : (
                    value(e, f)
                  )}
                </td>
              ))}
              {onSelect && (
                <td>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("review")} ${value(e, fields[0])}`}
                    onClick={() => onSelect(e)}
                  >
                    <ArrowRight />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Missions() {
  const { t, locale, project, canEdit, isOwner, refresh } = useWorkspace();
  const resource = useCollection("missions");
  const [create, setCreate] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const [brief, setBrief] = useState(false),
    [proposal, setProposal] = useState<BriefProposal | undefined>(),
    [liveDraftConfirm, setLiveDraftConfirm] = useState(false),
    [batchConfirm, setBatchConfirm] = useState(false);
  const [showArchived, setShowArchived] = useState(false),
    [page, setPage] = useState(0);
  const mutation = useMutation(refresh);
  const pageSize = 20;
  const visible = (resource.data?.items ?? []).filter(
    (item) => (item.data.status === "archived") === showArchived,
  );
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <PageHead
        title={t("missions")}
        description={
          locale === "de"
            ? "Klare Ziele. Begrenzte Arbeit. Belegbare Ergebnisse."
            : "Clear objectives. Bounded work. Traceable outcomes."
        }
      >
        {canEdit && (
          <Button variant="outline" onClick={() => setBrief(true)}>
            Start from a brief
          </Button>
        )}
        {canEdit && (
          <Button
            onClick={() => {
              setProposal(undefined);
              setCreate(true);
            }}
          >
            <Plus data-icon="inline-start" />
            {t("newMission")}
          </Button>
        )}
      </PageHead>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="list-toolbar">
            <label className="list-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => {
                  setShowArchived(event.target.checked);
                  setPage(0);
                }}
              />
              <span>
                {locale === "de" ? "Archivierte anzeigen" : "Show archived"}
              </span>
            </label>
            {pages > 1 && (
              <div className="list-pager">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  {locale === "de" ? "Zurück" : "Previous"}
                </Button>
                <span>
                  {current + 1} / {pages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  {locale === "de" ? "Weiter" : "Next"}
                </Button>
              </div>
            )}
          </div>
          {visible.length ? (
            <EntityRows
              items={visible.slice(
                current * pageSize,
                (current + 1) * pageSize,
              )}
              fields={["title", "audience", "status", "createdAt"]}
              onSelect={(item) => {
                setSelected(item);
                setLiveDraftConfirm(false);
              }}
            />
          ) : showArchived ? (
            <Empty
              title={
                locale === "de"
                  ? "Keine archivierten Missionen"
                  : "No archived missions"
              }
              description={
                locale === "de"
                  ? "Archivierte Missionen erscheinen hier."
                  : "Archived missions appear here."
              }
              icon={Target}
            />
          ) : (
            <Empty
              title={t("startMission")}
              description={t("missionHint")}
              icon={Target}
            >
              {canEdit && (
                <Button onClick={() => setCreate(true)}>
                  {t("createMission")}
                </Button>
              )}
            </Empty>
          )}
        </section>
      )}
      {brief && (
        <BriefProposalDialog
          onClose={() => setBrief(false)}
          onUse={(p) => {
            setProposal(p);
            setBrief(false);
            setCreate(true);
          }}
        />
      )}
      {create && (
        <MissionEditor initial={proposal} onClose={() => setCreate(false)} />
      )}
      {selected && (
        <Modal
          title={value(selected, "title")}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="detail-summary">
            <Status value={selected.data.status} />
            <span>Version {selected.version}</span>
          </div>
          <p className="prose">{value(selected, "goal")}</p>
          <dl className="detail-grid">
            <dt>{locale === "de" ? "Zielgruppe" : "Audience"}</dt>
            <dd>{value(selected, "audience")}</dd>
            <dt>{locale === "de" ? "Zeitraum" : "Period"}</dt>
            <dd>
              {when(selected.data.startAt, locale, project.timezone)} —{" "}
              {when(selected.data.endAt, locale, project.timezone)}
            </dd>
            <dt>{locale === "de" ? "Zielaktion" : "Target action"}</dt>
            <dd>{value(selected, "targetAction")}</dd>
            <dt>Channels</dt>
            <dd>{value(selected, "channels")}</dd>
            <dt>Maximum content packages</dt>
            <dd>{value(selected, "maxContents")}</dd>
            {batchOf(selected) && (
              <>
                <dt>{locale === "de" ? "Entwurfsstapel" : "Draft batch"}</dt>
                <dd>
                  {Number(selected.data.completedRuns ?? 0)} /{" "}
                  {batchOf(selected)!.size}{" "}
                  {locale === "de" ? "erstellt" : "created"} ·{" "}
                  {locale === "de" ? "max." : "max"}{" "}
                  {usd(batchOf(selected)!.costCeilingMicros)} ·{" "}
                  <Status value={batchOf(selected)!.status} />
                </dd>
              </>
            )}
          </dl>
          <Alert>
            Runs use your current knowledge, permissions and cost limits.
            External publishing remains governed separately.
          </Alert>
          {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
          {mutation.success && (
            <Alert kind="success">
              Mission job queued. Follow its actual state in Operations.
            </Alert>
          )}
          {isOwner &&
            selected.data.status === "ready" &&
            selected.data.maxContents === 1 &&
            typeof selected.data.startAt === "string" &&
            typeof selected.data.chatProposalId === "string" &&
            typeof selected.data.endAt === "string" &&
            Date.parse(selected.data.endAt) > Date.now() && (
              <div>
                <Alert>
                  {Date.parse(selected.data.startAt) > Date.now()
                    ? locale === "de"
                      ? "Einmaliger interner Live-Draft mit der aktiven Kosten-Policy. Der bestehende Job startet jetzt mit höchstens einem Versuch. Kein Review, Zeitplan oder externer Post."
                      : "One internal live draft under the active cost policy. The existing job starts now with at most one attempt. No review, schedule, or external post."
                    : locale === "de"
                      ? "Nur wenn der ursprüngliche Job nach genau einem Evidence-Fehler blockiert ist und keine Kosten oder Inhalte entstanden sind, wird ein neuer interner Job mit genau einem Versuch angelegt. Kein Review, Zeitplan oder externer Post."
                      : "Only when the original job was blocked after one evidence failure with no cost or content will a new internal single-attempt job be queued. No review, schedule, or external post."}
                </Alert>
                <label className="review-confirm">
                  <Input
                    type="checkbox"
                    checked={liveDraftConfirm}
                    onChange={(event) =>
                      setLiveDraftConfirm(event.target.checked)
                    }
                  />
                  <span>
                    {locale === "de"
                      ? "Ich bestätige genau einen kostenpflichtigen internen Draft-Lauf ohne Retry."
                      : "I confirm exactly one paid internal draft run without retry."}
                  </span>
                </label>
                <Button
                  disabled={mutation.pending || !liveDraftConfirm}
                  onClick={async () => {
                    const result = await mutation.run(() =>
                      action(project.id, "start-approved-live-draft-once", {
                        missionId: selected.id,
                        version: selected.version,
                        confirmPaidInternalDraft: true,
                      }),
                    );
                    if (result) setLiveDraftConfirm(false);
                  }}
                >
                  <Play data-icon="inline-start" />
                  {locale === "de"
                    ? "Einmaligen Live-Draft jetzt starten"
                    : "Start one live draft now"}
                </Button>
              </div>
            )}
          {isOwner &&
            selected.data.status === "ready" &&
            !selected.data.batch &&
            Number(selected.data.maxContents) >= 2 &&
            Number(selected.data.maxContents) <= 5 &&
            typeof selected.data.chatProposalId === "string" &&
            Number.isSafeInteger(selected.data.chatCostCeilingMicros) &&
            Date.parse(String(selected.data.startAt)) > Date.now() &&
            Date.parse(String(selected.data.endAt)) > Date.now() && (
              <div>
                <Alert>
                  {locale === "de"
                    ? `Erstellt nacheinander ${selected.data.maxContents} interne Entwürfe mit der aktiven Kosten-Policy, jeweils mit höchstens einem Versuch und insgesamt höchstens ${usd(Number(selected.data.maxContents) * Number(selected.data.chatCostCeilingMicros))}. Bei einem Fehler stoppt der Stapel. Kein Review, Zeitplan oder externer Post.`
                    : `Creates ${selected.data.maxContents} internal drafts one after another under the active cost policy, each with at most one attempt and at most ${usd(Number(selected.data.maxContents) * Number(selected.data.chatCostCeilingMicros))} in total. The batch stops on any failure. No review, schedule, or external post.`}
                </Alert>
                <label className="review-confirm">
                  <Input
                    type="checkbox"
                    checked={batchConfirm}
                    onChange={(event) => setBatchConfirm(event.target.checked)}
                  />
                  <span>
                    {locale === "de"
                      ? `Ich bestätige genau ${selected.data.maxContents} kostenpflichtige interne Entwürfe ohne Retry.`
                      : `I confirm exactly ${selected.data.maxContents} paid internal drafts without retry.`}
                  </span>
                </label>
                <Button
                  disabled={mutation.pending || !batchConfirm}
                  onClick={async () => {
                    const result = await mutation.run(() =>
                      action(project.id, "start-approved-live-draft-batch", {
                        missionId: selected.id,
                        version: selected.version,
                        confirmPaidInternalDrafts: Number(
                          selected.data.maxContents,
                        ),
                      }),
                    );
                    if (result) setBatchConfirm(false);
                  }}
                >
                  <Play data-icon="inline-start" />
                  {locale === "de"
                    ? `${selected.data.maxContents} Entwürfe jetzt erstellen`
                    : `Create ${selected.data.maxContents} drafts now`}
                </Button>
              </div>
            )}
          {isOwner &&
            batchOf(selected)?.status === "running" &&
            selected.data.status === "ready" &&
            Number(selected.data.completedRuns ?? 0) <
              Number(selected.data.maxContents) && (
              <div>
                <Alert>
                  {locale === "de"
                    ? "Nur wenn der letzte Lauf ohne Kosten und ohne Inhalt blockiert ist, wird der Stapel mit genau einem neuen Versuch fortgesetzt. Läuft noch ein Job, lehnt der Server ab."
                    : "Only when the last run was blocked without cost or content does the batch continue with exactly one new attempt. The server refuses while a job is still running."}
                </Alert>
                <label className="review-confirm">
                  <Input
                    type="checkbox"
                    checked={batchConfirm}
                    onChange={(event) => setBatchConfirm(event.target.checked)}
                  />
                  <span>
                    {locale === "de"
                      ? "Ich bestätige einen weiteren kostenpflichtigen internen Entwurf ohne Retry."
                      : "I confirm one more paid internal draft without retry."}
                  </span>
                </label>
                <Button
                  variant="outline"
                  disabled={mutation.pending || !batchConfirm}
                  onClick={async () => {
                    const result = await mutation.run(() =>
                      action(project.id, "resume-live-draft-batch", {
                        missionId: selected.id,
                        version: selected.version,
                        confirmPaidInternalDraft: true,
                      }),
                    );
                    if (result) setBatchConfirm(false);
                  }}
                >
                  <Play data-icon="inline-start" />
                  {locale === "de" ? "Stapel fortsetzen" : "Resume batch"}
                </Button>
              </div>
            )}
          {canEdit && (
            <div className="form-actions">
              <Button
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    action(project.id, "run-mission", {
                      missionId: selected.id,
                    }),
                  )
                }
              >
                <Play data-icon="inline-start" />
                {locale === "de" ? "Mission ausführen" : "Run mission"}
              </Button>
              {isOwner && (
                <Button
                  variant="outline"
                  disabled={mutation.pending}
                  onClick={async () => {
                    const archived = selected.data.status !== "archived";
                    const result = await mutation.run(() =>
                      action(project.id, "archive-mission", {
                        missionId: selected.id,
                        version: selected.version,
                        archived,
                      }),
                    );
                    if (result) setSelected(null);
                  }}
                >
                  {selected.data.status === "archived"
                    ? locale === "de"
                      ? "Wiederherstellen"
                      : "Restore"
                    : locale === "de"
                      ? "Archivieren"
                      : "Archive"}
                </Button>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
type MissionBatch = {
  status: string;
  size: number;
  costCeilingMicros: number;
};
const batchOf = (mission: Entity) =>
  mission.data.batch as MissionBatch | undefined;
export function MissionEditor({
  onClose,
  initial,
}: {
  onClose: () => void;
  initial?: BriefProposal;
}) {
  const { project, t, locale, isOwner, refresh } = useWorkspace();
  const sources = useCollection("sources");
  const profile = useResource<{
    version: number;
    data: Record<string, unknown>;
  } | null>(`/projects/${project.id}/marketing-profile`);
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const de = locale === "de";
  const fields: FormField[] = [
    { name: "title", label: t("title"), required: true, value: initial?.title },
    {
      name: "goal",
      value: initial?.goal,
      label: de ? "Beschreibe dein Ziel" : "Describe your objective",
      type: "textarea",
      required: true,
      min: 5,
      max: 2000,
    },
    { name: "product", label: de ? "Produkt / Angebot" : "Product / offering" },
    {
      name: "allowedTopics",
      label: de
        ? "Erlaubte Themen (kommagetrennt)"
        : "Allowed topics (comma separated)",
    },
    { name: "audience", label: de ? "Zielgruppe" : "Audience", required: true },
    {
      name: "targetAction",
      label: de ? "Primäre CTA" : "Primary CTA",
      type: "select",
      options: (
        (profile.data?.data?.primaryCtas as string[] | undefined) ?? []
      ).map((cta) => ({ value: cta, label: cta })),
      required: true,
    },
    {
      name: "targetUrl",
      label: de ? "Offizieller Ziel-Link" : "Official target link",
      type: "select",
      options: (
        (profile.data?.data?.officialLinks as
          { label: string; url: string }[] | undefined) ?? []
      ).map((link) => ({
        value: link.url,
        label: `${link.label} · ${link.url}`,
      })),
      required: true,
    },
    {
      name: "targetValue",
      label: de ? "Zielwert (optional)" : "Target value (optional)",
      type: "number",
      min: 0,
    },
    {
      name: "language",
      label: t("language"),
      type: "select",
      value: initial?.language || project.language,
      options: options(["en", "de"]),
    },
    {
      name: "contentType",
      label: de ? "Inhaltstyp" : "Content type",
      type: "select",
      options: options([
        "social",
        "blog",
        "newsletter",
        "ad",
        "script",
        "community",
      ]),
      value: "social",
    },
    {
      name: "campaignType",
      label: de ? "Kampagnenbereich" : "Campaign area",
      type: "select",
      value: "product",
      options: [
        { value: "product", label: "Product marketing" },
        { value: "presale", label: "ULIQ presale" },
      ],
      hint: "A campaign belongs to exactly one area. Cross-area content is blocked.",
    },
    {
      name: "channels",
      label: de
        ? "Erlaubte Kanäle, kommagetrennt"
        : "Allowed channels, comma separated",
      required: true,
      placeholder: "blog, linkedin",
    },
    {
      name: "maxContents",
      label: de ? "Maximale Anzahl Inhalte" : "Maximum content packages",
      type: "number",
      required: true,
      min: 1,
      max: 30,
    },
    dateField(
      "startAt",
      de ? "Start (lokale Browserzeit)" : "Start (browser local time)",
    ),
    dateField(
      "endAt",
      de ? "Ende (lokale Browserzeit)" : "End (browser local time)",
    ),
    {
      name: "sourceId",
      label: de ? "Verbindliche Quelle" : "Required source",
      type: "select",
      required: true,
      options: (sources.data?.items || [])
        .filter((s) => s.data.status === "active")
        .map((s) => ({ value: s.id, label: value(s, "name") })),
    },
  ];
  if (isOwner)
    fields.push({
      name: "allowLive",
      label: de
        ? "Live-Publikation für diese Mission innerhalb der aktiven Owner-Policy erlauben"
        : "Allow live publication for this mission within the active owner policy",
      type: "checkbox",
      hint: "Off by default. Does not create a policy, budget or provider verification.",
    });
  return (
    <Modal
      title={t("newMission")}
      description={
        de
          ? "Zahlenziele und Grenzen werden ausschließlich von dir festgelegt."
          : "You define the objective, limits and permitted channels."
      }
      onClose={onClose}
    >
      <DataForm
        fields={fields}
        t={t}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel={t("createMission")}
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() => {
              if (!profile.data)
                throw new Error(
                  "Configure the project marketing profile before creating a campaign.",
                );
              return post(collectionPath(project.id, "missions"), {
                title: str(v, "title"),
                product: str(v, "product"),
                allowedTopics: csv(v, "allowedTopics"),
                allowedActions: [
                  "draft",
                  "review",
                  "publish_test",
                  ...(v.allowLive === true ? ["publish_live"] : []),
                ],
                goal: str(v, "goal"),
                audience: str(v, "audience"),
                language: str(v, "language"),
                channels: csv(v, "channels"),
                startAt: iso(v, "startAt"),
                endAt: iso(v, "endAt"),
                maxContents: num(v, "maxContents"),
                targetAction: str(v, "targetAction"),
                targetUrl: str(v, "targetUrl"),
                ...(str(v, "targetValue")
                  ? { targetValue: num(v, "targetValue") }
                  : {}),
                sourceIds: [str(v, "sourceId")],
                contentType: str(v, "contentType"),
                campaignType: str(v, "campaignType"),
                profileVersion: profile.data.version,
              });
            })
            .then(() => {})
        }
      />
    </Modal>
  );
}
export function ContentStudio() {
  const { t, locale, canEdit } = useWorkspace();
  const resource = useCollection("content");
  const [community, setCommunity] = useState(false);
  const [filter, setFilter] = useState(""),
    [type, setType] = useState("all"),
    [create, setCreate] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const items = (resource.data?.items || []).filter(
    (e) =>
      (type === "all" || e.data.type === type) &&
      `${value(e, "title")} ${value(e, "body")}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  if (community)
    return (
      <>
        <PageHead
          title="Community questions"
          description="Labeled imports, recurring topics and accountable internal drafts."
        >
          <Button variant="outline" onClick={() => setCommunity(false)}>
            Content Studio
          </Button>
        </PageHead>
        <CommunityQuestions />
      </>
    );
  return (
    <>
      <PageHead
        title={t("content")}
        description={
          locale === "de"
            ? "Von belegten Ideen zu überprüften Inhalten."
            : "From source-backed ideas to reviewed content."
        }
      >
        <Button variant="outline" onClick={() => setCommunity(true)}>
          Community questions
        </Button>
        {canEdit && (
          <Button onClick={() => setCreate(true)}>
            <Plus data-icon="inline-start" />
            {t("newContent")}
          </Button>
        )}
      </PageHead>
      <div className="filter-bar">
        <div className="search-field">
          <Search />
          <Input
            aria-label="Search content"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={
              locale === "de" ? "Inhalte durchsuchen" : "Search content"
            }
          />
        </div>
        <select
          className="input"
          aria-label="Content type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">
            {locale === "de" ? "Alle Formate" : "All formats"}
          </option>
          {["social", "blog", "newsletter", "ad", "script", "community"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
        <Button asChild variant="outline">
          <Link href="/calendar">
            <CalendarDays data-icon="inline-start" />
            {t("calendar")}
          </Link>
        </Button>
      </div>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {items.length ? (
            <EntityRows
              items={items}
              fields={["title", "type", "channel", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={FileText}
              title={filter ? t("emptySearch") : t("emptyContent")}
              description={t("contentHint")}
            >
              {canEdit && (
                <Button onClick={() => setCreate(true)}>
                  {t("newContent")}
                </Button>
              )}
            </Empty>
          )}
        </section>
      )}
      {create && <ContentEditor onClose={() => setCreate(false)} />}
      {selected && (
        <ContentDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
export function ContentEditor({
  entity,
  onClose,
}: {
  entity?: Entity;
  onClose: () => void;
}) {
  const { project, t, refresh } = useWorkspace();
  const evidence = useCollection("evidence"),
    facts = useCollection("facts"),
    missions = useCollection("missions"),
    connectors = useCollection("connectors");
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const d = entity?.data;
  const postizChannels = (connectors.data?.items || [])
    .filter(
      (connector) =>
        connector.data.provider === "postiz" &&
        Array.isArray(connector.data.channels),
    )
    .flatMap((connector) => {
      const assigned = Array.isArray(connector.data.assignedIntegrationIds)
        ? connector.data.assignedIntegrationIds
        : [];
      return (connector.data.channels as Record<string, unknown>[]).filter(
        (channel) => !channel.disabled && assigned.includes(channel.id),
      );
    })
    .map((channel) => ({
      value: String(channel.id),
      label: `${String(channel.name || channel.id)} · ${String(channel.identifier || "unknown")}`,
    }));
  const fields: FormField[] = [
    {
      name: "title",
      label: t("title"),
      required: true,
      value: d?.title as string,
    },
    {
      name: "body",
      label: "Content",
      type: "textarea",
      required: true,
      max: 40000,
      value: d?.body as string,
    },
    {
      name: "type",
      label: "Format",
      type: "select",
      value: String(d?.type || "social"),
      options: options([
        "social",
        "blog",
        "newsletter",
        "ad",
        "script",
        "community",
      ]),
    },
    {
      name: "language",
      label: t("language"),
      type: "select",
      value: String(d?.language || project.language),
      options: options(["en", "de"]),
    },
    {
      name: "channel",
      label: "Channel",
      type: postizChannels.length ? "select" : "text",
      required: true,
      value: d?.channel as string,
      options: postizChannels,
      hint: postizChannels.length
        ? "Channels explicitly assigned to this project. IDs are stored with the approved content package."
        : "No Postiz channel assigned to this project. Ask an owner to assign channels in Connections.",
    },
    {
      name: "missionId",
      label: "Campaign",
      type: "select",
      required: true,
      value: d?.missionId as string,
      options: (missions.data?.items || []).map((mission) => ({
        value: mission.id,
        label: `${value(mission, "title")} · ${value(mission, "campaignType", "legacy")}`,
      })),
      hint: "Every draft belongs to a campaign and inherits its official target link.",
    },
    {
      name: "evidenceId",
      label: "Evidence pack",
      type: "select",
      required: true,
      value: d?.evidenceId as string,
      options: (evidence.data?.items || []).map((e) => ({
        value: e.id,
        label: `${value(e, "query")} · v${e.version}`,
      })),
      hint: "Run a question in Knowledge → Inspector to build an evidence pack.",
    },
    {
      name: "claim",
      label: "Factual claim",
      type: "textarea",
      hint: "Use a verified fact to support each factual claim. Claims are checked again before publishing.",
    },
    {
      name: "factId",
      label: "Supporting verified fact",
      type: "select",
      options: (facts.data?.items || [])
        .filter((f) => f.data.status === "verified")
        .map((f) => ({
          value: f.id,
          label: `${value(f, "key")}: ${value(f, "value")}`,
        })),
    },
    {
      name: "scheduledAt",
      label: "Schedule (browser local time)",
      type: "datetime-local",
      value:
        typeof d?.scheduledAt === "string"
          ? new Date(
              new Date(d.scheduledAt).getTime() -
                new Date(d.scheduledAt).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
      hint: `Project timezone: ${project.timezone}`,
    },
    {
      name: "description",
      label: "Blog description",
      type: "textarea",
      value: d?.description as string,
      max: 500,
      showWhen: { name: "type", values: ["blog"] },
    },
    {
      name: "slug",
      label: "Blog URL slug",
      value: d?.slug as string,
      placeholder: "your-article-title",
      showWhen: { name: "type", values: ["blog"] },
    },
    {
      name: "outline",
      label: "Blog outline (one section per line)",
      type: "textarea",
      value: Array.isArray(d?.outline) ? d.outline.join("\n") : "",
      showWhen: { name: "type", values: ["blog"] },
    },
    {
      name: "internalLinks",
      label: "Suggested internal links (one URL per line)",
      type: "textarea",
      value: Array.isArray(d?.internalLinks) ? d.internalLinks.join("\n") : "",
      showWhen: { name: "type", values: ["blog"] },
    },
    {
      name: "altTexts",
      label: "Image alt text (one description per line)",
      type: "textarea",
      value: Array.isArray(d?.altTexts) ? d.altTexts.join("\n") : "",
      showWhen: { name: "type", values: ["blog", "social", "ad"] },
    },
    {
      name: "subjects",
      label: "Newsletter subject variants (one per line)",
      type: "textarea",
      value: Array.isArray(
        (d?.newsletter as Record<string, unknown> | undefined)?.subjects,
      )
        ? (
            (d?.newsletter as Record<string, unknown>).subjects as string[]
          ).join("\n")
        : "",
      required: true,
      showWhen: { name: "type", values: ["newsletter"] },
    },
    {
      name: "preview",
      label: "Newsletter preview text",
      value: String(
        (d?.newsletter as Record<string, unknown> | undefined)?.preview || "",
      ),
      showWhen: { name: "type", values: ["newsletter"] },
    },
    {
      name: "segmentRef",
      label: "Audience segment reference",
      value: String(
        (d?.newsletter as Record<string, unknown> | undefined)?.segmentRef ||
          "",
      ),
      hint: "Reference an authorized segment. No recipient list is imported here.",
      showWhen: { name: "type", values: ["newsletter"] },
    },
    {
      name: "consentRef",
      label: "Consent record reference",
      value: String(
        (d?.newsletter as Record<string, unknown> | undefined)?.consentRef ||
          "",
      ),
      showWhen: { name: "type", values: ["newsletter"] },
    },
    {
      name: "suppressionRef",
      label: "Suppression list reference",
      value: String(
        (d?.newsletter as Record<string, unknown> | undefined)
          ?.suppressionRef || "",
      ),
      showWhen: { name: "type", values: ["newsletter"] },
    },
    {
      name: "risk",
      label: "Review sensitivity",
      type: "select",
      value: String(d?.risk || "routine"),
      options: options(["routine", "sensitive"]),
    },
  ];
  return (
    <Modal title={entity ? t("edit") : t("newContent")} onClose={onClose} wide>
      <DataForm
        fields={fields}
        t={t}
        pending={mutation.pending}
        error={mutation.error}
        onCancel={onClose}
        submitLabel={t("save")}
        onSubmit={(v) =>
          mutation
            .run(async () => {
              if (str(v, "claim") && !str(v, "factId"))
                throw new Error(
                  "Select the verified fact that supports your claim.",
                );
              const selectedMission = missions.data?.items.find(
                (mission) => mission.id === str(v, "missionId"),
              );
              if (!selectedMission?.data.targetUrl)
                throw new Error(
                  "Select a campaign with an official target link.",
                );
              const data = {
                title: str(v, "title"),
                body: str(v, "body"),
                type: str(v, "type"),
                language: str(v, "language"),
                channel: str(v, "channel"),
                missionId: str(v, "missionId"),
                evidenceId: str(v, "evidenceId"),
                claims: str(v, "claim")
                  ? [
                      {
                        text: str(v, "claim"),
                        factId: str(v, "factId"),
                        kind: "fact",
                      },
                    ]
                  : entity?.data.claims || [],
                targetUrl: selectedMission.data.targetUrl,
                ...(str(v, "scheduledAt")
                  ? { scheduledAt: iso(v, "scheduledAt") }
                  : {}),
                ...(str(v, "description")
                  ? { description: str(v, "description") }
                  : {}),
                ...(str(v, "slug") ? { slug: str(v, "slug") } : {}),
                ...(str(v, "outline")
                  ? {
                      outline: str(v, "outline")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
                ...(str(v, "internalLinks")
                  ? {
                      internalLinks: str(v, "internalLinks")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
                ...(str(v, "altTexts")
                  ? {
                      altTexts: str(v, "altTexts")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
                ...(str(v, "type") === "newsletter"
                  ? {
                      newsletter: {
                        subjects: str(v, "subjects")
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        preview: str(v, "preview"),
                        segmentRef: str(v, "segmentRef"),
                        consentRef: str(v, "consentRef"),
                        suppressionRef: str(v, "suppressionRef"),
                      },
                    }
                  : {}),
                risk: str(v, "risk"),
                ...(() => {
                  const mission = (missions.data?.items || []).find(
                    (item) => item.id === str(v, "missionId"),
                  );
                  return mission
                    ? {
                        campaignType: mission.data.campaignType,
                        profileVersion: mission.data.profileVersion,
                      }
                    : {};
                })(),
                ...(d?.assetId ? { assetId: d.assetId } : {}),
              };
              return entity
                ? api(collectionPath(project.id, `content/${entity.id}`), {
                    method: "PATCH",
                    body: JSON.stringify({ version: entity.version, data }),
                  })
                : post(collectionPath(project.id, "content"), data);
            })
            .then(() => {})
        }
      />
    </Modal>
  );
}
export function ContentDetail({
  entity,
  onClose,
}: {
  entity: Entity;
  onClose: () => void;
}) {
  const { project, t, locale, canEdit, isOwner, refresh } = useWorkspace();
  const [creative, setCreative] = useState(false);
  const [humanConfirm, setHumanConfirm] = useState(false),
    [edit, setEdit] = useState(false),
    [preflight, setPreflight] = useState<Record<string, unknown> | null>(null);
  const resource = useCollection("content");
  const current =
    resource.data?.items.find((e) => e.id === entity.id) || entity;
  const [adapting, setAdapting] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    resource.refresh();
  });
  const evidence = useResource<{ items: Entity[] }>(
    collectionPath(project.id, "evidence"),
  );
  const ev = evidence.data?.items.find((e) => e.id === current.data.evidenceId);
  if (adapting)
    return (
      <AdaptationDialog
        parent={current}
        onClose={() => {
          setAdapting(false);
          onClose();
        }}
      />
    );
  if (creative)
    return (
      <CreativeRenderer entity={current} onClose={() => setCreative(false)} />
    );
  if (edit)
    return (
      <ContentEditor
        entity={current}
        onClose={() => {
          setEdit(false);
          onClose();
        }}
      />
    );
  async function run(name: string) {
    if (name === "approve") {
      const pre = await action<Record<string, unknown>>(
        project.id,
        "preflight",
        { contentId: current.id },
      );
      setPreflight(pre);
      if (!pre.packageHash)
        throw new Error("Preflight did not return an approvable package.");
      return action(project.id, "approve", {
        contentId: current.id,
        version: current.version,
        packageHash: pre.packageHash,
      });
    }
    return action(project.id, name, {
      contentId: current.id,
      version: current.version,
      ...(name === "review" ? { humanConfirm } : {}),
      ...(name === "publish" && current.data.scheduledAt
        ? { scheduledAt: current.data.scheduledAt }
        : {}),
    });
  }
  return (
    <Modal title={value(current, "title")} onClose={onClose} wide>
      <div className="detail-summary">
        <Status value={current.data.status} />
        <Badge>{value(current, "type")}</Badge>
        <span>
          {value(current, "channel")} ·{" "}
          {value(current, "language").toUpperCase()} · v{current.version}
        </span>
        {current.data.synthetic === true && (
          <Badge tone="warning">Synthetic test content</Badge>
        )}
      </div>
      {current.data.parentContentId ? (
        <Alert>
          Adapted from content {String(current.data.parentContentId)}, version{" "}
          {String(current.data.parentContentVersion)}. Current evidence and
          review are required.
        </Alert>
      ) : null}
      <article className="content-preview">{value(current, "body")}</article>
      <details className="evidence-details">
        <summary>
          <BookOpen />{" "}
          {locale === "de" ? "Belege und Quellen" : "Evidence and sources"}
        </summary>
        {ev ? (
          <>
            <p>{value(ev, "query")}</p>
            <Status value={ev.data.status} />
            <EvidenceItems evidence={ev} />
          </>
        ) : (
          <p>Evidence pack unavailable or not selected.</p>
        )}
      </details>
      <dl className="detail-grid">
        <dt>{t("calendar")}</dt>
        <dd>
          {when(current.data.scheduledAt, locale, project.timezone)} ·{" "}
          {project.timezone}
        </dd>
        <dt>Version</dt>
        <dd>{current.version}</dd>
        <dt>Target</dt>
        <dd>{value(current, "targetUrl")}</dd>
      </dl>
      {preflight && (
        <Alert>
          {String(
            preflight.allowed ?? preflight.status ?? "Preflight completed",
          )}{" "}
          {Array.isArray(preflight.blockers) && preflight.blockers.join(", ")}
        </Alert>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && (
        <Alert kind="success">
          Action recorded. The current server status is shown above.
        </Alert>
      )}
      {isOwner && current.data.status === "reviewed" && (
        <PostizDraftSection content={current} />
      )}
      {isOwner && (
        <label className="review-confirm">
          <Input
            type="checkbox"
            checked={humanConfirm}
            onChange={(e) => setHumanConfirm(e.target.checked)}
          />
          <span>
            {locale === "de"
              ? "Ich habe den vollständigen Text geprüft: Alle öffentlichen Tatsachenbehauptungen sind durch die ausgewählten Belege gedeckt."
              : "I reviewed the complete text: all public factual claims are supported by the selected evidence."}
          </span>
        </label>
      )}
      <div className="form-actions">
        <Button asChild variant="outline">
          <a
            href={`/api${collectionPath(project.id, `content/${current.id}/export`)}`}
            download
          >
            {t("export")}
          </a>
        </Button>
        {canEdit && (
          <>
            {current.data.status === "reviewed" && (
              <Button variant="outline" onClick={() => setAdapting(true)}>
                Create social variant
              </Button>
            )}
            <Button variant="outline" onClick={() => setCreative(true)}>
              Creative
            </Button>
            <Button variant="outline" onClick={() => setEdit(true)}>
              {t("edit")}
            </Button>
            <Button
              variant="outline"
              disabled={mutation.pending}
              onClick={() => mutation.run(() => run("review"))}
            >
              <ShieldCheck data-icon="inline-start" />
              {t("review")}
            </Button>
            {isOwner && (
              <Button
                disabled={mutation.pending}
                onClick={() => mutation.run(() => run("approve"))}
              >
                {t("approve")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={mutation.pending}
              onClick={() => mutation.run(() => run("publish"))}
            >
              {t("testPublish")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
/** Owner-confirmed handoff of a reviewed version to Postiz as a draft only. */
function PostizDraftSection({ content }: { content: Entity }) {
  const { project, locale, refresh } = useWorkspace();
  const connectors = useCollection("connectors");
  const drafts = useCollection("postiz_drafts");
  const [confirm, setConfirm] = useState(false),
    [withoutImage, setWithoutImage] = useState(false),
    [checked, setChecked] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    drafts.refresh();
  });
  const resolve = (handoffId: string, resolution: "not_created" | "exists") =>
    mutation.run(() =>
      action(project.id, "postiz-draft-resolve", {
        handoffId,
        resolution,
        confirmCheckedInPostiz: true,
      }),
    );
  const postiz = connectors.data?.items.find(
    (c) => c.data.provider === "postiz",
  );
  const channel = (
    (postiz?.data.channels ?? []) as {
      id: string;
      name?: string;
      identifier?: string;
    }[]
  ).find((c) => c.id === content.data.channel);
  const history = (drafts.data?.items ?? []).filter(
    (d) => d.data.contentId === content.id,
  );
  const de = locale === "de";
  return (
    <section className="postiz-draft">
      <h3>{de ? "Als Entwurf an Postiz senden" : "Send to Postiz as draft"}</h3>
      <p className="panel-note">
        {de ? "Kanal: " : "Channel: "}
        <strong>
          {channel
            ? `${channel.name ?? channel.id} (${channel.identifier ?? "?"})`
            : String(content.data.channel)}
        </strong>
        {" · "}
        {de
          ? "Postiz erhält nur einen Entwurf. Nichts wird geplant oder veröffentlicht."
          : "Postiz receives a draft only. Nothing is scheduled or published."}
      </p>
      {history.map((d) => (
        <div key={d.id} className="panel-note">
          <Status value={d.data.status} /> v{String(d.data.contentVersion)}
          {d.data.remoteId ? ` · Postiz ${String(d.data.remoteId)}` : ""}
          {d.data.error ? ` · ${String(d.data.error)}` : ""}
          {d.data.failedStep ? ` · ${String(d.data.failedStep)}` : ""}
          {d.data.httpStatus ? ` · HTTP ${String(d.data.httpStatus)}` : ""}
          {d.data.providerMessage ? ` · ${String(d.data.providerMessage)}` : ""}
          {d.data.withoutImage
            ? de
              ? " · ohne Bild"
              : " · without image"
            : ""}
          {d.data.resolution ? ` · ${String(d.data.resolution)}` : ""}
          {d.data.status === "outcome_unknown" && (
            <div className="postiz-draft-resolve">
              <label className="review-confirm">
                <Input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                <span>
                  {de ? "Ich habe in Postiz nachgesehen." : "I checked Postiz."}
                </span>
              </label>
              <Button
                variant="outline"
                disabled={mutation.pending || !checked}
                onClick={() => resolve(d.id, "not_created")}
              >
                {de ? "Kein Entwurf in Postiz" : "No draft in Postiz"}
              </Button>
              <Button
                variant="outline"
                disabled={mutation.pending || !checked}
                onClick={() => resolve(d.id, "exists")}
              >
                {de ? "Entwurf existiert in Postiz" : "Draft exists in Postiz"}
              </Button>
            </div>
          )}
        </div>
      ))}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <label className="review-confirm">
        <Input
          type="checkbox"
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        <span>
          {de
            ? "Ich bestätige genau einen Entwurf in Postiz für diese Version, keine Veröffentlichung."
            : "I confirm exactly one Postiz draft for this version, no publication."}
        </span>
      </label>
      {Boolean(content.data.assetId) && (
        <label className="review-confirm">
          <Input
            type="checkbox"
            checked={withoutImage}
            onChange={(event) => setWithoutImage(event.target.checked)}
          />
          <span>{de ? "Ohne Bild senden" : "Send without image"}</span>
        </label>
      )}
      <Button
        variant="outline"
        disabled={mutation.pending || !confirm}
        onClick={async () => {
          const result = await mutation.run(() =>
            action(project.id, "postiz-draft-handoff", {
              contentId: content.id,
              version: content.version,
              confirmDraftOnly: true,
              ...(withoutImage ? { withoutImage: true } : {}),
            }),
          );
          if (result) setConfirm(false);
        }}
      >
        {de ? "Als Entwurf an Postiz senden" : "Send to Postiz as draft"}
      </Button>
    </section>
  );
}
export function EvidenceItems({ evidence }: { evidence: Entity }) {
  const facts = Array.isArray(evidence.data.facts)
    ? (evidence.data.facts as Record<string, unknown>[])
    : [];
  const items = Array.isArray(evidence.data.items)
    ? (evidence.data.items as Record<string, unknown>[])
    : [];
  return (
    <div className="evidence-items">
      {facts.map((f, i) => (
        <div key={String(f.id || i)}>
          <Badge tone="blue">Fact v{String(f.version || "1")}</Badge>
          <strong>
            {String(f.key)}: {String(f.value)}
          </strong>
          <small>{String(f.sourceId || "")}</small>
        </div>
      ))}
      {items.map((f, i) => (
        <div key={String(f.chunkId || i)}>
          <strong>{String(f.title || "Source passage")}</strong>
          <p>{String(f.text || "")}</p>
          <small>
            {String(f.anchor || "")}
            {typeof f.canonicalUrl === "string" &&
              f.canonicalUrl.startsWith("https://") && (
                <>
                  {" "}
                  ·{" "}
                  <a href={f.canonicalUrl} target="_blank" rel="noreferrer">
                    Source document
                  </a>
                </>
              )}
          </small>
          {Array.isArray(f.reasons) && (
            <small>
              {f.reasons.join(" · ")}{" "}
              {typeof f.score === "number"
                ? `· relevance ${f.score.toFixed(4)}`
                : ""}
            </small>
          )}
        </div>
      ))}
      {Array.isArray(evidence.data.gaps) && evidence.data.gaps.length > 0 && (
        <Alert kind="warning">{evidence.data.gaps.join(" · ")}</Alert>
      )}
    </div>
  );
}
// Posts a project pause stopped; the owner schedules them again in one step.
function PausedPublications() {
  const { locale, project, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const publications = useCollection("publications"),
    content = useCollection("content");
  const mutation = useMutation(refresh);
  const [result, setResult] = useState<{
    resumed: number;
    blocked: { id: string; blockers: string[] }[];
  } | null>(null);
  const stopped = pausedPosts(publications.data?.items ?? []);
  if (!stopped.length && !result) return null;
  const title = (contentId: unknown) => {
    const row = (content.data?.items ?? []).find((c) => c.id === contentId);
    return row ? value(row, "title") : "";
  };
  const time = (id: string) =>
    when(
      stopped.find((p) => p.id === id)?.data.scheduledAt,
      locale,
      project.timezone,
    );
  return (
    <section className="panel autopilot-approvals">
      <div className="panel-head">
        <div>
          <h2>{de ? "Gestoppte Posts" : "Stopped posts"}</h2>
          <p>
            {project.paused
              ? de
                ? "Die Pause hat diese Posts gestoppt. Setze das Projekt unter Betrieb fort, um sie wieder einzuplanen."
                : "The pause stopped these posts. Resume the project under Operations to schedule them again."
              : de
                ? "Die Pause hat diese Posts gestoppt. Fortsetzen allein sendet nichts; plane sie hier wieder ein. Orbit prüft jeden Post vorher erneut."
                : "The pause stopped these posts. Resuming alone sends nothing; schedule them again here. Orbit checks every post again first."}
          </p>
        </div>
        {isOwner && !project.paused && stopped.length > 0 && (
          <Button
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(async () =>
                setResult(
                  await action(project.id, "resume-paused-publications", {}),
                ),
              )
            }
          >
            {de
              ? `${stopped.length} wieder einplanen`
              : `Schedule ${stopped.length} again`}
          </Button>
        )}
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {result && (
        <Alert kind={result.blocked.length ? "warning" : "success"}>
          {de
            ? `${result.resumed} wieder eingeplant.`
            : `${result.resumed} scheduled again.`}
          {result.blocked.map((b) => (
            <span key={b.id}>
              {" "}
              {time(b.id)}: {b.blockers.join(", ")}
            </span>
          ))}
        </Alert>
      )}
      {stopped.map((p) => (
        <article key={p.id} className="autopilot-approval">
          <p className="panel-note">
            {when(p.data.scheduledAt, locale, project.timezone)} ·{" "}
            {title(p.data.contentId)}
          </p>
        </article>
      ))}
    </section>
  );
}
function AutopilotApprovals() {
  const { locale, project, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const content = useCollection("content"),
    missions = useCollection("missions");
  const mutation = useMutation(refresh);
  const { due: pending, missed } = autopilotApprovals(
    content.data?.items ?? [],
    missions.data?.items ?? [],
  );
  if (!pending.length && !missed.length) return null;
  const approve = (c: Entity) =>
    action(project.id, "approve-and-schedule", {
      contentId: c.id,
      version: c.version,
    });
  const approveAll = async () => {
    const failures = await approveEach(pending, approve);
    if (!failures.length) return;
    // Approved drafts leave the list even though others failed.
    refresh();
    throw new Error(
      failures
        .map((failure) => {
          const c = pending.find((item) => item.id === failure.id)!;
          return `${when(c.data.scheduledAt, locale, project.timezone)}: ${failure.error}`;
        })
        .join(" · "),
    );
  };
  return (
    <section className="panel autopilot-approvals">
      <div className="panel-head">
        <div>
          <h2>
            {de
              ? "Autopilot: Freigabe der Woche"
              : "Autopilot: this week's approvals"}
          </h2>
          <p>
            {de
              ? "Diese Posts enthalten Werbetext. Mit der Freigabe bestätigst du den vollständigen Text, und Orbit plant ihn zum angezeigten Termin ein."
              : "These posts contain marketing copy. Approving confirms the full text and Orbit schedules it for the shown time."}
          </p>
        </div>
        {isOwner && pending.length > 0 && (
          <Button
            disabled={mutation.pending}
            onClick={() => mutation.run(approveAll)}
          >
            {de
              ? `Alle ${pending.length} freigeben`
              : `Approve all ${pending.length}`}
          </Button>
        )}
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {missed.map((c) => (
        <article key={c.id} className="autopilot-approval">
          <p className="panel-note">
            {when(c.data.scheduledAt, locale, project.timezone)} ·{" "}
            {value(c, "title")}
          </p>
          <Alert kind="warning">
            {de
              ? "Termin verstrichen: dieser Entwurf wird nicht mehr eingeplant und gleich automatisch archiviert."
              : "Slot passed: this draft is no longer scheduled and is archived automatically."}
          </Alert>
        </article>
      ))}
      {pending.map((c) => (
        <article key={c.id} className="autopilot-approval">
          <p className="panel-note">
            {when(c.data.scheduledAt, locale, project.timezone)} ·{" "}
            {value(c, "title")}
          </p>
          <pre className="autopilot-approval-body">{String(c.data.body)}</pre>
          {isOwner && (
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.pending}
              onClick={() => mutation.run(() => approve(c))}
            >
              {de ? "Freigeben & einplanen" : "Approve & schedule"}
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
/**
 * Orbit Agents replaces the weekly autopilot: only once its route answered do
 * the autopilot approvals give way to the migration card. Without an answer
 * (loading, flag off, or an outage such as a 5xx during a redeploy) the
 * autopilot approvals stay.
 */
function AutopilotOrMigration() {
  const migration = useAutopilotMigration();
  return migration.available ? (
    <AutopilotMigrationCard migration={migration} />
  ) : (
    <AutopilotApprovals />
  );
}
export function ApprovalInbox() {
  const { t, locale, project, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const content = useCollection("content"),
    exceptions = useCollection("exceptions");
  const resolve = useMutation(refresh);
  const [selected, setSelected] = useState<Entity | null>(null);
  const items = approvalItems(content.data?.items || []);
  return (
    <>
      <PageHead
        title={t("approvals")}
        description={
          locale === "de"
            ? "Die Entscheidungen, die deine Aufmerksamkeit brauchen."
            : "The decisions that need your attention."
        }
      />
      <DraftCleanup />
      <ResourceError
        error={content.error || exceptions.error}
        retry={() => {
          content.refresh();
          exceptions.refresh();
        }}
      />
      <PausedPublications />
      <UpcomingAssignmentPosts />
      <AutopilotOrMigration />
      <ActionRequestInbox />
      {resolve.error && <Alert kind="error">{resolve.error}</Alert>}
      {openExceptions(exceptions.data?.items ?? []).map((e) => (
        <Alert key={e.id} kind="warning">
          <strong>{value(e, "title", value(e, "code"))}</strong>
          <p>{value(e, "message", value(e, "reason"))}</p>
          <small>
            {de ? "Zuletzt" : "Last seen"}{" "}
            {when(e.data.lastSeenAt, locale, project.timezone)} ·{" "}
            {Number(e.data.count ?? 1)}×
          </small>
          {isOwner && (
            <div className="form-actions">
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.pending}
                onClick={() =>
                  resolve.run(() =>
                    action(project.id, "resolve-exception", {
                      exceptionId: e.id,
                    }),
                  )
                }
              >
                {de ? "Erledigt" : "Resolved"}
              </Button>
            </div>
          )}
        </Alert>
      ))}
      {content.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {items.length ? (
            <EntityRows
              items={items}
              fields={["title", "type", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={CircleCheck}
              title={t("noApprovals")}
              description={t("approvalHint")}
            />
          )}
        </section>
      )}
      {selected && (
        <ContentDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
export function CalendarView() {
  const { t, locale, project } = useWorkspace();
  const resource = useCollection("content");
  const blocks = useCollection("calendar_blocks");
  const handoffs = useCollection("postiz_drafts");
  const connectors = useCollection("connectors");
  const [selected, setSelected] = useState<Entity | null>(null),
    [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const inPostiz = new Map(
    (handoffs.data?.items || [])
      .filter((h) => h.data.status === "accepted")
      .map((h) => [String(h.data.contentId), h]),
  );
  const channelNames = new Map(
    (connectors.data?.items || []).flatMap((c) =>
      (Array.isArray(c.data.channels) ? c.data.channels : []).map(
        (ch: Record<string, unknown>) =>
          [
            String(ch.id),
            `${String(ch.name)} · ${String(ch.identifier)}`,
          ] as const,
      ),
    ),
  );
  // A post's planned slot, or the date it was handed to Postiz with.
  const plannedAt = (e: Entity) =>
    typeof e.data.scheduledAt === "string"
      ? e.data.scheduledAt
      : typeof inPostiz.get(e.id)?.data.remoteDate === "string"
        ? String(inPostiz.get(e.id)!.data.remoteDate)
        : null;
  const items = (resource.data?.items || []).filter((e) => {
    const at = plannedAt(e);
    return (
      at !== null &&
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        timeZone: project.timezone,
      })
        .format(new Date(at))
        .startsWith(month)
    );
  });
  return (
    <>
      <PageHead
        title={t("calendar")}
        description={`${locale === "de" ? "Planung und Inhalte teilen denselben Datenstand." : "Your schedule and content share one source of truth."} ${project.timezone}`}
      >
        <Input
          aria-label="Calendar month"
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </PageHead>
      <Alert>
        {locale === "de"
          ? "Termine bearbeitest du über das Inhaltsformular – vollständig per Tastatur. Jede Änderung hebt veraltete Freigaben auf."
          : "Edit a schedule through the content form, fully accessible by keyboard. Changes invalidate outdated approvals."}
      </Alert>
      <ResourceError
        error={resource.error || blocks.error}
        retry={() => {
          resource.refresh();
          blocks.refresh();
        }}
      />
      <CalendarBlocks items={blocks.data?.items || []} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel calendar-list">
          {items.length ? (
            items
              .sort((a, b) =>
                String(plannedAt(a)).localeCompare(String(plannedAt(b))),
              )
              .map((e) => (
                <button
                  key={e.id}
                  className="calendar-entry"
                  onClick={() => setSelected(e)}
                >
                  <span className="calendar-date">
                    {new Intl.DateTimeFormat(locale, {
                      day: "numeric",
                      month: "short",
                      timeZone: project.timezone,
                    }).format(new Date(String(plannedAt(e))))}
                  </span>
                  <div>
                    <strong>{value(e, "title")}</strong>
                    <p>
                      {when(plannedAt(e), locale, project.timezone)} ·{" "}
                      {channelNames.get(String(e.data.channel)) ??
                        value(e, "channel")}
                    </p>
                  </div>
                  {inPostiz.has(e.id) && <Badge tone="blue">In Postiz</Badge>}
                  {(blocks.data?.items || []).some((block) =>
                    calendarBlockConflicts(block, e),
                  ) ? (
                    <Badge tone="danger">Calendar conflict</Badge>
                  ) : (
                    <Status value={e.data.status} />
                  )}
                  <ArrowRight />
                </button>
              ))
          ) : (
            <Empty
              icon={CalendarDays}
              title={
                locale === "de"
                  ? "Noch keine geplanten Inhalte"
                  : "No content scheduled this month"
              }
              description={
                locale === "de"
                  ? "Öffne einen Entwurf und wähle einen Termin."
                  : "Open a draft and choose its schedule."
              }
            >
              <Button asChild variant="outline">
                <Link href="/content">{t("content")}</Link>
              </Button>
            </Empty>
          )}
        </section>
      )}
      {selected && (
        <ContentDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
