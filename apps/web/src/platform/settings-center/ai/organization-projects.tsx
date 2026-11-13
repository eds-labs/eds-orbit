"use client";
import Link from "next/link";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge } from "@/components/ui/primitives";
import { gate } from "../integrations/scopes";
import { manageHref } from "../routes";
import type { SectionProps } from "../types";
import { aiPaths } from "./paths";
import { affectedText, aiText, type AiTextKey } from "./texts";
import type {
  OrganizationAiProjects,
  RoutingMode,
  SpendingAuthorityState,
} from "./types";

export type { OrganizationAiProjects } from "./types";

// Which projects of the organization follow its AI settings and which set
// their own (GET .../ai/projects), read-only. Each project links to its own
// AI area, where it is changed.

type Entry = OrganizationAiProjects["projects"][number];

/** Who a central change reaches; `own` is a preset or custom settings. A mode this build does not know counts only in the total. */
export function affectedCounts(data: OrganizationAiProjects): {
  total: number;
  following: number;
  unsaved: number;
  own: number;
} {
  const mode = (m: string) =>
    data.projects.filter((p) => p.routingMode === m).length;
  return {
    total: data.projects.length,
    following: mode("organization"),
    unsaved: mode("unsaved"),
    own: mode("preset") + mode("custom"),
  };
}

const CHOICE_KEYS: Record<RoutingMode, AiTextKey> = {
  unsaved: "choiceUnsaved",
  custom: "choiceCustom",
  preset: "choicePreset",
  organization: "choiceOrganization",
};

const AUTHORITY_KEYS: Record<SpendingAuthorityState, AiTextKey> = {
  none: "authorityNone",
  active: "authorityActive",
  expired: "authorityExpired",
  off: "authorityOff",
  invalid: "authorityInvalid",
};

const AUTHORITY_TONES: Record<SpendingAuthorityState, "neutral" | "success" | "warning" | "danger"> = {
  none: "neutral",
  active: "success",
  expired: "warning",
  off: "neutral",
  invalid: "danger",
};

const KEY_LABELS: Array<[keyof Entry["ownKeys"], AiTextKey]> = [
  ["openai", "keyOpenAi"],
  ["image", "keyImage"],
  ["anthropic", "keyClaude"],
];

const OVERRIDE_LABELS: Array<[keyof Entry["overrides"], AiTextKey]> = [
  ["models", "partModels"],
  ["routes", "partRoutes"],
  ["prices", "partPrices"],
  ["providerBudgets", "partBudgets"],
];

/**
 * The words of a known value, else the value itself: a deployed API can be
 * newer than this web build.
 */
function known<T extends string>(
  keys: Record<T, AiTextKey>,
  value: string,
  t: (key: AiTextKey) => string,
): string {
  return Object.hasOwn(keys, value) ? t(keys[value as T]) : String(value);
}

export function OrganizationAiProjectsView({
  data,
  locale,
  projectHref,
}: {
  data: OrganizationAiProjects;
  locale: Locale;
  projectHref(projectId: string): string;
}) {
  const t = aiText(locale);
  const list = (pairs: Array<[string, AiTextKey]>, set: Record<string, boolean>) => {
    const names = pairs.filter(([field]) => set[field]).map(([, key]) => t(key));
    return names.length > 0 ? names.join(", ") : t("none");
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p>{t("projectsIntro")}</p>
        </div>
      </div>
      {/* The runtime skips presets and the standard, so the choices below are saved ones. */}
      {data.routingApplied ? null : <Alert kind="info">{t("defaultsOff")}</Alert>}
      {data.unreadable > 0 ? (
        <Alert kind="warning">
          {affectedText("projectsUnreadable", { count: data.unreadable }, locale)}
        </Alert>
      ) : null}
      {data.projects.length === 0 ? (
        <p className="panel-note">{t("projectsEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="ai-projects-table">
            <thead>
              <tr>
                <th scope="col">{t("colProject")}</th>
                <th scope="col">{t("colChoice")}</th>
                <th scope="col">{t("colKeys")}</th>
                <th scope="col">{t("colOverrides")}</th>
                <th scope="col">{t("colAuthority")}</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.projectId}>
                  <th scope="row">
                    <Link href={projectHref(p.projectId)}>{p.name}</Link>
                  </th>
                  <td>{known(CHOICE_KEYS, p.routingMode, t)}</td>
                  <td>{list(KEY_LABELS, p.ownKeys)}</td>
                  <td>{list(OVERRIDE_LABELS, p.overrides)}</td>
                  <td>
                    <Badge
                      tone={
                        Object.hasOwn(AUTHORITY_TONES, p.spendingAuthority)
                          ? AUTHORITY_TONES[p.spendingAuthority]
                          : "neutral"
                      }
                    >
                      {known(AUTHORITY_KEYS, p.spendingAuthority, t)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const projectAiHref = (projectId: string) =>
  manageHref({ kind: "project", projectId }, "ai");

export function OrganizationAiProjectsSection({ scope, locale }: SectionProps) {
  const path = aiPaths(scope).projects ?? null;
  const projects = useResource<OrganizationAiProjects>(path);
  const waiting = gate([projects]);
  if (waiting) return waiting;
  return (
    <OrganizationAiProjectsView
      data={projects.data!}
      locale={locale}
      projectHref={projectAiHref}
    />
  );
}
