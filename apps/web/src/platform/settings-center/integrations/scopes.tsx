"use client";
import { useContext, type ReactNode } from "react";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Badge, Loading } from "@/components/ui/primitives";
import { at } from "@/platform/administration/texts";
import { ShellContext } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { integrationSectionId } from "../registry";
import type {
  ManageScope,
  ManagementCapabilities,
  ScopeKind,
  SectionProps,
} from "../types";
import { catalogGroups, CatalogView, centralPath, inScope, scopesOf, storageOf } from "./catalog";
import { integrationPaths } from "./paths";
import { StateBadge } from "./state";
import { hasOwnStep, setupOffers } from "./steps";
import { integrationText, mcpSwitchLabel, type IntegrationTextKey } from "./texts";
import {
  INTEGRATION_CATEGORIES,
  type CardRecord,
  type CatalogEntry,
  type EnvironmentStatus,
  type IntegrationAuthType,
  type IntegrationCategory,
  type IntegrationState,
  type ManageNote,
  type OrganizationIntegrations,
  type ProjectIntegration,
  type ProjectIntegrationsAnswer,
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
 * `omitted` are catalog ids the member cannot use here (the project answer's
 * `unavailable`): they get no card at all, neither in a group nor as
 * switched off, so no card says "Not set up" for what the member cannot see.
 */
export function scopeCatalog(
  entries: readonly CatalogEntry[],
  scope: ScopeKind,
  records: Records,
  omitted: readonly string[] = [],
): { groups: ReturnType<typeof catalogGroups>; unavailable: CatalogEntry[] } {
  const listed = entries.filter((e) => !omitted.includes(e.id));
  const groups = catalogGroups(listed, scope).map((g) => ({
    ...g,
    entries: [...g.entries],
  }));
  const unavailable = listed.filter((e) => !e.available && inScope(e, scope));
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
 * The section that manages a card's integration, or null (the card then says
 * it is managed in its module). A link only ever leads to a page that can
 * manage the entry: a shown module's section that names it; in a project the
 * Drive section, or the Connectors page for what that page renders (the
 * platform's own project connections and the providers the shown modules
 * contribute to it, `connectorProviders`); in an organization or the system
 * the central connections of that level.
 */
export function manageHrefOf(
  entry: CatalogEntry,
  ctx: {
    scope: ManageScope;
    hrefOf(area: string, ...rest: string[]): string;
    moduleSections: ReadonlyArray<{ id: string; providers?: readonly string[] }>;
    /** Provider ids the Connectors page shows from the modules (shell.connectors.providers). */
    connectorProviders: readonly string[];
  },
): string | null {
  const owner = ctx.moduleSections.find((s) => s.providers?.includes(entry.id));
  if (owner) return ctx.hrefOf("integrations", ...owner.id.split("/"));
  // Its page stays in the Knowledge module until phase 5.
  if (entry.id === "knowledge_github") return null;
  const connections = () => ctx.hrefOf("integrations", "connections");
  const storage = storageOf(entry);
  const scopes = scopesOf(entry);
  switch (ctx.scope.kind) {
    case "project":
      if (entry.id === "google_drive") return ctx.hrefOf("integrations", "google-drive");
      // The Connectors page lists the project's own connections and the
      // granted ones with their bind action.
      if (!storage.includes("project")) return null;
      return entry.owner === "platform" || ctx.connectorProviders.includes(entry.id)
        ? connections()
        : null;
    // The central connections pages exist only where the installation can
    // use the central path (ORBIT_CONNECTIONS, the cutover).
    case "organization":
      return centralPath(entry) && scopes.includes("workspace") ? connections() : null;
    case "system":
      return centralPath(entry) && scopes.includes("system") ? connections() : null;
    default:
      return null;
  }
}

type ManageContext = Parameters<typeof manageHrefOf>[1];

/**
 * Why a card has no Manage link, or null when it has one. Computed from
 * manageHrefOf so the link and the note cannot disagree (ledger P3-R26 V1):
 * the server environment sets it; a usable central connection another scope
 * manages (central-only in a project, a provider without system scope in the
 * system) is the organization's; everything else is owned by a module with
 * no section here.
 */
export function manageNote(entry: CatalogEntry, ctx: ManageContext): ManageNote | null {
  if (manageHrefOf(entry, ctx) !== null) return null;
  const storage = storageOf(entry);
  if (storage.includes("environment")) return "server";
  const central = centralPath(entry);
  if (ctx.scope.kind === "project" && central && !storage.includes("project"))
    return "organization";
  if (ctx.scope.kind === "system" && central && !scopesOf(entry).includes("system"))
    return "organization";
  return "module";
}

/**
 * The guided setup of a card: only for what the scope's setup offers, and
 * only for a member with a step of their own there (a viewer gets none). The
 * setup page must also have a place to act: its one link to the section that
 * edits the entry, which is manageHrefOf (ledger P3-R26 V6, owner decision of
 * 2026-11-11). The setup address itself stays open to every member of the
 * scope. `unavailable`: the project answer's ids the member cannot use.
 */
export function setupHrefOf(
  entry: CatalogEntry,
  ctx: ManageContext & {
    entries: readonly CatalogEntry[];
    caps: ManagementCapabilities | null | undefined;
    unavailable?: readonly string[];
  },
): string | null {
  const offered = setupOffers(ctx.entries, ctx.scope.kind, ctx.unavailable).some(
    (e) => e.id === entry.id,
  );
  const actionable = manageHrefOf(entry, ctx) !== null;
  // hrefOf encodes every segment (manageHref).
  return offered && actionable && hasOwnStep(entry, ctx.scope, ctx.caps)
    ? ctx.hrefOf("integrations", "setup", entry.id)
    : null;
}

type EnvironmentBadge = { text: string; tone: "success" | "neutral" | "danger" };

/**
 * The rows of the environment panel; a missing part reads as off. `value` is
 * the row as one line; `badges` are its states (empty for a list of names).
 */
export function environmentRows(
  environment: EnvironmentStatus,
  locale: Locale,
): Array<{ key: string; label: string; value: string; badges: EnvironmentBadge[] }> {
  const text = integrationText(locale);
  const set = (value: boolean | undefined, name?: string): EnvironmentBadge => {
    const word = text(value ? "configured" : "missing");
    return { text: name ? `${name}: ${word}` : word, tone: value ? "success" : "neutral" };
  };
  const list = (values: readonly string[]) =>
    values.length ? values.join(", ") : text("none");
  const mcp = Object.entries(environment.mcp ?? {})
    .filter(([, on]) => on === true)
    .map(([name]) => mcpSwitchLabel(name, locale));
  const redis = environment.redis;
  // Only configured but not reachable needs attention; unset is just missing.
  const reach: EnvironmentBadge = {
    text: text(redis?.reachable ? "reachable" : "unreachable"),
    tone: redis?.reachable ? "success" : redis?.configured ? "danger" : "neutral",
  };
  const rows: Array<[string, EnvironmentBadge[] | string]> = [
    ["envRedis", [set(redis?.configured), reach]],
    ["envFiles", [set(environment.files?.configured)]],
    ["envDriveApp", [set(environment.googleDriveApp?.configured)]],
    [
      "envAiKeys",
      [
        set(environment.aiFallbackKeys?.openai, "OpenAI"),
        set(environment.aiFallbackKeys?.anthropic, "Anthropic"),
      ],
    ],
    ["envKeyRing", [set(environment.credentialKeys?.ring)]],
    ["envMcp", list(mcp)],
    ["envCutover", list(environment.connectionsCutover ?? [])],
  ];
  return rows.map(([key, parts]) => ({
    key,
    label: text(key as IntegrationTextKey),
    value: typeof parts === "string" ? parts : parts.map((b) => b.text).join(" · "),
    badges: typeof parts === "string" ? [] : parts,
  }));
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
    <section className="panel integration-env-panel">
      <h3>{text("environmentTitle")}</h3>
      <p>{text("environmentBody")}</p>
      <dl className="integration-env">
        {environmentRows(environment, locale).map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>
              {row.badges.length === 0
                ? row.value
                : row.badges.map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
            </dd>
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
    <section className="integration-projects">
      <h3>{text("projectsTitle")}</h3>
      {projects.length === 0 ? <p>{text("none")}</p> : null}
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
  unavailable = [],
  moduleSections = [],
  connectorProviders = [],
  hrefOf,
  caps,
  extra,
  locale,
}: {
  scope: ManageScope;
  entries: readonly CatalogEntry[];
  records: Records;
  /** Catalog ids the member cannot use here; no card for them. */
  unavailable?: readonly string[];
  moduleSections?: ReadonlyArray<{ id: string; providers?: readonly string[] }>;
  connectorProviders?: readonly string[];
  hrefOf: SectionProps["hrefOf"];
  caps: SectionProps["caps"];
  extra?: ReactNode;
  locale: Locale;
}) {
  const { groups, unavailable: switchedOff } = scopeCatalog(entries, scope.kind, records, unavailable);
  const manage = { scope, hrefOf, moduleSections, connectorProviders };
  return (
    <CatalogView
      groups={groups}
      unavailable={switchedOff}
      recordsOf={(id) => records.get(id) ?? []}
      manageHrefOf={(entry) => manageHrefOf(entry, manage)}
      manageNoteOf={(entry) => manageNote(entry, manage)}
      setupHrefOf={(entry) => setupHrefOf(entry, { ...manage, entries, caps, unavailable })}
      extra={extra}
      locale={locale}
    />
  );
}

export function SystemCatalog({ scope, locale, hrefOf, caps }: SectionProps) {
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
      caps={caps}
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

export function OrganizationCatalog({ scope, locale, hrefOf, caps }: SectionProps) {
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
        caps={caps}
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

export function ProjectCatalog({ scope, locale, hrefOf, caps }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const records = useResource<ProjectIntegrationsAnswer>(paths.records);
  // The integration sections of the modules shown for the project.
  const shell = useContext(ShellContext);
  const moduleSections = (shell?.integrations ?? []).map((c) => ({
    id: integrationSectionId(c),
    providers: c.providers,
  }));
  // The same source the Connectors page lists its module providers from.
  const connectorProviders = (shell?.connectors?.providers ?? []).map((p) => p.id);
  const waiting = gate([catalog, records]);
  if (waiting) return waiting;
  return (
    <ScopeCatalogView
      scope={scope}
      entries={catalog.data!.items}
      records={projectRecords(records.data!.items)}
      unavailable={records.data!.unavailable ?? []}
      moduleSections={moduleSections}
      connectorProviders={connectorProviders}
      hrefOf={hrefOf}
      caps={caps}
      locale={locale}
    />
  );
}
