"use client";
import { useState } from "react";
import { collectionPath, post, useMutation, useResource, usd, when } from "@/lib/api";
import { Alert, Badge, Button, Loading } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";
import { approvalTitle, moduleLabel } from "@/platform/shell/approval-presentation";

// Settings → AI & budget → Agent permissions (ADR 0019): an owner lets the
// assistant or MCP clients run one internal action type within fixed limits
// without a decision each time. Paid work still counts against the AI
// spending authority above; publishing never runs under a permission.

type Mandate = {
  id: string;
  version: number;
  assistant: boolean;
  mcp: boolean;
  mcpClientIds: string[];
  maxCostMicrosPerAction: number;
  maxActionsPerDay: number;
  options: Record<string, string[]>;
  generatedImageRights: boolean;
  startAt: string;
  endAt: string;
  revokedAt?: string;
  inForce: boolean;
  usedToday: number;
};
type MandatableType = {
  actionType: string;
  module: string;
  riskClass: string;
  maxCostMicrosPerAction: number;
  options: Record<string, string[]>;
  generatesImages: boolean;
  mandate: Mandate | null;
};
type View = { enabled: boolean; items: MandatableType[] };

const OPTION_LABELS: Record<string, { en: string; de: string }> = {
  "art:generate": { en: "new AI image (paid)", de: "neues KI-Bild (kostenpflichtig)" },
  "art:asset": { en: "approved library image", de: "freigegebenes Bibliotheksbild" },
  "art:none": { en: "no image", de: "kein Bild" },
};

export function AgentMandateSettings() {
  const { locale, project, isOwner } = useWorkspace();
  const de = locale === "de";
  const view = useResource<View>(
    isOwner ? collectionPath(project.id, "agent-mandates") : null,
  );
  const [editing, setEditing] = useState<string | null>(null);
  if (!isOwner) return null;
  return (
    <section className="panel" aria-labelledby="agent-mandates-title">
      <div className="panel-head">
        <div>
          <h2 id="agent-mandates-title">
            {de ? "Agentenberechtigungen" : "Agent permissions"}
          </h2>
          <p>
            {de
              ? "Erlaube dem Assistenten oder verbundenen Apps (MCP), einzelne interne Aktionen innerhalb fester Grenzen ohne Einzelfreigabe auszuführen. Kosten zählen weiter gegen den KI-Ausgabenrahmen. Veröffentlichen, Versenden, Budget- und Regeländerungen brauchen immer deine Freigabe."
              : "Let the assistant or connected apps (MCP) run single internal actions within fixed limits without a decision each time. Costs still count against the AI spending authority. Publishing, sending, budget and rule changes always need your approval."}
          </p>
        </div>
      </div>
      {view.loading && !view.data && <Loading />}
      {view.error && <Alert kind="error">{view.error.message}</Alert>}
      {view.data && !view.data.enabled && (
        <Alert kind="info">
          {de
            ? "Agentenberechtigungen sind in dieser Installation ausgeschaltet. Jede Anfrage wartet auf eine Freigabe."
            : "Agent permissions are switched off in this installation. Every request waits for an approval."}
        </Alert>
      )}
      {view.data?.enabled &&
        view.data.items.map((type) => (
          <MandateRow
            key={type.actionType}
            type={type}
            de={de}
            editing={editing === type.actionType}
            onEdit={() => setEditing(type.actionType)}
            onDone={() => {
              setEditing(null);
              view.refresh();
            }}
          />
        ))}
    </section>
  );
}

function MandateRow({
  type,
  de,
  editing,
  onEdit,
  onDone,
}: {
  type: MandatableType;
  de: boolean;
  editing: boolean;
  onEdit(): void;
  onDone(): void;
}) {
  const { project } = useWorkspace();
  const revoke = useMutation(onDone);
  const m = type.mandate?.inForce ? type.mandate : null;
  const channels = m
    ? [
        m.assistant ? (de ? "Assistent" : "Assistant") : null,
        m.mcp
          ? m.mcpClientIds.length
            ? `MCP (${m.mcpClientIds.length} ${de ? "Apps" : "apps"})`
            : "MCP"
          : null,
      ].filter(Boolean)
    : [];
  return (
    <div className="data-row">
      <div>
        <strong>{approvalTitle(type.actionType, de)}</strong>
        <p>
          {moduleLabel(type.module, de)} ·{" "}
          {m ? (
            <>
              <Badge tone="success">{de ? "erlaubt" : "allowed"}</Badge>{" "}
              {channels.join(", ")} · {de ? "bis" : "up to"}{" "}
              {usd(m.maxCostMicrosPerAction)} {de ? "je Aktion" : "per action"} ·{" "}
              {m.usedToday}/{m.maxActionsPerDay} {de ? "heute" : "today"} ·{" "}
              {de ? "gültig bis" : "valid until"} {when(m.endAt)}
              {m.generatedImageRights &&
                (de
                  ? " · Nutzungsrechte für neue KI-Bilder erteilt"
                  : " · usage rights for new AI images granted")}
            </>
          ) : (
            <Badge tone="neutral">
              {de ? "Einzelfreigabe" : "Approval each time"}
            </Badge>
          )}
        </p>
        {revoke.error && <Alert kind="error">{revoke.error}</Alert>}
        {editing && (
          <MandateForm
            type={type}
            de={de}
            onClose={onDone}
          />
        )}
      </div>
      {!editing && (
        <div className="chat-links">
          <Button variant="outline" onClick={onEdit}>
            {m ? (de ? "Ändern" : "Change") : de ? "Erlauben" : "Allow"}
          </Button>
          {m && (
            <Button
              variant="outline"
              disabled={revoke.pending}
              onClick={() =>
                revoke.run(() =>
                  post(
                    collectionPath(project.id, `agent-mandates/${m.id}/revoke`),
                    { version: m.version },
                  ),
                )
              }
            >
              {de ? "Widerrufen" : "Revoke"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MandateForm({
  type,
  de,
  onClose,
}: {
  type: MandatableType;
  de: boolean;
  onClose(): void;
}) {
  const { project } = useWorkspace();
  const current = type.mandate?.inForce ? type.mandate : null;
  const [assistant, setAssistant] = useState(current?.assistant ?? true);
  const [mcp, setMcp] = useState(current?.mcp ?? false);
  const [costUsd, setCostUsd] = useState(
    String((current?.maxCostMicrosPerAction ?? Math.min(type.maxCostMicrosPerAction, 500_000)) / 1_000_000),
  );
  const [perDay, setPerDay] = useState(String(current?.maxActionsPerDay ?? 10));
  const [days, setDays] = useState("30");
  const [options, setOptions] = useState<Record<string, string[]>>(
    current?.options && Object.keys(current.options).length
      ? current.options
      : type.options,
  );
  const [rights, setRights] = useState(current?.generatedImageRights ?? false);
  const save = useMutation(onClose);
  const toggle = (key: string, value: string) =>
    setOptions((prev) => {
      const list = prev[key] ?? [];
      return {
        ...prev,
        [key]: list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value],
      };
    });
  const limit = usd(type.maxCostMicrosPerAction);
  const generateAllowed = (options.art ?? []).includes("generate");
  return (
    <form
      className="settings-form agent-mandate-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(() =>
          post(collectionPath(project.id, "agent-mandates"), {
            actionType: type.actionType,
            assistant,
            mcp,
            mcpClientIds: current?.mcpClientIds ?? [],
            maxCostMicrosPerAction: Math.round(Number(costUsd) * 1_000_000),
            maxActionsPerDay: Number(perDay),
            days: Number(days),
            options,
            generatedImageRights: type.generatesImages && generateAllowed && rights,
          }),
        );
      }}
    >
      <fieldset>
        <legend>{de ? "Wer darf" : "Who may"}</legend>
        <label>
          <input
            type="checkbox"
            checked={assistant}
            onChange={(e) => setAssistant(e.target.checked)}
          />{" "}
          {de ? "Orbit-Assistent (deine Chats)" : "Orbit Assistant (your chats)"}
        </label>
        <label>
          <input
            type="checkbox"
            checked={mcp}
            onChange={(e) => setMcp(e.target.checked)}
          />{" "}
          {de
            ? "Verbundene Apps (MCP), die du selbst autorisiert hast"
            : "Connected apps (MCP) you authorized yourself"}
        </label>
        <p className="chat-package-note">
          {de
            ? "Gilt nur für Anfragen, die du selbst stellst. Delegierte Arbeitsaufträge brauchen weiter eine Freigabe."
            : "Covers only requests you make yourself. Delegated work orders still need an approval."}
        </p>
      </fieldset>
      {Object.entries(type.options).map(([key, values]) => (
        <fieldset key={key}>
          <legend>{de ? "Erlaubte Varianten" : "Allowed variants"}</legend>
          {values.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={(options[key] ?? []).includes(value)}
                onChange={() => toggle(key, value)}
              />{" "}
              {OPTION_LABELS[`${key}:${value}`]?.[de ? "de" : "en"] ?? value}
            </label>
          ))}
        </fieldset>
      ))}
      <label>
        {de ? `Höchstkosten je Aktion in USD (max. ${limit})` : `Maximum cost per action in USD (max ${limit})`}
        <input
          type="number"
          min="0"
          step="0.01"
          value={costUsd}
          onChange={(e) => setCostUsd(e.target.value)}
        />
      </label>
      <label>
        {de ? "Aktionen pro Tag" : "Actions per day"}
        <input
          type="number"
          min="1"
          max="100"
          value={perDay}
          onChange={(e) => setPerDay(e.target.value)}
        />
      </label>
      <label>
        {de ? "Gültig für Tage (max. 90)" : "Valid for days (max 90)"}
        <input
          type="number"
          min="1"
          max="90"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      {type.generatesImages && generateAllowed && (
        <label>
          <input
            type="checkbox"
            checked={rights}
            onChange={(e) => setRights(e.target.checked)}
          />{" "}
          {de
            ? "Neue KI-Bilder, die unter dieser Berechtigung mit dem aktuell eingestellten Bildmodell und Preis entstehen, dürfen für Social-Media-Inhalte dieses Projekts verwendet werden (keine Logos, keine realen Personen, kein Text im Bild). Ändert sich Bildmodell oder Preis, gilt diese Zustimmung nicht mehr."
            : "New AI images made under this permission with the current image model and price may be used for this project's social content (no logos, no real persons, no text in the image). If the image model or price changes, this consent no longer applies."}
        </label>
      )}
      {save.error && <Alert kind="error">{save.error}</Alert>}
      <div className="chat-links">
        <Button type="submit" disabled={save.pending || (!assistant && !mcp)}>
          {de ? "Berechtigung speichern" : "Save permission"}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {de ? "Abbrechen" : "Cancel"}
        </Button>
      </div>
    </form>
  );
}
