"use client";
import { CalendarBlocks, calendarBlockConflicts } from "./calendar-blocks";
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
                {d.readiness.blockers.length > 0 && (
                  <details className="readiness-details">
                    <summary>
                      {locale === "de" ? "Was noch fehlt" : "Readiness details"}
                    </summary>
                    <ul>
                      {d.readiness.blockers.map((b) => (
                        <li key={b}>{b.replaceAll("_", " ")}</li>
                      ))}
                    </ul>
                  </details>
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
  const { t, locale, project, canEdit, refresh } = useWorkspace();
  const resource = useCollection("missions");
  const [create, setCreate] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const [brief, setBrief] = useState(false),
    [proposal, setProposal] = useState<BriefProposal | undefined>();
  const mutation = useMutation(refresh);
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
          {resource.data?.items.length ? (
            <EntityRows
              items={resource.data.items}
              fields={["title", "audience", "status", "createdAt"]}
              onSelect={setSelected}
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
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
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
      label: de ? "Messbare Zielaktion" : "Measurable target action",
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
    .flatMap(
      (connector) => connector.data.channels as Record<string, unknown>[],
    )
    .filter((channel) => !channel.disabled)
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
        ? "Connected Postiz channels; IDs are stored server-side with the approved content package."
        : "Refresh the Postiz connector to load channel choices.",
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
      hint: "Every new draft belongs to one product or presale campaign.",
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
      name: "targetUrl",
      label: "Target URL",
      type: "url",
      value: d?.targetUrl as string,
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
                ...(str(v, "targetUrl")
                  ? { targetUrl: str(v, "targetUrl") }
                  : {}),
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
export function ApprovalInbox() {
  const { t, locale } = useWorkspace();
  const content = useCollection("content"),
    exceptions = useCollection("exceptions");
  const [selected, setSelected] = useState<Entity | null>(null);
  const items = (content.data?.items || []).filter((e) =>
    [
      "review",
      "needs_review",
      "reviewed",
      "draft",
      "blocked",
      "pending_approval",
    ].includes(String(e.data.status)),
  );
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
      <ResourceError
        error={content.error || exceptions.error}
        retry={() => {
          content.refresh();
          exceptions.refresh();
        }}
      />
      {exceptions.data?.items.map((e) => (
        <Alert key={e.id} kind="warning">
          <strong>{value(e, "title", value(e, "code"))}</strong>
          <p>{value(e, "message", value(e, "reason"))}</p>
          <small>
            Version {e.version} · {value(e, "status")}
          </small>
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
  const [selected, setSelected] = useState<Entity | null>(null),
    [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const items = (resource.data?.items || []).filter(
    (e) =>
      typeof e.data.scheduledAt === "string" &&
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        timeZone: project.timezone,
      })
        .format(new Date(e.data.scheduledAt))
        .startsWith(month),
  );
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
                String(a.data.scheduledAt).localeCompare(
                  String(b.data.scheduledAt),
                ),
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
                    }).format(new Date(String(e.data.scheduledAt)))}
                  </span>
                  <div>
                    <strong>{value(e, "title")}</strong>
                    <p>
                      {when(e.data.scheduledAt, locale, project.timezone)} ·{" "}
                      {value(e, "channel")}
                    </p>
                  </div>
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
