"use client";
// The guided setup of the Support agent template (ADR 0021 Phase 2, plan
// WP2.6): choose the inboxes and confirm the knowledge audience. The
// platform's builder adds the budget and create steps; activation stays the
// owner's step on the agent's page. The server checks the filter again
// (inboxIds: 1..20 uuids) on save and on activation.
import { Check } from "lucide-react";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { AgentConfig } from "@/platform/agents/types";
import type { AgentSetup, AgentSetupStepProps } from "@/platform/shell/types";
import { supportPath, type Inbox } from "./api";
import { supportText } from "./labels";

export const SUPPORT_TICKET_AGENT = "support.ticket_agent";
/** The Support events the template's triggers start on. */
export const SUPPORT_AGENT_EVENTS = [
  "support.ticket.created",
  "support.message.received",
] as const;
export const MAX_FILTER_INBOXES = 20;

const supportEvent = (type: string) =>
  (SUPPORT_AGENT_EVENTS as readonly string[]).includes(type);

/** The inboxes the Support event triggers are limited to; empty: all. */
export function inboxFilterIds(config: AgentConfig): string[] {
  for (const trigger of config.triggers)
    if (trigger.kind === "event" && supportEvent(trigger.type)) {
      const ids = trigger.filter.inboxIds;
      return Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === "string")
        : [];
    }
  return [];
}

/**
 * Writes the chosen inboxes into the filter of both Support event triggers.
 * No inbox removes the key, so the agent covers every inbox in agent mode.
 */
export function withInboxFilter(
  config: AgentConfig,
  ids: readonly string[],
): AgentConfig {
  const chosen = [...new Set(ids)].slice(0, MAX_FILTER_INBOXES);
  return {
    ...config,
    triggers: config.triggers.map((trigger) => {
      if (trigger.kind !== "event" || !supportEvent(trigger.type))
        return trigger;
      const { inboxIds: _old, ...rest } = trigger.filter;
      return {
        ...trigger,
        filter: chosen.length ? { ...rest, inboxIds: chosen } : rest,
      };
    }),
  };
}

const modeName = (mode: string, locale: Locale) => {
  const s = supportText(locale).settings;
  return mode === "agent" ? s.aiAgent : mode === "draft" ? s.aiDraft : s.aiOff;
};

/** Step 1: the inboxes the agent works on. */
export function InboxStep({
  config,
  locale,
  disabled,
  onChange,
}: AgentSetupStepProps) {
  const { project } = useWorkspace();
  const de = locale === "de";
  const inboxes = useResource<{ items: Inbox[] }>(
    supportPath(project.id, "/inboxes"),
  );
  if (inboxes.loading) return <Loading />;
  if (inboxes.error || !inboxes.data)
    return (
      <Alert kind="error">
        {de
          ? "Die Posteingänge des Supports sind nicht abrufbar."
          : "The Support inboxes cannot be listed."}
      </Alert>
    );
  const live = inboxes.data.items.filter((i) => !i.archivedAt);
  const chosen = inboxFilterIds(config);
  const toggle = (id: string, on: boolean) =>
    onChange(
      withInboxFilter(
        config,
        on ? [...chosen, id] : chosen.filter((x) => x !== id),
      ),
    );
  return (
    <fieldset className="agents-choices">
      <legend>{de ? "Posteingänge" : "Inboxes"}</legend>
      {!live.length && (
        <p className="agents-note">
          {de
            ? "Noch kein Posteingang. Ein Owner legt einen unter Einstellungen, Support an."
            : "No inbox yet. An owner creates one in Settings, Support."}
        </p>
      )}
      {live.map((inbox) => {
        const checked = chosen.includes(inbox.id);
        return (
          <label key={inbox.id} className="agents-check">
            <input
              type="checkbox"
              className="input"
              value={inbox.id}
              checked={checked}
              disabled={
                disabled || (!checked && chosen.length >= MAX_FILTER_INBOXES)
              }
              onChange={(e) => toggle(inbox.id, e.target.checked)}
            />
            <span>
              {inbox.name} · {de ? "KI" : "AI"}:{" "}
              {modeName(inbox.aiMode, locale)}
              {inbox.aiMode !== "agent" &&
                (de
                  ? " (der Agent arbeitet hier erst im Modus Agent)"
                  : " (the agent works here only in Agent mode)")}
            </span>
          </label>
        );
      })}
      <p className="agents-note">
        {chosen.length
          ? de
            ? `${chosen.length} ausgewählt (höchstens ${MAX_FILTER_INBOXES}).`
            : `${chosen.length} chosen (at most ${MAX_FILTER_INBOXES}).`
          : de
            ? "Keine Auswahl: Der Agent arbeitet in jedem Posteingang im Modus Agent."
            : "No choice: the agent works in every inbox in Agent mode."}
      </p>
    </fieldset>
  );
}

/** Step 2: the knowledge audience, confirmed by the template. */
export function KnowledgeStep({ config, locale }: AgentSetupStepProps) {
  const de = locale === "de";
  const support = Boolean(config.knowledge?.audiences?.includes("support"));
  return (
    <div className="agents-wrap">
      {support ? (
        <Badge tone="success">
          <Check aria-hidden size={13} /> {de ? "Bestätigt" : "Confirmed"}
        </Badge>
      ) : (
        <Badge tone="warning">{de ? "Nicht gesetzt" : "Not set"}</Badge>
      )}
      <p className="agents-note">
        {support
          ? de
            ? "Zielgruppe Support: Der Agent nutzt nur Wissen, das für den Support freigegeben ist."
            : "Audience Support: the agent uses only knowledge released for Support."
          : de
            ? "Die Zielgruppe Support fehlt. Wähle sie in den vollständigen Einstellungen unter Wissen."
            : "The Support audience is missing. Choose it under Knowledge in all settings."}
      </p>
    </div>
  );
}

export const supportAgentSetups: Readonly<Record<string, AgentSetup>> = {
  [SUPPORT_TICKET_AGENT]: {
    steps: [
      {
        key: "inboxes",
        title: { en: "Choose inboxes", de: "Posteingänge wählen" },
        component: InboxStep,
      },
      {
        key: "knowledge",
        title: {
          en: "Confirm the knowledge audience",
          de: "Wissens-Zielgruppe bestätigen",
        },
        component: KnowledgeStep,
      },
    ],
  },
};
