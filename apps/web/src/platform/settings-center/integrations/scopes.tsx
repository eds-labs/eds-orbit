"use client";
import { useContext, type ReactNode } from "react";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Loading } from "@/components/ui/primitives";
import { at } from "@/platform/administration/texts";
import { ShellContext } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { integrationSectionId } from "../registry";
import type { ManageScope, ScopeKind, SectionProps } from "../types";
import { catalogGroups, CatalogView, inScope } from "./catalog";
import { integrationPaths } from "./paths";
import { StateBadge } from "./state";
import { integrationText } from "./texts";
import {
  INTEGRATION_CATEGORIES,
  type CardRecord,
  type CatalogEntry,
  type EnvironmentStatus,
  type IntegrationAuthType,
  type IntegrationCategory,
  type IntegrationState,
  type OrganizationIntegrations,
  type ProjectIntegration,
} from "./types";

// The catalog section of the system, organization and project scope: thin
// containers that load the answers, around pure functions that turn them into
// what CatalogView shows.

/** Label and description of the catalog section in every scope. */
export const CATALOG_SECTION = {
  label: { en: "All integrations", de: "Alle Integrationen" },
  description: {
    en: "Every integration Orbit has code for, with its state here.",
    de: "Jede Integration, für die Orbit Code hat, mit ihrem Zustand hier.",
  },
} as const;

/** The fields of GET /admin/connections items the catalog reads. */
export type AdminConnection = {
  id: string;
  provider: string;
  label: string;
  state: IntegrationState;
  checkedAt: string | null;
};

type Records = ReadonlyMap<string, readonly CardRecord[]>;

function byProvider(
  items: ReadonlyArray<{ provider: string; record: CardRecord }>,
): Map<string, CardRecord[]> {
  const map = new Map<string, CardRecord[]>();
  for (const { provider, record } of items) {
    const list = map.get(provider);
    if (list) list.push(record);
    else map.set(provider, [record]);
  }
  return map;
}

/** System scope: one record per connection, by provider. */
export function systemRecords(
  connections: readonly AdminConnection[],
): Map<string, CardRecord[]> {
  return byProvider(
    connections.map((c) => ({
      provider: c.provider,
      record: { key: c.id, label: c.label, state: c.state, checkedAt: c.checkedAt },
    })),
  );
}

/** Project scope: one record per integration; a mailbox shows its mail server. */
export function projectRecords(
  items: readonly ProjectIntegration[],
): Map<string, CardRecord[]> {
  return byProvider(
    items.map((i) => ({
      provider: i.provider,
      record: {
        key: i.id,
        label: i.label,
        state: i.state,
        checkedAt: i.checkedAt,
        ...(i.provider === "email" && i.group ? { detail: i.group } : {}),
      },
    })),
  );
}

/** Organization scope: each connection with the projects that use it. */
export function organizationRecords(
  usage: OrganizationIntegrations,
  locale: Locale,
): Map<string, CardRecord[]> {
  const text = integrationText(locale);
  return byProvider(
    usage.connections.map((c) => {
      const projects = (c.projects ?? []).map(
        (p) => `${p.name} (${text(p.bound ? "bound" : "grantedNotBound")})`,
      );
      return {
        provider: c.provider,
        record: {
          key: c.id,
          label: c.label,
          state: c.state,
          checkedAt: c.checkedAt,
          detail: `${text("usedBy")}: ${projects.length ? projects.join(", ") : text("none")}`,
        },
      };
    }),
  );
}

const categoryRank = (category: string): number => {
  const index = (INTEGRATION_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? INTEGRATION_CATEGORIES.indexOf("other") : index;
};

/**
 * The scope's catalog groups and switched-off entries. A record whose
 * provider has no card in the scope still gets one, so nothing set up
 * vanishes: the catalog entry if the provider is known (shown although the
 * scope's catalog leaves it out), else a card named after the record.
 */
export function scopeCatalog(
  entries: readonly CatalogEntry[],
  scope: ScopeKind,
  records: Records,
): { groups: ReturnType<typeof catalogGroups>; unavailable: CatalogEntry[] } {
  const groups = catalogGroups(entries, scope).map((g) => ({
    ...g,
    entries: [...g.entries],
  }));
  const unavailable = entries.filter((e) => !e.available && inScope(e, scope));
  const shown = new Set([
    ...groups.flatMap((g) => g.entries.map((e) => e.id)),
    ...unavailable.map((e) => e.id),
  ]);
  for (const [provider, list] of records) {
    if (shown.has(provider) || list.length === 0) continue;
    shown.add(provider);
    const known = entries.find((e) => e.id === provider);
    const label = list[0]!.label;
    const entry: CatalogEntry = known
      ? { ...known, available: true }
      : {
          id: provider,
          label: { en: label, de: label },
          category: "other",
          // Unknown: an empty value renders as nothing on the card.
          authType: "" as IntegrationAuthType,
          scopes: [],
          checkable: false,
          storage: [],
          available: true,
          owner: "platform",
        };
    const category = INTEGRATION_CATEGORIES[categoryRank(entry.category)]!;
    const group = groups.find((g) => g.category === category);
    if (group) group.entries.push(entry);
    else groups.push({ category: category as IntegrationCategory, entries: [entry] });
  }
  groups.sort((x, y) => categoryRank(x.category) - categoryRank(y.category));
  return { groups, unavailable };
}

/**
 * The section that manages a card's integration: a module section that
 * names it, else the platform's section by where it is stored; null where
 * nothing in this scope manages it.
 */
export function manageHrefOf(
  entry: CatalogEntry,
  ctx: {
    scope: ManageScope;
    hrefOf(area: string, ...rest: string[]): string;
    moduleSections: ReadonlyArray<{ id: string; providers?: readonly string[] }>;
  },
): string | null {
  const owner = ctx.moduleSections.find((s) => s.providers?.includes(entry.id));
  if (owner) return ctx.hrefOf("integrations", ...owner.id.split("/"));
  // Its page stays in the Knowledge module until phase 5.
  if (entry.id === "knowledge_github") return null;
  switch (ctx.scope.kind) {
    case "project":
      if (entry.id === "google_drive") return ctx.hrefOf("integrations", "google-drive");
      return entry.storage.includes("project")
        ? ctx.hrefOf("integrations", "connections")
        : null;
    case "organization":
    case "system":
      return entry.storage.includes("central")
        ? ctx.hrefOf("integrations", "connections")
        : null;
    default:
      return null;
  }
}

/** The guided setup (Task 10); none yet. */
const setupHrefOf = (): string | null => null;

/** The rows of the environment panel; a missing part reads as off. */
export function environmentRows(
  environment: EnvironmentStatus,
  locale: Locale,
): Array<{ key: string; label: string; value: string }> {
  const text = integrationText(locale);
  const set = (value: boolean | undefined) => text(value ? "configured" : "missing");
  const list = (values: readonly string[]) =>
    values.length ? values.join(", ") : text("none");
  const mcp = Object.entries(environment.mcp ?? {})
    .filter(([, on]) => on === true)
    .map(([name]) => name);
  const rows = [
    [
      "envRedis",
      `${set(environment.redis?.configured)} · ${text(environment.redis?.reachable ? "reachable" : "unreachable")}`,
    ],
    ["envFiles", set(environment.files?.configured)],
    ["envDriveApp", set(environment.googleDriveApp?.configured)],
    [
      "envAiKeys",
      `OpenAI: ${set(environment.aiFallbackKeys?.openai)} · Anthropic: ${set(environment.aiFallbackKeys?.anthropic)}`,
    ],
    ["envKeyRing", set(environment.credentialKeys?.ring)],
    ["envMcp", list(mcp)],
    ["envCutover", list(environment.connectionsCutover ?? [])],
  ] as const;
  return rows.map(([key, value]) => ({ key, label: text(key), value }));
}

export function EnvironmentPanel({
  environment,
  locale,
}: {
  environment: EnvironmentStatus;
  locale: Locale;
}) {
  const text = integrationText(locale);
  return (
    <section className="panel">
      <h2>{text("environmentTitle")}</h2>
      <p>{text("environmentBody")}</p>
      <dl>
        {environmentRows(environment, locale).map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The organization's projects, one table each, below the catalog. */
export function OrganizationProjects({
  projects,
  catalog,
  locale,
}: {
  projects: OrganizationIntegrations["projects"];
  catalog: readonly CatalogEntry[];
  locale: Locale;
}) {
  const text = integrationText(locale);
  const lastCheck = (value: string | null) => {
    const shown = value ? at(value, locale) : "—";
    return shown === "—" ? text("neverChecked") : shown;
  };
  return (
    <section>
      <h2>{text("projectsTitle")}</h2>
      {projects.map((project) => (
        <table key={project.id}>
          <caption>{project.name}</caption>
          <tbody>
            {project.integrations.length === 0 ? (
              <tr>
                <td>{text("none")}</td>
              </tr>
            ) : (
              project.integrations.map((i) => {
                const known = catalog.find((e) => e.id === i.provider);
                const provider = known ? known.label[locale] || known.label.en : i.label;
                return (
                  <tr key={i.id}>
                    <th scope="row">
                      {provider}
                      {provider !== i.label ? <span> {i.label}</span> : null}
                    </th>
                    <td>
                      <StateBadge state={i.state} locale={locale} />
                    </td>
                    <td>
                      {text("lastCheck")}: {lastCheck(i.checkedAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      ))}
    </section>
  );
}

type Loaded = {
  data: unknown;
  error: Error | null;
  loading: boolean;
  refresh(): void;
};

/**
 * Loading until every answer is in; any failure shows the error with a retry
 * of every failed request instead of a catalog built from part of them.
 */
export function gate(resources: readonly Loaded[]): ReactNode | null {
  const failed = resources.filter((r) => r.error && !r.data);
  if (failed.length > 0)
    return (
      <ResourceError
        error={failed[0]!.error}
        retry={() => failed.forEach((r) => r.refresh())}
      />
    );
  if (resources.some((r) => !r.data)) return <Loading />;
  return null;
}

type CatalogAnswer = { items: CatalogEntry[] };

function ScopeCatalogView({
  scope,
  entries,
  records,
  moduleSections = [],
  hrefOf,
  extra,
  locale,
}: {
  scope: ManageScope;
  entries: readonly CatalogEntry[];
  records: Records;
  moduleSections?: ReadonlyArray<{ id: string; providers?: readonly string[] }>;
  hrefOf: SectionProps["hrefOf"];
  extra?: ReactNode;
  locale: Locale;
}) {
  const { groups, unavailable } = scopeCatalog(entries, scope.kind, records);
  return (
    <CatalogView
      groups={groups}
      unavailable={unavailable}
      recordsOf={(id) => records.get(id) ?? []}
      manageHrefOf={(entry) => manageHrefOf(entry, { scope, hrefOf, moduleSections })}
      setupHrefOf={setupHrefOf}
      extra={extra}
      locale={locale}
    />
  );
}

export function SystemCatalog({ scope, locale, hrefOf }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const connections = useResource<{ items: AdminConnection[] }>(paths.connections);
  const overview = useResource<{ system: { environment: EnvironmentStatus } }>(
    paths.overview,
  );
  const waiting = gate([catalog, connections, overview]);
  if (waiting) return waiting;
  return (
    <ScopeCatalogView
      scope={scope}
      entries={catalog.data!.items}
      records={systemRecords(connections.data!.items)}
      hrefOf={hrefOf}
      extra={
        <EnvironmentPanel
          environment={overview.data!.system.environment}
          locale={locale}
        />
      }
      locale={locale}
    />
  );
}

export function OrganizationCatalog({ scope, locale, hrefOf }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const usage = useResource<OrganizationIntegrations>(paths.records);
  const waiting = gate([catalog, usage]);
  if (waiting) return waiting;
  return (
    <>
      <ScopeCatalogView
        scope={scope}
        entries={catalog.data!.items}
        records={organizationRecords(usage.data!, locale)}
        hrefOf={hrefOf}
        locale={locale}
      />
      <OrganizationProjects
        projects={usage.data!.projects}
        catalog={catalog.data!.items}
        locale={locale}
      />
    </>
  );
}

export function ProjectCatalog({ scope, locale, hrefOf }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const records = useResource<{ items: ProjectIntegration[] }>(paths.records);
  // The integration sections of the modules shown for the project.
  const shell = useContext(ShellContext);
  const moduleSections = (shell?.integrations ?? []).map((c) => ({
    id: integrationSectionId(c),
    providers: c.providers,
  }));
  const waiting = gate([catalog, records]);
  if (waiting) return waiting;
  return (
    <ScopeCatalogView
      scope={scope}
      entries={catalog.data!.items}
      records={projectRecords(records.data!.items)}
      moduleSections={moduleSections}
      hrefOf={hrefOf}
      locale={locale}
    />
  );
}
