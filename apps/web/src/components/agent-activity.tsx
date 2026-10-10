"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CalendarClock,
  CircleCheck,
  Hand,
  Image as ImageIcon,
  Lightbulb,
  PenLine,
  Search,
  Send,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { ApiError, api, collectionPath, usd, when } from "@/lib/api";
import { Badge } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

/** One step of `GET /agent-activity` runs. */
export type ActivityStep = {
  key: string;
  role: string;
  status: string;
  dependsOn: string[];
  optionalDependsOn: string[];
  errorCode: string | null;
  channel: string | null;
  channelName: string | null;
};
export type ActivityRun = {
  id: string;
  assignmentId: string;
  assignmentName: string | null;
  date: string;
  status: string;
  plannedAt: string | null;
  updatedAt: string;
  firstSlotAt: string | null;
  costMicros: number;
  ceilingMicros: number;
  delivery: "publish" | "postiz_draft";
  steps: ActivityStep[];
};
export type NextItem = {
  kind: "run_start" | "post" | "postiz_draft" | "owner_release";
  at: string;
  assignmentName: string | null;
  channelName: string | null;
  status: string | null;
};
export type HealthIssue = {
  code: string;
  severity: "warning" | "problem";
  count: number;
};
export type AgentActivity = {
  timezone: string;
  paused: boolean;
  activeAssignments: number;
  health: {
    state: "ok" | "attention" | "problem" | "paused";
    issues: HealthIssue[];
  };
  runs: ActivityRun[];
  next: NextItem[];
};

type Text = [en: string, de: string];
const roles: Record<string, { icon: LucideIcon; label: Text }> = {
  analytics: { icon: BarChart3, label: ["Analytics", "Analyse"] },
  research: { icon: Search, label: ["Research", "Recherche"] },
  strategy: { icon: Lightbulb, label: ["Strategy", "Strategie"] },
  copywriter: { icon: PenLine, label: ["Copywriter", "Texter"] },
  visual: { icon: ImageIcon, label: ["Visual", "Bild"] },
  review: { icon: ShieldCheck, label: ["Review", "Prüfung"] },
  delivery: { icon: Send, label: ["Delivery", "Übergabe"] },
};
const stepStatus: Record<string, Text> = {
  idle: ["ready", "bereit"],
  pending: ["waiting", "wartet"],
  queued: ["queued", "in Warteschlange"],
  running: ["working", "arbeitet"],
  done: ["done", "fertig"],
  failed: ["failed", "fehlgeschlagen"],
  skipped: ["skipped", "übersprungen"],
  canceled: ["canceled", "abgebrochen"],
};
const runStatus: Record<string, Text> = {
  planned: ["planned", "geplant"],
  running: ["running", "läuft"],
  done: ["done", "fertig"],
  partial: ["partly done", "teilweise fertig"],
  failed: ["failed", "fehlgeschlagen"],
  canceled: ["canceled", "abgebrochen"],
};
const healthText: Record<AgentActivity["health"]["state"], Text> = {
  ok: ["All good", "Alles in Ordnung"],
  attention: ["Needs attention", "Braucht Aufmerksamkeit"],
  problem: ["Problem", "Problem"],
  paused: ["Paused", "Pausiert"],
};
const healthTone = {
  ok: "success",
  attention: "warning",
  problem: "danger",
  paused: "neutral",
} as const;
const issueText: Record<string, (n: number) => Text> = {
  PROJECT_PAUSED: () => [
    "The project is paused: no run starts.",
    "Das Projekt ist pausiert: kein Lauf startet.",
  ],
  RUN_FAILED: (n) => [
    `${n} run${n === 1 ? "" : "s"} failed in the last 24 hours.`,
    `${n} ${n === 1 ? "Lauf" : "Läufe"} in den letzten 24 Stunden fehlgeschlagen.`,
  ],
  RUN_PARTIAL: (n) => [
    `${n} run${n === 1 ? "" : "s"} finished only partly in the last 24 hours.`,
    `${n} ${n === 1 ? "Lauf" : "Läufe"} in den letzten 24 Stunden nur teilweise fertig.`,
  ],
  DRAFTS_AWAIT_RELEASE: (n) => [
    `${n} draft${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for your release.`,
    `${n} ${n === 1 ? "Entwurf wartet" : "Entwürfe warten"} auf deine Freigabe.`,
  ],
  POSTS_BLOCKED: (n) => [
    `${n} upcoming post${n === 1 ? " is" : "s are"} blocked.`,
    `${n} ${n === 1 ? "anstehender Post ist" : "anstehende Posts sind"} blockiert.`,
  ],
  DRAFT_HANDOFF_UNCLEAR: (n) => [
    `${n} Postiz handoff${n === 1 ? " is" : "s are"} unclear.`,
    `${n} ${n === 1 ? "Postiz-Übergabe ist" : "Postiz-Übergaben sind"} unklar.`,
  ],
  BUDGET_EXHAUSTED: (n) => [
    `${n} assignment${n === 1 ? " has" : "s have"} used up the monthly budget.`,
    `${n} ${n === 1 ? "Auftrag hat" : "Aufträge haben"} das Monatsbudget aufgebraucht.`,
  ],
};
const issueLink: Record<string, string> = {
  DRAFTS_AWAIT_RELEASE: "/approvals",
  POSTS_BLOCKED: "/approvals",
  DRAFT_HANDOFF_UNCLEAR: "/approvals",
  RUN_FAILED: "/operations",
  RUN_PARTIAL: "/operations",
  PROJECT_PAUSED: "/settings",
};
const nextText: Record<NextItem["kind"], { icon: LucideIcon; label: Text }> = {
  run_start: { icon: CalendarClock, label: ["Run starts", "Lauf startet"] },
  post: { icon: Send, label: ["Post goes out", "Post geht raus"] },
  postiz_draft: { icon: Send, label: ["Postiz draft", "Postiz-Entwurf"] },
  owner_release: {
    icon: Hand,
    label: ["Waits for your release", "Wartet auf deine Freigabe"],
  },
};

/** The work plan shown while no run exists: every specialist, ready. */
const TEMPLATE: ActivityStep[] = [
  ["analytics", []],
  ["research", []],
  ["strategy", [], ["analytics", "research"]],
  ["copywriter", ["strategy"]],
  ["visual", ["strategy"]],
  ["review", ["copywriter", "visual"]],
].map(([key, hard, optional = []]) => ({
  key: key as string,
  role: key as string,
  status: "idle",
  dependsOn: [...(hard as string[]), ...(optional as string[])],
  optionalDependsOn: optional as string[],
  errorCode: null,
  channel: null,
  channelName: null,
}));

export const NODE_W = 150;
export const NODE_H = 48;
const COL_W = 190;
const ROW_H = 64;
const PAD = 14;

export type GraphNode = ActivityStep & { x: number; y: number };
export type GraphEdge = {
  from: string;
  to: string;
  optional: boolean;
  state: "idle" | "flowing" | "done" | "blocked";
};

/** Status of the synthetic delivery node from its run. */
function deliveryStatus(run: ActivityRun | null) {
  if (!run) return "idle";
  if (run.status === "done") return "done";
  if (run.status === "failed") return "failed";
  if (run.status === "canceled") return "canceled";
  // A partial run delivered what it could.
  if (run.status === "partial") return "done";
  return "pending";
}

function edgeState(from: string, to: string): GraphEdge["state"] {
  if (
    from === "running" ||
    (from === "done" && ["queued", "running"].includes(to))
  )
    return "flowing";
  if (from === "done" && to === "done") return "done";
  if (["failed", "skipped", "canceled"].includes(from)) return "blocked";
  return "idle";
}

/**
 * Lays the steps out in columns by dependency depth (inputs left of the
 * steps that use them), adds the delivery node after the steps nothing
 * depends on, and derives each edge's state from its two ends.
 */
export function layoutGraph(steps: ActivityStep[], run: ActivityRun | null) {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const depth = new Map<string, number>();
  const depthOf = (key: string, seen = new Set<string>()): number => {
    if (depth.has(key)) return depth.get(key)!;
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = (byKey.get(key)?.dependsOn ?? []).filter((d) => byKey.has(d));
    const value = deps.length
      ? Math.max(...deps.map((d) => depthOf(d, seen))) + 1
      : 0;
    depth.set(key, value);
    return value;
  };
  for (const step of steps) depthOf(step.key);
  const sinks = steps.filter(
    (step) => !steps.some((other) => other.dependsOn.includes(step.key)),
  );
  const all: ActivityStep[] = [
    ...steps,
    {
      key: "delivery",
      role: "delivery",
      status: deliveryStatus(run),
      dependsOn: sinks.map((step) => step.key),
      optionalDependsOn: [],
      errorCode: null,
      channel: null,
      channelName: null,
    },
  ];
  depth.set(
    "delivery",
    steps.length ? Math.max(...sinks.map((s) => depth.get(s.key)!)) + 1 : 0,
  );
  const columns: ActivityStep[][] = [];
  for (const step of all) (columns[depth.get(step.key)!] ??= []).push(step);
  const rows = Math.max(...columns.map((column) => column?.length ?? 0));
  const height = PAD * 2 + (rows - 1) * ROW_H + NODE_H;
  const nodes: GraphNode[] = [];
  columns.forEach((column, index) => {
    const top = (height - ((column.length - 1) * ROW_H + NODE_H)) / 2;
    column.forEach((step, row) =>
      nodes.push({ ...step, x: PAD + index * COL_W, y: top + row * ROW_H }),
    );
  });
  const status = new Map(all.map((step) => [step.key, step.status]));
  const edges: GraphEdge[] = all.flatMap((step) =>
    step.dependsOn
      .filter((from) => status.has(from))
      .map((from) => ({
        from,
        to: step.key,
        optional: step.optionalDependsOn.includes(from),
        state: edgeState(status.get(from)!, step.status),
      })),
  );
  return {
    nodes,
    edges,
    width: PAD * 2 + (columns.length - 1) * COL_W + NODE_W,
    height,
  };
}

// Characters that fit the second line of a node.
const SUB_MAX = 22;
const fit = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function edgePath(a: GraphNode, b: GraphNode) {
  const x1 = a.x + NODE_W,
    y1 = a.y + NODE_H / 2,
    x2 = b.x,
    y2 = b.y + NODE_H / 2,
    mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

export function AgentGraph({
  run,
  de,
  timezone,
}: {
  run: ActivityRun | null;
  de: boolean;
  timezone: string;
}) {
  const steps = run?.steps.length ? run.steps : TEMPLATE;
  const { nodes, edges, width, height } = layoutGraph(steps, run);
  const at = new Map(nodes.map((node) => [node.key, node]));
  const t = ([en, deText]: Text) => (de ? deText : en);
  // The delivery node names how the run hands over (no run yet: "Delivery").
  const label = (node: GraphNode) =>
    node.role === "delivery" && run
      ? run.delivery === "postiz_draft"
        ? t(["Postiz draft", "Postiz-Entwurf"])
        : t(["Publish", "Veröffentlichen"])
      : t(roles[node.role]?.label ?? [node.role, node.role]);
  const subLabel = (node: GraphNode) => {
    const state = t(stepStatus[node.status] ?? [node.status, node.status]);
    if (node.role === "delivery" && run?.firstSlotAt)
      return `${new Intl.DateTimeFormat(de ? "de" : "en", { timeStyle: "short", timeZone: timezone }).format(new Date(run.firstSlotAt))} · ${state}`;
    return node.channelName ? `${node.channelName} · ${state}` : state;
  };
  return (
    <div className="agent-graph-scroll">
      <svg
        className="agent-graph"
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: Math.min(width, 620) }}
        role="img"
        aria-label={
          de ? "Zusammenspiel der Agenten" : "How the agents work together"
        }
      >
        <title>
          {nodes.map((node) => `${label(node)}: ${subLabel(node)}`).join(", ")}
        </title>
        {edges.map((edge) => {
          const d = edgePath(at.get(edge.from)!, at.get(edge.to)!);
          return (
            <g
              key={`${edge.from}>${edge.to}`}
              className={`agent-edge edge-${edge.state}${edge.optional ? " edge-optional" : ""}`}
            >
              <path d={d} />
              {edge.state === "flowing" && (
                <circle className="agent-packet" r="3.5">
                  <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}
        {nodes.map((node) => {
          const Icon = roles[node.role]?.icon ?? CircleCheck;
          return (
            <g
              key={node.key}
              className={`agent-node node-${node.status}`}
              transform={`translate(${node.x},${node.y})`}
              data-step={node.key}
            >
              <title>
                {`${label(node)}: ${subLabel(node)}${node.errorCode ? ` (${node.errorCode})` : ""}`}
              </title>
              {node.status === "running" && (
                <rect
                  className="agent-halo"
                  width={NODE_W}
                  height={NODE_H}
                  rx="12"
                />
              )}
              <rect
                className="agent-card"
                width={NODE_W}
                height={NODE_H}
                rx="12"
              />
              <circle
                className="agent-icon-bg"
                cx="22"
                cy={NODE_H / 2}
                r="13"
              />
              <Icon x={14} y={NODE_H / 2 - 8} aria-hidden="true" />
              <text className="agent-label" x="42" y="21">
                {label(node)}
              </text>
              <text className="agent-sub" x="42" y="36">
                {fit(subLabel(node), SUB_MAX)}
              </text>
              {node.status === "done" && (
                <circle
                  className="agent-done-dot"
                  cx={NODE_W - 9}
                  cy="9"
                  r="4"
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The agent activity, refreshed in the background (every 15 s while a run
 * is open, else every minute, and only while the page is visible). Keeps the
 * last answer through a failed refresh; null while Orbit Agents is off.
 */
function useAgentActivity(projectId: string, revision: number) {
  const [state, setState] = useState<{
    key: string;
    data: AgentActivity | null;
    off: boolean;
    error: boolean;
  }>({ key: "", data: null, off: false, error: false });
  const key = `${projectId}:${revision}`;
  const open = Boolean(
    state.data?.runs.some((run) => ["planned", "running"].includes(run.status)),
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible")
        try {
          const data = await api<AgentActivity>(
            collectionPath(projectId, "agent-activity"),
          );
          if (!stopped) setState({ key, data, off: false, error: false });
        } catch (cause) {
          if (!stopped)
            setState((current) => ({
              key,
              data: current.key === key ? current.data : null,
              off: cause instanceof ApiError && cause.status === 404,
              error: true,
            }));
        }
      if (!stopped) timer = setTimeout(load, open ? 15000 : 60000);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [projectId, key, open]);
  return state.key === key ? state : { data: null, off: false, error: false };
}

function relative(at: string, de: boolean, now: number) {
  const minutes = Math.round((Date.parse(at) - now) / 60000);
  const format = new Intl.RelativeTimeFormat(de ? "de" : "en", {
    numeric: "auto",
  });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** Working and waiting specialists of the shown run, as short chips. */
function WorkingNow({ run, de }: { run: ActivityRun | null; de: boolean }) {
  const busy = (run?.steps ?? []).filter((step) =>
    ["running", "queued"].includes(step.status),
  );
  if (!busy.length)
    return (
      <p className="agent-working-none">
        {run && ["planned", "running"].includes(run.status)
          ? de
            ? "Gerade arbeitet niemand – der nächste Schritt wartet auf seine Eingaben."
            : "Nobody is working right now – the next step waits for its inputs."
          : de
            ? "Gerade arbeitet kein Agent."
            : "No agent is working right now."}
      </p>
    );
  return (
    <ul
      className="agent-working"
      aria-label={de ? "Arbeitet gerade" : "Working now"}
    >
      {busy.map((step) => {
        const role = roles[step.role];
        const Icon = role?.icon ?? CircleCheck;
        return (
          <li key={step.key} className={`working-${step.status}`}>
            <span className="working-dot" aria-hidden="true" />
            <Icon aria-hidden="true" />
            {(role?.label ?? [step.role, step.role])[de ? 1 : 0]}
            {step.channelName ? ` · ${step.channelName}` : ""}
            <small>
              {
                (stepStatus[step.status] ?? [step.status, step.status])[
                  de ? 1 : 0
                ]
              }
            </small>
          </li>
        );
      })}
    </ul>
  );
}

/** Overview panel: what the agents work on, what comes next and whether all is well. */
export function AgentActivityPanel() {
  const { project, revision, locale } = useWorkspace();
  const { data, off, error } = useAgentActivity(project.id, revision);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(tick);
  }, []);
  if (off || !data) return null;
  return (
    <AgentActivityView
      data={data}
      locale={locale}
      now={now}
      error={error}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

export function AgentActivityView({
  data,
  locale,
  now,
  error = false,
  selected = null,
  onSelect = () => undefined,
}: {
  data: AgentActivity;
  locale: string;
  now: number;
  error?: boolean;
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  const de = locale === "de";
  const run = data.runs.find((r) => r.id === selected) ?? data.runs[0] ?? null;
  const live = run && ["planned", "running"].includes(run.status);
  const state = data.health.state;
  return (
    <section
      className="panel agent-activity"
      aria-labelledby="agent-activity-title"
    >
      <div className="panel-head">
        <div>
          <h2 id="agent-activity-title">
            {de ? "Agenten-Zentrale" : "Agent hub"}
          </h2>
          <p>
            {run
              ? `${live ? (de ? "Aktueller Lauf" : "Current run") : de ? "Letzter Lauf" : "Last run"}: ${run.assignmentName ?? "—"} · ${(runStatus[run.status] ?? [run.status, run.status])[de ? 1 : 0]} · ${usd(run.costMicros)}`
              : data.activeAssignments
                ? de
                  ? "Noch kein Lauf – die Agenten sind bereit."
                  : "No run yet – the agents are ready."
                : de
                  ? "Kein aktiver Auftrag. Lege im Chat einen an, dann arbeiten die Agenten hier."
                  : "No active assignment. Create one in the chat and the agents work here."}
          </p>
        </div>
        <span className={`agent-health health-${state}`}>
          <span className="health-dot" aria-hidden="true" />
          <Badge tone={healthTone[state]}>
            {healthText[state][de ? 1 : 0]}
          </Badge>
        </span>
      </div>
      <div className="agent-activity-body">
        <div className="agent-activity-main">
          {data.runs.length > 1 && (
            <div className="agent-run-tabs" role="tablist">
              {data.runs.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={r.id === run?.id}
                  className={r.id === run?.id ? "active" : undefined}
                  onClick={() => onSelect(r.id)}
                >
                  {r.assignmentName ?? r.date}
                </button>
              ))}
            </div>
          )}
          <WorkingNow run={run} de={de} />
          <AgentGraph run={run} de={de} timezone={data.timezone} />
          <div className="agent-legend" aria-hidden="true">
            <span className="legend-running">
              {de ? "arbeitet" : "working"}
            </span>
            <span className="legend-done">{de ? "fertig" : "done"}</span>
            <span className="legend-pending">{de ? "wartet" : "waiting"}</span>
            <span className="legend-failed">{de ? "Fehler" : "failed"}</span>
            <span className="legend-optional">
              {de ? "optionale Eingabe" : "optional input"}
            </span>
          </div>
        </div>
        <aside className="agent-activity-side">
          <h3>{de ? "Als Nächstes" : "Up next"}</h3>
          {data.next.length ? (
            <ol className="agent-next">
              {data.next.map((item, index) => {
                const { icon: Icon, label } = nextText[item.kind];
                const row = (
                  <>
                    <Icon aria-hidden="true" />
                    <div>
                      <strong>{label[de ? 1 : 0]}</strong>
                      <p>
                        {[item.channelName, item.assignmentName]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </p>
                    </div>
                    <time
                      dateTime={item.at}
                      title={when(item.at, locale, data.timezone)}
                    >
                      {relative(item.at, de, now)}
                    </time>
                  </>
                );
                return (
                  <li
                    key={`${item.kind}:${item.at}:${index}`}
                    className={`next-${item.kind}`}
                  >
                    {item.kind === "owner_release" ? (
                      <Link href="/approvals">{row}</Link>
                    ) : (
                      <span>{row}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="panel-note">
              {de ? "Nichts geplant." : "Nothing scheduled."}
            </p>
          )}
          <h3>{de ? "Status" : "Health"}</h3>
          {data.health.issues.length ? (
            <ul className="agent-issues">
              {data.health.issues.map((issue) => {
                const text = (issueText[issue.code]?.(issue.count) ?? [
                  issue.code,
                  issue.code,
                ])[de ? 1 : 0];
                const href = issueLink[issue.code];
                return (
                  <li key={issue.code} className={`issue-${issue.severity}`}>
                    {href ? (
                      <Link href={href}>
                        {text}
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="agent-all-good">
              <CircleCheck aria-hidden="true" />
              {de ? "Alle Checks grün." : "All checks green."}
            </p>
          )}
          {error && (
            <p className="panel-note">
              {de
                ? "Aktualisierung fehlgeschlagen – zeige den letzten Stand."
                : "Refresh failed – showing the last known state."}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
