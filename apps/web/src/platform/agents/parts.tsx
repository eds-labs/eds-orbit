"use client";
// Shared pieces of the agent pages (ADR 0021, WP1.8): status badges, the
// readable error, the tool catalogue with its badges and the review diff.
import { Alert, Badge } from "@/components/ui/primitives";
import { moduleLabel } from "@/platform/shell/approval-presentation";
import type { Locale } from "@/lib/i18n";
import { configDiff, toolBadges, toolSelectable } from "./logic";
import {
  agentErrorText,
  agentStatusText,
  refusalText,
  riskText,
  statusTone,
  workStatusText,
} from "./text";
import type {
  AgentConfig,
  AgentStatus,
  AgentTemplate,
  CatalogTool,
  WorkOrderStatus,
} from "./types";

export function AgentStatusBadge({
  status,
  locale,
}: {
  status: AgentStatus;
  locale: Locale;
}) {
  return (
    <Badge tone={statusTone(status)}>{agentStatusText(status, locale)}</Badge>
  );
}

export function WorkStatusBadge({
  status,
  locale,
}: {
  status: WorkOrderStatus;
  locale: Locale;
}) {
  return (
    <Badge tone={statusTone(status)}>{workStatusText(status, locale)}</Badge>
  );
}

/** A failed request or execution as a sentence, with its code for support. */
export function AgentError({
  code,
  locale,
}: {
  code: string | null | undefined;
  locale: Locale;
}) {
  if (!code) return null;
  return (
    <Alert kind="error">
      <p>{agentErrorText(code, locale)}</p>
      <p className="agents-code">
        <code>{code}</code>
      </p>
    </Alert>
  );
}

const domId = (name: string) =>
  `agent-tool-${name.replace(/[^a-z0-9_-]/gi, "-")}`;

/**
 * The tools an agent may be given, grouped by module, each with risk, cost,
 * "needs approval", "mandatable" and data-class badges (plan §3 WP1.8). A
 * tool the member cannot grant, whose module is not chosen or which the
 * template forbids is shown disabled with the reason; a tool the template
 * requires stays checked.
 */
export function ToolCatalog({
  tools,
  config,
  guard,
  locale,
  onToggle,
  readOnly = false,
}: {
  tools: readonly CatalogTool[];
  config: Pick<AgentConfig, "modules" | "tools">;
  guard?: AgentTemplate["guard"];
  locale: Locale;
  onToggle?: (name: string, on: boolean) => void;
  readOnly?: boolean;
}) {
  const de = locale === "de";
  const groups = new Map<string, CatalogTool[]>();
  for (const tool of tools)
    groups.set(tool.module, [...(groups.get(tool.module) ?? []), tool]);
  if (!tools.length)
    return (
      <p className="agents-note">
        {de
          ? "Keine Tools für Agenten verfügbar."
          : "No tools are available to agents."}
      </p>
    );
  return (
    <div className="agents-catalog">
      {[...groups].map(([module, list]) => (
        <fieldset key={module} className="agents-tool-group">
          <legend>
            {module === "platform"
              ? de
                ? "Plattform"
                : "Platform"
              : moduleLabel(module, de)}
          </legend>
          {list.map((tool) => {
            const checked = config.tools.includes(tool.name);
            const forbidden = guard?.forbiddenTools?.includes(tool.name);
            const required = guard?.requiredTools?.includes(tool.name);
            const moduleMissing =
              tool.module !== "platform" &&
              !config.modules.includes(tool.module);
            const reason = !tool.grantable
              ? refusalText(tool.reason, locale)
              : forbidden
                ? de
                  ? "Die Vorlage verbietet dieses Tool."
                  : "The template forbids this tool."
                : moduleMissing
                  ? de
                    ? `Wähle zuerst das Modul ${moduleLabel(tool.module, de)}.`
                    : `Choose the ${moduleLabel(tool.module, de)} module first.`
                  : required
                    ? de
                      ? "Die Vorlage verlangt dieses Tool."
                      : "The template requires this tool."
                    : null;
            const disabled =
              readOnly ||
              !toolSelectable(tool, config.modules) ||
              Boolean(forbidden) ||
              Boolean(required && checked);
            const id = domId(tool.name);
            return (
              <div
                key={tool.name}
                className="agents-tool"
                data-disabled={
                  !tool.grantable || forbidden || moduleMissing
                    ? "true"
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  className="input"
                  id={id}
                  checked={checked}
                  disabled={disabled}
                  aria-describedby={`${id}-summary${reason ? ` ${id}-reason` : ""}`}
                  onChange={(e) => onToggle?.(tool.name, e.target.checked)}
                />
                <div>
                  <label htmlFor={id}>
                    <strong>{tool.title[locale]}</strong>{" "}
                    <code>{tool.name}</code>
                  </label>
                  <p id={`${id}-summary`}>{tool.summary[locale]}</p>
                  <div className="agents-badges">
                    <Badge
                      tone={
                        tool.risk === "P_proposal"
                          ? "warning"
                          : tool.risk === "W0_internal"
                            ? "blue"
                            : "neutral"
                      }
                    >
                      {riskText(tool.risk, locale)}
                    </Badge>
                    {toolBadges(tool, locale).map((b) => (
                      <Badge key={b.key} tone={b.tone}>
                        {b.text}
                      </Badge>
                    ))}
                  </div>
                  {reason && (
                    <p id={`${id}-reason`} className="agents-reason">
                      {reason}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

/** The fields the draft changes against the active version. */
export function ReviewDiff({
  active,
  draft,
  locale,
}: {
  active: AgentConfig | null;
  draft: AgentConfig | null;
  locale: Locale;
}) {
  const de = locale === "de";
  const rows = configDiff(active, draft, locale);
  if (!draft)
    return (
      <p className="agents-note">
        {de ? "Es gibt keinen Entwurf." : "There is no draft."}
      </p>
    );
  if (!rows.length)
    return (
      <p className="agents-note">
        {de
          ? "Der Entwurf entspricht der aktiven Version."
          : "The draft matches the active version."}
      </p>
    );
  return (
    <div className="table-wrap agents-diff">
      <table>
        <caption className="sr-only">
          {de
            ? "Änderungen gegenüber der aktiven Version"
            : "Changes against the active version"}
        </caption>
        <thead>
          <tr>
            <th scope="col">{de ? "Feld" : "Field"}</th>
            <th scope="col">
              {active ? (de ? "Aktiv" : "Active") : de ? "Bisher" : "Before"}
            </th>
            <th scope="col">{de ? "Entwurf" : "Draft"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <th scope="row">{row.label}</th>
              <td>
                <span className="sr-only">{de ? "Vorher: " : "Before: "}</span>
                <del>{row.before}</del>
              </td>
              <td>
                <span className="sr-only">{de ? "Nachher: " : "After: "}</span>
                <ins>{row.after}</ins>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
