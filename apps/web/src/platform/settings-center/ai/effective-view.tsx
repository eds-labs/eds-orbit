"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usd, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { aiProviderName, aiTasks } from "@/lib/ai-presets";
import { Alert, Button } from "@/components/ui/primitives";
import { gate } from "../integrations/scopes";
import type { SectionProps } from "../types";
import { OriginBadge } from "./origin-badge";
import { aiPaths } from "./paths";
import { aiText, type AiTextKey } from "./texts";
import {
  AI_PROVIDERS,
  ANTHROPIC_TIERS,
  KEY_NAMES,
  OPENAI_TIERS,
  type AiOrigin,
  type KeyTrace,
  type ProjectAiEffective,
  type ReadinessReason,
  type RoutingMode,
} from "./types";

export type { ProjectAiEffective } from "./types";

// The project's effective AI configuration (GET .../ai/effective): every
// value with where it comes from, and what each provider is ready for. It
// only shows what the server derived; the sections behind the links change it.

const MODE_KEYS: Record<RoutingMode, AiTextKey> = {
  unsaved: "modeUnsaved",
  custom: "modeCustom",
  preset: "modePreset",
  organization: "modeOrganization",
};
const REASON_KEYS: Record<ReadinessReason, AiTextKey> = {
  no_key: "reasonNoKey",
  project_key_unverifiable: "reasonProjectKey",
  environment_key_unverifiable: "reasonEnvironmentKey",
  connection_not_checked: "reasonNotChecked",
  connection_failed: "reasonFailed",
  connection_disabled: "reasonDisabled",
  no_text_route: "reasonNoTextRoute",
  text_not_ready: "reasonTextNotReady",
};
const KEY_LABELS: Record<(typeof KEY_NAMES)[number], AiTextKey> = {
  openai: "keyOpenAi",
  image: "keyImage",
  anthropic: "keyClaude",
};
const FALLBACK_KEYS: Record<string, AiTextKey> = {
  none: "fallbackNone",
  openai: "fallbackOpenAi",
};

// A value from a newer API than this build shows as itself (phase 3 rule).
const known = <K extends string>(table: Record<K, AiTextKey>, value: string) =>
  Object.hasOwn(table, value) ? table[value as K] : undefined;
const provider = (value: string) =>
  Object.hasOwn(aiProviderName, value)
    ? aiProviderName[value as keyof typeof aiProviderName]
    : value;

/**
 * Whether the project's own fields are in force: custom settings, or a saved
 * preset or standard the runtime does not apply (ORBIT_AI_DEFAULTS off).
 * Then a project origin is the setting itself, not an exception.
 */
const ownSettingsApply = (data: ProjectAiEffective) =>
  data.routingMode === "custom" ||
  (!data.routingApplied &&
    (data.routingMode === "preset" || data.routingMode === "organization"));

/** A readiness mark; the state is also text, so it is read out ("Key checked: no"). */
function Mark({
  ok,
  label,
  locale,
}: {
  ok: boolean;
  label: string;
  locale: Locale;
}) {
  return (
    <span className={`badge badge-${ok ? "success" : "neutral"}`} data-ok={ok}>
      {/* A glyph, not an icon: the global svg size does not fit a badge. */}
      <span aria-hidden="true">{ok ? "✓ " : "– "}</span>
      {label}
      <span className="sr-only">
        : {aiText(locale)(ok ? "markYes" : "markNo")}
      </span>
    </span>
  );
}

export function EffectiveAiView({
  data,
  locale,
  hrefOf,
}: {
  data: ProjectAiEffective;
  locale: Locale;
  hrefOf(area: string, ...rest: string[]): string;
}) {
  const t = aiText(locale);
  const own = ownSettingsApply(data);
  const mode = known(MODE_KEYS, data.routingMode);
  const reason = (value: string) => {
    const key = known(REASON_KEYS, value);
    return key ? t(key) : value;
  };
  const keyLabel = (name: string) => {
    const key = known(KEY_LABELS, name);
    return key ? t(key) : name;
  };
  const parts = [
    ...(
      [
        ["models", "partModels"],
        ["routes", "partRoutes"],
        ["prices", "partPrices"],
        ["providerBudgets", "partBudgets"],
      ] as const
    ).flatMap(([field, key]) => (data.exceptions[field] ? [t(key)] : [])),
    ...(data.exceptions.keys.length > 0
      ? [`${t("partKeys")} (${data.exceptions.keys.map(keyLabel).join(", ")})`]
      : []),
  ];

  const rows: Array<{
    id: string;
    label: string;
    value: ReactNode;
    origin: AiOrigin | null;
    /**
     * The row is a part the API lists in `exceptions` (P4-R7). Other rows
     * may still come from the project: a saved row always defines the
     * fallback, for example, without that being a departure.
     */
    listed?: boolean;
    /** A sentence across the row instead of a value. */
    note?: true;
  }> = [];
  const text = (value: string | null) => value ?? t("notSet");
  rows.push({
    id: "default-provider",
    label: t("defaultProvider"),
    value: data.defaultProvider.effective
      ? provider(data.defaultProvider.effective)
      : t("notSet"),
    origin: data.defaultProvider.origin,
  });
  for (const tier of OPENAI_TIERS) {
    const value = data.tiers.openai[tier];
    rows.push({
      id: `openai-${tier}`,
      label: `${t("tierOpenAi")}: ${tier}`,
      value: text(value?.effective ?? null),
      origin: value?.origin ?? null,
    });
  }
  for (const tier of ANTHROPIC_TIERS) {
    const value = data.tiers.anthropic[tier];
    rows.push({
      id: `anthropic-${tier}`,
      label: `${t("tierClaude")}: ${tier}`,
      value: text(value?.effective ?? null),
      origin: value?.origin ?? null,
    });
  }
  // Explicit routes in the order of the task list, then task classes this
  // build does not know yet, by their id.
  const taskIds = [
    ...aiTasks
      .map((task) => task.id as string)
      .filter((id) => id in data.taskRoutes),
    ...Object.keys(data.taskRoutes)
      .filter((id) => !aiTasks.some((task) => task.id === id))
      .sort(),
  ];
  for (const id of taskIds) {
    const route = data.taskRoutes[id]!;
    if (!route.explicit) continue;
    const task = aiTasks.find((entry) => entry.id === id);
    const effective = route.effective;
    rows.push({
      id: `route-${id}`,
      label: task ? task[locale === "de" ? "de" : "en"] : id,
      value:
        "error" in effective
          ? effective.error
          : `${effective.model}${effective.reasoningEffort ? ` · ${effective.reasoningEffort}` : ""}`,
      origin: route.origin,
      listed: data.exceptions.routes,
    });
  }
  rows.push({
    id: "other-tasks",
    label: t("otherTasksTier"),
    value: null,
    origin: null,
    note: true,
  });
  const fallback = data.fallback.effective;
  const fallbackKey =
    fallback === null ? undefined : known(FALLBACK_KEYS, fallback);
  rows.push({
    id: "fallback",
    label: t("fallback"),
    value:
      fallback === null ? t("notSet") : fallbackKey ? t(fallbackKey) : fallback,
    origin: data.fallback.origin,
  });
  rows.push({
    id: "image-model",
    label: t("imageModel"),
    value: text(data.imageModel.effective),
    origin: data.imageModel.origin,
  });
  const keyValue = (key: KeyTrace) => {
    if (!key.effective) return t("notSet");
    if (!key.connection) return t("readyStored");
    const { label, status, disabled } = key.connection;
    const state = disabled
      ? t("reasonDisabled")
      : status === "read_verified" || status === "write_verified"
        ? t("readyVerified")
        : status === "failed"
          ? t("reasonFailed")
          : status === "configured"
            ? t("reasonNotChecked")
            : status;
    return (
      <>
        <strong>{label}</strong> <span>{state}</span>
      </>
    );
  };
  for (const name of KEY_NAMES) {
    const key = data.keys[name];
    if (!key) continue;
    rows.push({
      id: `key-${name}`,
      label: keyLabel(name),
      value: keyValue(key),
      origin: key.origin,
      listed: data.exceptions.keys.includes(name),
    });
  }
  for (const name of AI_PROVIDERS) {
    const budget = data.providerBudgets[name];
    rows.push({
      id: `budget-${name}`,
      label: `${t("budgetOf")} ${provider(name)}`,
      value: budget?.effective
        ? `${usd(budget.effective.monthlyMicros)} ${t("perMonth")}`
        : t("notSet"),
      origin: budget?.origin ?? null,
      listed: data.exceptions.providerBudgets,
    });
  }
  // "Every value is inherited" holds only when no value comes from the
  // project either; otherwise the rows say where each comes from.
  const exceptionsLine =
    parts.length > 0
      ? `${t("exceptionsList")} ${parts.join(", ")}`
      : rows.some((row) => row.origin === "project")
        ? null
        : t("exceptionsNone");

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p>{mode ? t(mode) : data.routingMode}</p>
            {data.routingMode === "organization" &&
            data.standardSource === "system" ? (
              <p>{t("standardFromSystem")}</p>
            ) : null}
          </div>
        </div>
        {!data.routingApplied &&
        (data.routingMode === "preset" ||
          data.routingMode === "organization") ? (
          <Alert kind="info">{t("routingOff")}</Alert>
        ) : null}
        {exceptionsLine ? <p className="panel-note">{exceptionsLine}</p> : null}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t("readinessTitle")}</h3>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table-plain-head">
            <tbody>
              {AI_PROVIDERS.map((name) => {
                const ready = data.readiness[name];
                if (!ready) return null;
                return (
                  <tr key={name}>
                    <th scope="row">{provider(name)}</th>
                    <td>
                      <Mark
                        ok={ready.stored}
                        label={t("readyStored")}
                        locale={locale}
                      />{" "}
                      <Mark
                        ok={ready.verified}
                        label={t("readyVerified")}
                        locale={locale}
                      />{" "}
                      <Mark
                        ok={ready.ready}
                        label={t("readyReady")}
                        locale={locale}
                      />
                    </td>
                    <td>{ready.reasons.map(reason).join(" ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t("valuesTitle")}</h3>
          </div>
          <div className="page-actions">
            <Button asChild variant="outline">
              <Link href={hrefOf("ai", "models")}>{t("changeModels")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={hrefOf("ai", "providers")}>{t("changeKeys")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={hrefOf("ai", "budget")}>{t("changeBudgets")}</Link>
            </Button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table-plain-head">
            <tbody>
              {rows.map((row) =>
                row.note ? (
                  <tr key={row.id}>
                    <td colSpan={3}>{row.label}</td>
                  </tr>
                ) : (
                  <tr key={row.id}>
                    <th scope="row">{row.label}</th>
                    <td>{row.value}</td>
                    <td>
                      <OriginBadge
                        origin={row.origin}
                        exception={
                          row.origin === "project" &&
                          row.listed === true &&
                          !own
                        }
                        locale={locale}
                      />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** The overview section: loads the effective view of the scope's project. */
export function EffectiveAiSection({ scope, locale, hrefOf }: SectionProps) {
  const path = aiPaths(scope).effective ?? null;
  const effective = useResource<ProjectAiEffective>(path);
  const waiting = gate([effective]);
  if (waiting) return waiting;
  return (
    <EffectiveAiView data={effective.data!} locale={locale} hrefOf={hrefOf} />
  );
}
