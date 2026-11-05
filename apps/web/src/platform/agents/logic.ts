// Pure helpers of the agent pages (ADR 0021, WP1.8): where a path leads,
// the builder's configuration edits, the review diff, the activation body
// and the overview figures. No React, so each is unit-tested.
import { usd } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { dataClassText, fieldText, modeText, weekdayText } from "./text";
import type {
  AgentConfig,
  AgentTemplate,
  AgentView,
  CatalogTool,
  Trigger,
  WorkOrderPage,
  WorkOrderView,
} from "./types";

/** The page of the agents area a pathname below /p/:projectId/agents opens. */
export type AgentsPlace =
  | { view: "list" }
  | { view: "new" }
  | { view: "agent"; agentId: string }
  | { view: "execution"; agentId: string; workOrderId: string }
  | { view: "notFound" };

const ID = /^[A-Za-z0-9-]{1,64}$/;

export function agentsPlace(pathname: string): AgentsPlace {
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("agents");
  if (parts[0] !== "p" || at !== 2) return { view: "notFound" };
  const rest = parts.slice(3).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!rest.length) return { view: "list" };
  if (rest.length === 1 && rest[0] === "new") return { view: "new" };
  const [agentId, section, workOrderId, ...more] = rest;
  if (!agentId || !ID.test(agentId) || more.length) return { view: "notFound" };
  if (!section) return { view: "agent", agentId };
  if (section === "executions" && workOrderId && ID.test(workOrderId))
    return { view: "execution", agentId, workOrderId };
  return { view: "notFound" };
}

/** The URL of a page of the agents area below the agents root `base`. */
export const agentHref = (base: string, agentId: string, tab?: string) =>
  `${base}/${encodeURIComponent(agentId)}${tab && tab !== "overview" ? `?tab=${encodeURIComponent(tab)}` : ""}`;
export const executionHref = (
  base: string,
  agentId: string,
  workOrderId: string,
) =>
  `${base}/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(workOrderId)}`;

export const AGENT_TABS = [
  "overview",
  "configuration",
  "versions",
  "executions",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const agentTab = (value: string | null | undefined): AgentTab =>
  (AGENT_TABS as readonly string[]).includes(value ?? "")
    ? (value as AgentTab)
    : "overview";

/**
 * Whether the sidebar shows "Agents": the member may read agents (owner or
 * editor of the project) and the agents API answered, so the platform is on.
 * A 404 (flag off) or 403 hides the entry; deep links keep working and show
 * the API's answer.
 */
export function agentPlatformVisible(
  role: string | undefined,
  probe: { data: unknown; error: unknown },
) {
  if (role !== "owner" && role !== "editor") return false;
  return Boolean(probe.data) && !probe.error;
}

/** A new agent's configuration: safe defaults, then the template's. */
export function defaultConfig(template?: AgentTemplate | null): AgentConfig {
  const base: AgentConfig = {
    name: "",
    description: "",
    templateKey: null,
    instructions: "",
    modules: [],
    tools: [],
    knowledge: null,
    mode: "read",
    model: { override: null },
    limits: {
      maxModelCalls: 4,
      maxToolCalls: 8,
      wallSeconds: 120,
      maxRunsPerDay: 10,
      maxConcurrent: 1,
    },
    budget: { monthlyCeilingMicros: 5_000_000, runCeilingMicros: 500_000 },
    triggers: [{ kind: "manual" }],
    delegateTo: [],
    outputs: { notify: ["sponsor"], onFailure: "notify" },
  };
  if (!template) return base;
  const d = template.defaults;
  const config: AgentConfig = {
    ...base,
    ...d,
    model: { ...base.model, ...d.model },
    limits: { ...base.limits, ...d.limits },
    budget: { ...base.budget, ...d.budget },
    outputs: { ...base.outputs, ...d.outputs },
    name: d.name ?? template.title.en,
    templateKey: template.key,
  };
  if (!config.modules.length && template.module !== "platform")
    config.modules = [template.module];
  for (const tool of template.guard.requiredTools ?? [])
    if (!config.tools.includes(tool)) config.tools = [...config.tools, tool];
  return config;
}

/** Whether the builder offers the tool for selection. */
export function toolSelectable(tool: CatalogTool, modules: readonly string[]) {
  return (
    tool.grantable &&
    (tool.module === "platform" || modules.includes(tool.module))
  );
}

/**
 * Switches a module on or off. Switching it off drops its tools, so the
 * draft never names a tool outside its modules (the server refuses that).
 */
export function setModule(
  config: AgentConfig,
  module: string,
  on: boolean,
  tools: readonly CatalogTool[],
): AgentConfig {
  if (on)
    return config.modules.includes(module)
      ? config
      : { ...config, modules: [...config.modules, module] };
  const owned = new Set(
    tools.filter((t) => t.module === module).map((t) => t.name),
  );
  return {
    ...config,
    modules: config.modules.filter((m) => m !== module),
    tools: config.tools.filter((t) => !owned.has(t)),
    triggers: config.triggers.filter(
      (t) => t.kind !== "event" || !t.type.startsWith(`${module}.`),
    ),
  };
}

export function setTool(
  config: AgentConfig,
  tool: string,
  on: boolean,
): AgentConfig {
  const has = config.tools.includes(tool);
  if (on === has) return config;
  return {
    ...config,
    tools: on
      ? [...config.tools, tool]
      : config.tools.filter((t) => t !== tool),
  };
}

/** USD text to micros; null when it is not a non-negative amount. */
export function usdToMicros(text: string): number | null {
  if (!/^\s*\d+(\.\d{0,6})?\s*$/.test(text)) return null;
  return Math.round(Number(text) * 1_000_000);
}
export const microsToUsdText = (micros: number) =>
  String(Math.round(micros) / 1_000_000);

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Problems the builder can see before the server does (it checks again). */
export function configProblems(config: AgentConfig, locale: Locale): string[] {
  const de = locale === "de";
  const out: string[] = [];
  if (!config.name.trim())
    out.push(de ? "Gib dem Agenten einen Namen." : "Give the agent a name.");
  if (!config.modules.length)
    out.push(
      de ? "Wähle mindestens ein Modul." : "Choose at least one module.",
    );
  if (!config.tools.length)
    out.push(de ? "Wähle mindestens ein Tool." : "Choose at least one tool.");
  if (config.budget.runCeilingMicros > config.budget.monthlyCeilingMicros)
    out.push(
      de
        ? "Die Obergrenze je Ausführung liegt über der Monatsobergrenze."
        : "The ceiling per execution is above the monthly ceiling.",
    );
  if (
    config.budget.runCeilingMicros < 1 ||
    config.budget.monthlyCeilingMicros < 1
  )
    out.push(
      de ? "Budgets müssen über 0 USD liegen." : "Budgets must be above 0 USD.",
    );
  for (const trigger of config.triggers)
    if (trigger.kind === "schedule") {
      if (trigger.rhythm !== "interval" && !trigger.times.length)
        out.push(
          de
            ? "Ein Zeitplan braucht eine Uhrzeit."
            : "A schedule needs a time.",
        );
      if (trigger.rhythm === "weekly" && !trigger.days?.length)
        out.push(
          de
            ? "Ein Wochenplan braucht einen Tag."
            : "A weekly schedule needs a day.",
        );
      const times = trigger.times ?? [];
      if (
        times.some((t) => !LOCAL_TIME.test(t)) ||
        new Set(times).size !== times.length
      )
        out.push(
          de
            ? "Uhrzeiten eines Zeitplans müssen gültig und verschieden sein (HH:MM)."
            : "A schedule's times must be valid and different (HH:MM).",
        );
    }
  return out;
}

/** The body of POST …/activate: the version and draft hash shown. */
export function activationBody(
  agent: Pick<AgentView, "version" | "draftHash">,
) {
  return agent.draftHash
    ? { version: agent.version, configHash: agent.draftHash }
    : null;
}

/** JSON with sorted keys, so key order never counts as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function triggerText(trigger: Trigger, locale: Locale): string {
  const de = locale === "de";
  if (trigger.kind === "manual") return de ? "Von Hand" : "By hand";
  if (trigger.kind === "event")
    return `${de ? "Ereignis" : "Event"} ${trigger.type}${trigger.debounceSeconds ? ` (${trigger.debounceSeconds} s)` : ""}`;
  if (trigger.rhythm === "interval")
    return de
      ? `Alle ${trigger.everyMinutes ?? "?"} Minuten`
      : `Every ${trigger.everyMinutes ?? "?"} minutes`;
  const times = trigger.times.join(", ");
  if (trigger.rhythm === "daily")
    return de ? `Täglich ${times}` : `Daily ${times}`;
  const days = (trigger.days ?? [])
    .map((d) => weekdayText(d, locale))
    .join(", ");
  return de ? `Wöchentlich ${days} ${times}` : `Weekly ${days} ${times}`;
}

/** One configuration field as text for the review. */
export function fieldValueText(
  field: keyof AgentConfig,
  config: AgentConfig | null,
  locale: Locale,
): string {
  const de = locale === "de";
  if (!config) return "—";
  const v = config[field];
  switch (field) {
    case "mode":
      return modeText(config.mode, locale);
    case "budget":
      return `${usd(config.budget.monthlyCeilingMicros)} ${de ? "pro Monat" : "per month"}, ${usd(config.budget.runCeilingMicros)} ${de ? "je Ausführung" : "per execution"}`;
    case "limits": {
      const l = config.limits;
      return de
        ? `${l.maxModelCalls} Modellaufrufe, ${l.maxToolCalls} Tool-Aufrufe, ${l.wallSeconds} s, ${l.maxRunsPerDay} pro Tag, ${l.maxConcurrent} gleichzeitig`
        : `${l.maxModelCalls} model calls, ${l.maxToolCalls} tool calls, ${l.wallSeconds} s, ${l.maxRunsPerDay} per day, ${l.maxConcurrent} at once`;
    }
    case "model":
      return config.model.override ?? (de ? "Standardroute" : "Default route");
    case "triggers":
      return config.triggers.length
        ? config.triggers.map((t) => triggerText(t, locale)).join("; ")
        : "—";
    case "knowledge": {
      const k = config.knowledge;
      if (!k) return de ? "Keine Auswahl" : "No selection";
      const parts = [];
      if (k.sourceIds?.length)
        parts.push(`${k.sourceIds.length} ${de ? "Quellen" : "sources"}`);
      if (k.audiences?.length) parts.push(k.audiences.join(", "));
      return parts.join(", ") || (de ? "Keine Auswahl" : "No selection");
    }
    case "outputs":
      return `${config.outputs.notify.join(", ") || "—"}; ${de ? "bei Fehlern" : "on failure"}: ${config.outputs.onFailure}`;
    case "instructions":
    case "description":
      return String(v ?? "") || "—";
    default:
      return Array.isArray(v)
        ? v.join(", ") || "—"
        : v === null || v === undefined
          ? "—"
          : String(v);
  }
}

export const CONFIG_FIELDS: ReadonlyArray<keyof AgentConfig> = [
  "name",
  "description",
  "templateKey",
  "instructions",
  "modules",
  "tools",
  "knowledge",
  "mode",
  "model",
  "limits",
  "budget",
  "triggers",
  "delegateTo",
  "outputs",
];

export type DiffRow = {
  field: keyof AgentConfig;
  label: string;
  before: string;
  after: string;
};

/**
 * The fields the draft changes against the active configuration, in
 * builder order. Without an active configuration every field is new.
 */
export function configDiff(
  active: AgentConfig | null,
  draft: AgentConfig | null,
  locale: Locale,
): DiffRow[] {
  if (!draft) return [];
  return CONFIG_FIELDS.filter(
    (field) => !active || canonical(active[field]) !== canonical(draft[field]),
  ).map((field) => ({
    field,
    label: fieldText(field, locale),
    before: fieldValueText(field, active, locale),
    after: fieldValueText(field, draft, locale),
  }));
}

/** Tool badges in display order, for the catalogue and the review. */
export function toolBadges(tool: CatalogTool, locale: Locale) {
  const de = locale === "de";
  const out: Array<{
    key: string;
    text: string;
    tone: "neutral" | "warning" | "danger" | "blue" | "success";
  }> = [];
  out.push({
    key: "cost",
    text:
      tool.cost === "paid"
        ? de
          ? "Kostenpflichtig"
          : "Paid"
        : de
          ? "Ohne Kosten"
          : "No cost",
    tone: tool.cost === "paid" ? "warning" : "neutral",
  });
  if (tool.needsApproval)
    out.push({
      key: "approval",
      text: de ? "Braucht Freigabe" : "Needs approval",
      tone: "warning",
    });
  if (tool.mandatable)
    out.push({
      key: "mandatable",
      text: de ? "Per Berechtigung freigebbar" : "Mandatable",
      tone: "blue",
    });
  out.push({
    key: "data",
    text: dataClassText(tool.dataClass, locale),
    tone: tool.dataClass === "internal" ? "neutral" : "danger",
  });
  return out;
}

const FAILED = new Set(["failed", "blocked", "outcome_unknown"]);

export type AgentFigures = {
  lastRun: WorkOrderView | null;
  failures24h: number;
  /** Null when the loaded page may not cover the whole month. */
  monthSpentMicros: number | null;
};

/**
 * Last run, failures in the last 24 hours and this UTC month's spend of
 * each agent, from the newest page of work orders. The API has no per-agent
 * figures yet: counts are lower bounds when the page is full ("+"), and the
 * month's spend is shown only when the page reaches back to the month start.
 */
export function agentFigures(
  page: WorkOrderPage | null,
  now = new Date(),
): {
  byAgent: Map<string, AgentFigures>;
  complete24h: boolean;
  completeMonth: boolean;
} {
  const byAgent = new Map<string, AgentFigures>();
  const items = page?.items ?? [];
  const since = now.getTime() - 86_400_000;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const oldest = items.length
    ? Date.parse(items[items.length - 1]!.createdAt)
    : Infinity;
  const completeMonth =
    Boolean(page) && (!page!.nextCursor || oldest < monthStart);
  const complete24h = Boolean(page) && (!page!.nextCursor || oldest < since);
  for (const item of items) {
    if (!item.agentId) continue;
    const f = byAgent.get(item.agentId) ?? {
      lastRun: null,
      failures24h: 0,
      monthSpentMicros: 0,
    };
    if (
      !f.lastRun ||
      Date.parse(item.createdAt) > Date.parse(f.lastRun.createdAt)
    )
      f.lastRun = item;
    const ended = Date.parse(item.finishedAt ?? item.createdAt);
    if (FAILED.has(item.status) && ended >= since) f.failures24h += 1;
    if (Date.parse(item.createdAt) >= monthStart)
      f.monthSpentMicros = (f.monthSpentMicros ?? 0) + item.spentMicros;
    byAgent.set(item.agentId, f);
  }
  if (!completeMonth)
    for (const f of byAgent.values()) f.monthSpentMicros = null;
  return { byAgent, complete24h, completeMonth };
}

export const OPEN_WORK = new Set([
  "queued",
  "awaiting_start",
  "running",
  "waiting_approval",
]);
